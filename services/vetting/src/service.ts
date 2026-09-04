import type { Address } from 'viem';
import { ChainReader, type RhcPublicClient } from '@rhc/chain';
import { createLogger, type AppConfig, type MessageBus, type UsdPriceOracle } from '@rhc/core';
import type { NewLaunchEvent, QuoteAsset, VettingFailure, VettingResult } from '@rhc/types';
import { GoPlusClient } from './goplus.js';
import { RoundTripSimulator } from './simulator.js';

const log = createLogger('vetting');

/**
 * Phase 1 vetting.
 *
 * The question is "can this be sold", not "will this pump". Everything here is a
 * disqualifier; nothing here is a reason to buy.
 *
 * Several checks are shaped by how Pons actually works rather than by generic EVM
 * heuristics, because the generic versions would answer the wrong question:
 *
 *  - Liquidity cannot be pulled from a Pons launch. Pre-graduation it sits in the curve
 *    contract, and at graduation it is swept into a permanently locked Uniswap v4
 *    position. So the meaningful check is not "is the LP locked" but "was this token
 *    actually launched by the factory we verified" — a lookalike token that was never
 *    launched by Pons has none of those guarantees.
 *  - Pons launch tokens have no owner; the deployer is metadata with no privileges. A
 *    missing `owner()` is the expected good case, and a token that *does* expose one is
 *    the anomaly worth rejecting.
 *  - Creator tax is configurable per launch and capped by the factory. An unusually high
 *    one cannot rug the liquidity, but it is a reliable tell about intent.
 */
export class VettingService {
  private readonly simulator: RoundTripSimulator;
  private readonly scanner: GoPlusClient;
  private readonly cache = new Map<string, VettingResult>();

  readonly stats = { vetted: 0, passed: 0, failed: 0, honeypots: 0, simulationUnavailable: 0 };

  constructor(
    private readonly config: AppConfig,
    client: RhcPublicClient,
    private readonly reader: ChainReader,
    private readonly oracle: UsdPriceOracle,
    private readonly factoryAddress: Address,
    private readonly bus: MessageBus,
  ) {
    this.simulator = new RoundTripSimulator(client);
    this.scanner = new GoPlusClient(config, config.secrets.goPlusApiKey);
  }

  getCached(tokenAddress: string): VettingResult | undefined {
    return this.cache.get(tokenAddress.toLowerCase());
  }

  async vet(launch: NewLaunchEvent): Promise<VettingResult> {
    const cached = this.cache.get(launch.tokenAddress);
    if (cached) return cached;

    const result = await this.runChecks(launch);

    this.cache.set(launch.tokenAddress, result);
    this.stats.vetted += 1;
    if (result.passVetting) this.stats.passed += 1;
    else this.stats.failed += 1;
    if (result.failures.includes('honeypot-sell-reverts')) this.stats.honeypots += 1;
    if (result.failures.includes('simulation-unavailable')) this.stats.simulationUnavailable += 1;

    this.bus.publish('vetting.result', result);
    return result;
  }

