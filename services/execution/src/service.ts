import { encodeFunctionData, type Account, type Address, type Hash, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ChainReader,
  erc20Abi,
  fillSlippageBps,
  ponsV2CurveAbi,
  quoteBuy,
  quoteSell,
  realizablePrice,
  spotPrice,
  type CurveSnapshot,
  type RhcPublicClient,
} from '@rhc/chain';
import {
  assertLiveModePreconditions,
  createLogger,
  newId,
  type AppConfig,
  type MessageBus,
  type UsdPriceOracle,
} from '@rhc/core';
import type { EntryStage, ExitReason, Fill, LaunchPhase, Position, TradeIntent } from '@rhc/types';
import type { PortfolioLedger } from './ledger.js';

const log = createLogger('execution');

export interface ExecutionDeps {
  config: AppConfig;
  client: RhcPublicClient;
  reader: ChainReader;
  ledger: PortfolioLedger;
  oracle: UsdPriceOracle;
  bus: MessageBus;
  /** Metadata lookup so fills and positions carry a readable symbol. */
  symbolFor: (tokenAddress: string) => string;
  phaseFor: (tokenAddress: string) => LaunchPhase;
}

/**
 * The execution service. The only place in the system that knows about `mode`.
 *
 * Every step up to signing is identical in both modes: read live curve state, price the
 * trade against real reserves with the contract's own arithmetic, apply slippage limits,
 * and compute the exact fill. Only the last step branches — paper writes the computed
 * fill to the ledger, live signs and broadcasts, then records the same fill shape.
 *
 * That structure is the point. If flipping to live required different sizing or
 * different decision logic anywhere upstream, the paper results would not be evidence
 * about the live system, and the whole evaluation window would be worthless.
 */
export class ExecutionService {
  private account: Account | null = null;
  private walletClient: WalletClient | null = null;
  private readonly approvedSpenders = new Set<string>();

  readonly stats = { submitted: 0, filled: 0, rejected: 0, failed: 0 };

  constructor(private readonly deps: ExecutionDeps) {}

  get mode(): 'paper' | 'live' {
    return this.deps.config.bot.mode;
  }

