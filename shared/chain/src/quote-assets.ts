import type { Address } from 'viem';
import { createLogger, type AppConfig } from '@rhc/core';
import type { QuoteAsset } from '@rhc/types';
import type { ChainReader } from './reader.js';

const log = createLogger('chain:quote-assets');

const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * The set of assets a launch can be quoted in.
 *
 * The approved list is owner-mutable and grows in batches, so the config seed is only a
 * list of candidates: every entry is confirmed against `pairTokenEconomics` on the
 * factory before it is usable, and an asset seen for the first time at runtime is
 * resolved on demand. An asset that fails its on-chain read is dropped rather than
 * assumed — a launch quoted in an asset we cannot price is one we decline to trade.
 */
export class QuoteAssetRegistry {
  private readonly byAddress = new Map<string, QuoteAsset>();
  private readonly symbolSeed = new Map<string, string>();
  private readonly unresolved = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly reader: ChainReader,
    private readonly factory: Address,
  ) {
    for (const seed of config.chain.quoteAssets.seed) {
      this.symbolSeed.set(seed.address.toLowerCase(), seed.symbol);
    }
  }

  async resolveAll(): Promise<QuoteAsset[]> {
    const seeds = this.config.chain.quoteAssets.seed;
    const resolved: QuoteAsset[] = [];
    let dropped = 0;

    for (const seed of seeds) {
      const asset = await this.resolve(seed.address as Address);
      if (asset) resolved.push(asset);
      else dropped += 1;
    }

    log.info('resolved approved quote assets from factory', {
      resolved: resolved.length,
      dropped,
      authority: this.config.chain.quoteAssets.authority,
    });
    return resolved;
  }

  /** Cached lookup. Resolves against the factory the first time an asset is seen. */
  async resolve(address: Address): Promise<QuoteAsset | null> {
    const key = address.toLowerCase();
    const cached = this.byAddress.get(key);
    if (cached) return cached;
    if (this.unresolved.has(key)) return null;

    const economics = await this.reader.readPairTokenEconomics(this.factory, address);
    if (!economics || !economics.approved) {
      this.unresolved.add(key);
      log.debug('quote asset not approved by factory', { address });
      return null;
    }

    const isNative = key === NATIVE;
    let symbol = this.symbolSeed.get(key);
    if (!symbol) {
      symbol = isNative
        ? this.config.chain.chain.nativeCurrency.symbol
        : (await this.reader.readTokenMeta(address)).symbol;
    }

    const asset: QuoteAsset = {
      symbol,
      address: key as QuoteAsset['address'],
      decimals: economics.decimals,
      isNative,
      graduationThreshold: economics.graduationThreshold.toString(),
      phantomQuote: economics.phantomQuote.toString(),
    };

    this.byAddress.set(key, asset);
    return asset;
  }

  get(address: string): QuoteAsset | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  all(): QuoteAsset[] {
    return [...this.byAddress.values()];
  }

  /** Symbols the operator has allowed the bot to trade, intersected with what resolved. */
  allowed(): QuoteAsset[] {
    const allowlist = new Set(this.config.bot.listener.quoteAssetAllowlist.map((s) => s.toUpperCase()));
    if (allowlist.has('*')) return this.all();
    return this.all().filter((a) => allowlist.has(a.symbol.toUpperCase()));
  }

  isAllowed(asset: QuoteAsset): boolean {
    const allowlist = this.config.bot.listener.quoteAssetAllowlist.map((s) => s.toUpperCase());
    return allowlist.includes('*') || allowlist.includes(asset.symbol.toUpperCase());
  }
}