  private async runChecks(launch: NewLaunchEvent): Promise<VettingResult> {
    const { vetting } = this.config.bot;
    const failures: VettingFailure[] = [];
    const checksRun: string[] = [];
    const now = Date.now();

    const curveAddress = launch.curveAddress as Address;
    const tokenAddress = launch.tokenAddress as Address;

    const [curve, launchRecord, ownerInfo] = await Promise.all([
      this.reader.readCurve(curveAddress),
      this.reader.readLaunchRecord(this.factoryAddress, tokenAddress),
      this.reader.readOwner(tokenAddress),
    ]);

    const blockNumber = curve?.blockNumber ?? 0;

    const bail = (failure: VettingFailure): VettingResult => ({
      kind: 'vetting-result',
      tokenAddress: launch.tokenAddress,
      curveAddress: launch.curveAddress,
      passVetting: false,
      buyTax: 0,
      sellTax: 0,
      liquidityLocked: false,
      ownerRenounced: !ownerInfo.hasOwner,
      snipeTaxBps: 0,
      failures: [failure],
      checksRun,
      externalScanner: null,
      simulatedAtBlock: blockNumber,
      timestamp: now,
    });

    if (!curve) return bail('simulation-unavailable');
    if (curve.graduated || curve.readyToGraduate || curve.sellableTokens === 0n) {
      return bail('curve-already-closed');
    }

    // Provenance: only tokens the verified factory actually launched carry the locked-
    // liquidity and no-owner guarantees the rest of this analysis assumes.
    checksRun.push('factory-provenance');
    const launchedByVerifiedFactory = launchRecord?.exists === true;
    if (!launchedByVerifiedFactory) failures.push('liquidity-not-locked');

    checksRun.push('owner-renounced');
    const ownerRenounced = !ownerInfo.hasOwner;
    if (vetting.requireOwnerRenounced && !ownerRenounced) failures.push('owner-not-renounced');

    // Fees are read off the curve rather than assumed: `feeBps` and `creatorTaxBps` come
    // from the launch config and are not protocol constants.
    checksRun.push('fee-and-tax-read');
    const curveFeeBps = Number(curve.feeBps);
    const creatorTaxBps = Number(curve.creatorTaxBps);
    const buyTax = curveFeeBps + creatorTaxBps;
    const sellTax = curveFeeBps + creatorTaxBps;

    if (buyTax > vetting.maxBuyTaxBps) failures.push('buy-tax-too-high');
    if (sellTax > vetting.maxSellTaxBps) failures.push('sell-tax-too-high');
    if (creatorTaxBps > vetting.maxCreatorTaxBps) failures.push('creator-tax-too-high');

    // The snipe tax decays to zero within seconds. It is reported so the decision engine
    // can wait it out, and is never itself a rejection.
    checksRun.push('snipe-tax');
    const snipeTaxBps = Number(await this.reader.readSnipeTaxBps(curveAddress, ZERO_PROBE));

    const quoteIn = this.simulationSize(launch.quoteAsset);
    if (quoteIn == null) return bail('unsupported-quote-asset');

    checksRun.push('round-trip-simulation');
    const roundTrip = await this.simulator.simulate({
      curveAddress,
      tokenAddress,
      quoteAsset: launch.quoteAsset,
      quoteIn,
    });

    if (!roundTrip.ok) {
      if (roundTrip.failedLeg === 'sell' || roundTrip.failedLeg === 'approve') {
        // The signature of a honeypot: it takes the buy and refuses the exit.
        failures.push('honeypot-sell-reverts');
      } else {
        // A buy that reverts, or a simulation that could not run, tells us nothing good
        // either. Declining is the only safe reading — an unavailable check is never a
        // pass.
        failures.push('simulation-unavailable');
      }
    } else if (roundTrip.retentionBps < vetting.minRoundTripRetentionBps) {
      // Sellable, but the round trip leaks more than the configured budget once fees,
      // creator tax, and curve impact are all accounted for.
      failures.push('sell-proceeds-implausible');
    }

    let externalScanner: VettingResult['externalScanner'] = null;
    if (vetting.useExternalScanner) {
      checksRun.push('external-scanner');
      const verdict = await this.scanner.check(launch.tokenAddress);
      externalScanner = {
        provider: verdict.provider,
        available: verdict.available,
        flagged: verdict.flagged,
        raw: verdict.reasons,
      };
      if (verdict.available && verdict.flagged) {
        failures.push('external-scanner-flagged');
      } else if (!verdict.available && !vetting.failOpenOnScannerError) {
        failures.push('simulation-unavailable');
      }
    }

    const result: VettingResult = {
      kind: 'vetting-result',
      tokenAddress: launch.tokenAddress,
      curveAddress: launch.curveAddress,
      passVetting: failures.length === 0,
      buyTax,
      sellTax,
      // True in the structural sense specific to this launchpad: the curve holds the
      // quote and graduation locks the position permanently. Only meaningful once
      // factory provenance is established, which is why it is gated on it.
      liquidityLocked: launchedByVerifiedFactory,
      ownerRenounced,
      snipeTaxBps,
      failures,
      checksRun,
      externalScanner,
      simulatedAtBlock: blockNumber,
      timestamp: now,
    };

    if (!result.passVetting) {
      log.debug('token failed vetting', { token: launch.tokenAddress, failures });
    }
    return result;
  }

  /** Fixed USD notional, converted into the launch's quote asset. */
  private simulationSize(quoteAsset: QuoteAsset): bigint | null {
    const amount = this.oracle.fromUsd(this.config.bot.vetting.simulationSizeUsd, quoteAsset);
    return amount != null && amount > 0n ? amount : null;
  }
}

/**
 * Snipe tax is read against a neutral address, not the execution wallet. Exemptions are
 * held per recipient, so reading it for an exempt address would report a tax the bot
 * will not actually receive.
 */
const ZERO_PROBE: Address = '0x00000000000000000000000000000000000d1a9e';