  /**
   * Live mode is gated here and nowhere else. The preconditions are re-checked rather
   * than trusted from startup, so a reloaded config cannot slip past them.
   */
  async initialise(): Promise<void> {
    if (this.mode !== 'live') {
      log.info('execution service in PAPER mode: reads real mainnet state, never signs or broadcasts');
      return;
    }

    assertLiveModePreconditions(this.deps.config);

    const { createWalletClient, http } = await import('viem');
    this.account = privateKeyToAccount(this.deps.config.secrets.executionPrivateKey as `0x${string}`);
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.deps.client.chain,
      transport: http(this.deps.config.rpcHttpUrl),
    });

    const balance = await this.deps.client.getBalance({ address: this.account.address });
    log.warn('execution service in LIVE mode: transactions will be signed and broadcast', {
      wallet: this.account.address,
      nativeBalanceWei: balance.toString(),
    });

    if (balance === 0n) {
      log.warn('hot wallet holds no native balance; gas will fail. Fund it with trading capital only.');
    }
  }

  /**
   * Price an intent against live state and execute it. Returns null when the trade
   * cannot be placed at acceptable terms — a rejection, not an error.
   */
  async execute(
    intent: TradeIntent,
    context: { stage: EntryStage; reason: ExitReason | null; positionId: string | null; ladderStep: number | null },
  ): Promise<{ fill: Fill; position: Position | null } | null> {
    this.stats.submitted += 1;

    if (intent.venue !== 'curve' || !intent.curveAddress) {
      // Post-graduation routing to the Uniswap v4 pool is not implemented. Declining
      // loudly beats guessing at a swap path with real money behind it.
      log.warn('no execution route for venue; declining', { venue: intent.venue, token: intent.tokenAddress });
      this.stats.rejected += 1;
      return null;
    }

    const curveAddress = intent.curveAddress as Address;
    const snapshot = await this.deps.reader.readCurve(curveAddress);
    if (!snapshot) {
      this.stats.rejected += 1;
      return null;
    }

    return intent.side === 'buy'
      ? this.executeBuy(intent, snapshot, context)
      : this.executeSell(intent, snapshot, context);
  }

  private async executeBuy(
    intent: TradeIntent,
    snapshot: CurveSnapshot,
    context: { stage: EntryStage },
  ): Promise<{ fill: Fill; position: Position | null } | null> {
    const quoteIn = BigInt(intent.amount);
    const curveAddress = intent.curveAddress as Address;
    const recipient = this.account?.address ?? PAPER_RECIPIENT;

    if (snapshot.graduated || snapshot.readyToGraduate || snapshot.sellableTokens === 0n) {
      this.stats.rejected += 1;
      return null;
    }

    // Read the tax for the address that will actually receive the tokens; exemptions are
    // held per recipient, so any other address gives the wrong number.
    const snipeTaxBps = await this.deps.reader.readSnipeTaxBps(curveAddress, recipient);
    const quote = quoteBuy(snapshot, quoteIn, snipeTaxBps);

    if (quote.tokensOut === 0n) {
      this.stats.rejected += 1;
      return null;
    }

    const spot = spotPrice(snapshot);
    const executedPrice = (quote.spent * 10n ** 18n) / quote.tokensOut;
    const slippageBps = fillSlippageBps(spot, executedPrice, 'buy');

    if (slippageBps > intent.maxSlippageBps) {
      log.debug('buy rejected on slippage', {
        token: intent.tokenAddress,
        slippageBps: Math.round(slippageBps),
        limit: intent.maxSlippageBps,
      });
      this.stats.rejected += 1;
      return null;
    }

    // Size the on-chain floor from the achieved rate rather than the requested total:
    // a buy near the reserved allocation is clamped and refunded, and a minimum derived
    // from the full amount would revert a fill that honoured the price.
    const minTokensOut = (quote.tokensOut * BigInt(10_000 - intent.maxSlippageBps)) / 10_000n;

    let txHash: Hash | null = null;
    if (this.mode === 'live') {
      txHash = await this.broadcastBuy(intent, quoteIn, minTokensOut, recipient);
      if (!txHash) {
        this.stats.failed += 1;
        return null;
      }
    }

    const fill: Fill = {
      kind: 'fill',
      intentId: intent.intentId,
      mode: this.mode,
      side: 'buy',
      tokenAddress: intent.tokenAddress,
      venue: 'curve',
      quoteAsset: intent.quoteAsset,
      quoteAmount: quote.spent.toString(),
      tokenAmount: quote.tokensOut.toString(),
      price: executedPrice.toString(),
      slippageBps,
      feePaid: quote.feePaid.toString(),
      taxPaid: (quote.taxPaid + quote.snipeTaxPaid).toString(),
      gasCostWei: '0',
      txHash,
      blockNumber: snapshot.blockNumber,
      timestamp: Date.now(),
    };

    const position = this.deps.ledger.applyBuy({
      fill,
      curveAddress: intent.curveAddress,
      poolAddress: intent.poolAddress,
      symbol: this.deps.symbolFor(intent.tokenAddress),
      stage: context.stage,
      phase: this.deps.phaseFor(intent.tokenAddress),
    });

    this.stats.filled += 1;
    this.deps.bus.publish('trade.fill', fill);
    this.deps.bus.publish('position.update', position);

    log.info(`${this.mode.toUpperCase()} BUY`, {
      token: intent.tokenAddress,
      symbol: position.symbol,
      spent: quote.spent.toString(),
      quote: intent.quoteAsset.symbol,
      slippageBps: Math.round(slippageBps),
      clamped: quote.clamped,
      stage: context.stage,
      txHash,
    });

    return { fill, position };
  }

  private async executeSell(
    intent: TradeIntent,
    snapshot: CurveSnapshot,
    context: { reason: ExitReason | null; positionId: string | null; ladderStep: number | null },
  ): Promise<{ fill: Fill; position: Position | null } | null> {
    const tokensIn = BigInt(intent.amount);

    // Sells stop working at the sweep, before the factory reports a new phase. A quote
    // engine that gates only on `graduated` will keep offering sells that revert.
    if (snapshot.graduated || snapshot.readyToGraduate) {
      log.warn('curve closed to sells; position must exit on the graduated pool', {
        token: intent.tokenAddress,
        readyToGraduate: snapshot.readyToGraduate,
      });
      this.stats.rejected += 1;
      return null;
    }

    const quote = quoteSell(snapshot, tokensIn);
    if (quote.quoteOut === 0n) {
      this.stats.rejected += 1;
      return null;
    }

    const spot = spotPrice(snapshot);
    const executedPrice = (quote.quoteOut * 10n ** 18n) / tokensIn;
    const slippageBps = fillSlippageBps(spot, executedPrice, 'sell');
    const minQuoteOut = (quote.quoteOut * BigInt(10_000 - intent.maxSlippageBps)) / 10_000n;

    let txHash: Hash | null = null;
    if (this.mode === 'live') {
      txHash = await this.broadcastSell(intent, tokensIn, minQuoteOut);
      if (!txHash) {
        this.stats.failed += 1;
        return null;
      }
    }

    const fill: Fill = {
      kind: 'fill',
      intentId: intent.intentId,
      mode: this.mode,
      side: 'sell',
      tokenAddress: intent.tokenAddress,
      venue: 'curve',
      quoteAsset: intent.quoteAsset,
      quoteAmount: quote.quoteOut.toString(),
      tokenAmount: tokensIn.toString(),
      price: executedPrice.toString(),
      slippageBps,
      feePaid: quote.feePaid.toString(),
      taxPaid: quote.taxPaid.toString(),
      gasCostWei: '0',
      txHash,
      blockNumber: snapshot.blockNumber,
      timestamp: Date.now(),
    };

    const position = context.positionId
      ? this.deps.ledger.applySell({
          fill,
          positionId: context.positionId,
          reason: context.reason ?? 'manual',
          ladderStep: context.ladderStep,
        })
      : null;

    this.stats.filled += 1;
    this.deps.bus.publish('trade.fill', fill);
    if (position) this.deps.bus.publish('position.update', position);

    log.info(`${this.mode.toUpperCase()} SELL`, {
      token: intent.tokenAddress,
      symbol: position?.symbol,
      received: quote.quoteOut.toString(),
      quote: intent.quoteAsset.symbol,
      reason: context.reason,
      realizedPnl: position?.realizedPnlQuote,
      txHash,
    });

    return { fill, position };
  }

  /** Realisable mark for a position's remaining tokens, from live curve state. */
  async markPosition(position: Position): Promise<{ mark: bigint; spot: bigint; snapshot: CurveSnapshot } | null> {
    if (!position.curveAddress) return null;
    const snapshot = await this.deps.reader.readCurve(position.curveAddress as Address);
    if (!snapshot) return null;
    return {
      mark: realizablePrice(snapshot, BigInt(position.tokensHeld)),
      spot: spotPrice(snapshot),
      snapshot,
    };
  }

  /* ---------------- live-only paths ---------------- */

  private async broadcastBuy(
    intent: TradeIntent,
    quoteIn: bigint,
    minTokensOut: bigint,
    recipient: Address,
  ): Promise<Hash | null> {
    if (!this.walletClient || !this.account) return null;
    const curveAddress = intent.curveAddress as Address;

    try {
      if (!intent.quoteAsset.isNative) {
        await this.ensureAllowance(intent.quoteAsset.address as Address, curveAddress, quoteIn);
      }

      return await this.walletClient.sendTransaction({
        account: this.account,
        chain: this.deps.client.chain,
        to: curveAddress,
        data: encodeFunctionData({
          abi: ponsV2CurveAbi,
          functionName: 'buy',
          args: [quoteIn, minTokensOut, recipient],
        }),
        // A native-quote launch requires value to equal quoteIn exactly; any refund from
        // a clamped fill comes back in the same transaction.
        ...(intent.quoteAsset.isNative ? { value: quoteIn } : {}),
      });
    } catch (err) {
      log.error('buy broadcast failed', { token: intent.tokenAddress, err: (err as Error).message });
      return null;
    }
  }

  private async broadcastSell(intent: TradeIntent, tokensIn: bigint, minQuoteOut: bigint): Promise<Hash | null> {
    if (!this.walletClient || !this.account) return null;
    const curveAddress = intent.curveAddress as Address;

    try {
      await this.ensureAllowance(intent.tokenAddress as Address, curveAddress, tokensIn);

      return await this.walletClient.sendTransaction({
        account: this.account,
        chain: this.deps.client.chain,
        to: curveAddress,
        data: encodeFunctionData({
          abi: ponsV2CurveAbi,
          functionName: 'sell',
          args: [tokensIn, minQuoteOut, this.account.address],
        }),
      });
    } catch (err) {
      log.error('sell broadcast failed', { token: intent.tokenAddress, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Approve exactly what is needed, not an unlimited allowance.
   *
   * An infinite approval to a per-launch contract nobody has audited is a standing claim
   * on the hot wallet's balance for as long as the key lives. The extra transaction is
   * worth it.
   */
  private async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<void> {
    if (!this.walletClient || !this.account) return;

    const key = `${token}:${spender}`;
    const current = await this.deps.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.account.address, spender],
    });
    if (current >= amount) {
      this.approvedSpenders.add(key);
      return;
    }

    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.deps.client.chain,
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    });
    await this.deps.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    this.approvedSpenders.add(key);
  }

  buildIntent(params: Omit<TradeIntent, 'kind' | 'intentId' | 'timestamp'>): TradeIntent {
    return { kind: 'trade-intent', intentId: newId('int'), timestamp: Date.now(), ...params };
  }
}

/**
 * Stand-in recipient for paper mode. Never signs anything; it exists so snipe-tax reads
 * are keyed to an unexempted address, matching what an ordinary buyer would pay.
 */
const PAPER_RECIPIENT: Address = '0x00000000000000000000000000000000000d1a9e';
