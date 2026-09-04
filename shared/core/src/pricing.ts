import type { QuoteAsset } from '@rhc/types';
import { formatUnits, parseUnits } from './decimal.js';
import { createLogger } from './logger.js';

const log = createLogger('pricing');

/**
 * Converts quote-asset amounts to USD for the ledger headline, risk limits, and the
 * dashboard.
 *
 * Exact P&L is always tracked in quote units — this layer never touches it. USD exists
 * so that "max $50 per position" and "halt at -15% on the day" mean one thing across
 * launches quoted in ETH, USDG, and tokenized equities at the same time.
 *
 * The default strategy exploits a property of the launchpad rather than an external
 * feed: Pons sizes every approved quote asset's graduation threshold to the same USD
 * notional, so the thresholds are a ratio table between the assets. Anchoring on the
 * dollar stablecoin turns that into USD prices that refresh themselves from chain state.
 *
 * Thresholds are set in round numbers, so derived prices are approximate — two assets
 * priced closely enough will land on the same threshold and read as identical. That is
 * fine for what this is used for and would not be fine for anything else, so it is an
 * inference labelled as such everywhere it surfaces, and any asset can be pinned via
 * `accounting.usdPriceOverrides`.
 */
export class UsdPriceOracle {
  private readonly bySymbol = new Map<string, number>();
  private readonly byAddress = new Map<string, number>();
  private anchorNotionalUsd: number | null = null;

  constructor(
    private readonly strategy: 'derive-from-graduation-threshold' | 'config-only',
    private readonly stableAnchorSymbol: string,
    overrides: Record<string, number>,
  ) {
    for (const [symbol, price] of Object.entries(overrides)) {
      this.bySymbol.set(symbol.toUpperCase(), price);
    }
  }

  /**
   * Feed the oracle the approved quote assets once thresholds have been read from the
   * factory. Safe to call again when the approved set changes.
   */
  ingest(assets: QuoteAsset[]): void {
    if (this.strategy !== 'derive-from-graduation-threshold') return;

    const anchor = assets.find((a) => a.symbol.toUpperCase() === this.stableAnchorSymbol.toUpperCase());
    if (!anchor?.graduationThreshold) {
      log.warn('no stable anchor threshold available; USD conversion limited to config overrides', {
        anchor: this.stableAnchorSymbol,
      });
      return;
    }

    // The anchor is a dollar stablecoin, so its threshold in whole units *is* the shared
    // USD notional every other asset's threshold is sized to.
    this.anchorNotionalUsd = Number(formatUnits(BigInt(anchor.graduationThreshold), anchor.decimals));
    this.bySymbol.set(anchor.symbol.toUpperCase(), 1);
    this.byAddress.set(anchor.address.toLowerCase(), 1);

    for (const asset of assets) {
      const key = asset.symbol.toUpperCase();
      if (this.bySymbol.has(key) && key !== anchor.symbol.toUpperCase()) {
        // A config override wins; still map it by address.
        this.byAddress.set(asset.address.toLowerCase(), this.bySymbol.get(key)!);
        continue;
      }
      if (!asset.graduationThreshold) continue;

      const thresholdWhole = Number(formatUnits(BigInt(asset.graduationThreshold), asset.decimals));
      if (thresholdWhole <= 0) continue;

      const price = this.anchorNotionalUsd / thresholdWhole;
      this.bySymbol.set(key, price);
      this.byAddress.set(asset.address.toLowerCase(), price);
    }

    log.info('derived quote-asset USD reference prices', {
      anchorNotionalUsd: this.anchorNotionalUsd,
      assets: this.bySymbol.size,
      sample: Object.fromEntries(
        [...this.bySymbol.entries()].slice(0, 4).map(([k, v]) => [k, Number(v.toFixed(4))]),
      ),
    });
  }

  /** USD per whole unit of the asset, or null when unknown. */
  usdPrice(asset: QuoteAsset): number | null {
    return (
      this.byAddress.get(asset.address.toLowerCase()) ?? this.bySymbol.get(asset.symbol.toUpperCase()) ?? null
    );
  }

  toUsd(amount: bigint, asset: QuoteAsset): number | null {
    const price = this.usdPrice(asset);
    if (price == null) return null;
    return Number(formatUnits(amount, asset.decimals)) * price;
  }

  /** USD -> base units of the quote asset. Used to size an order from a USD budget. */
  fromUsd(usd: number, asset: QuoteAsset): bigint | null {
    const price = this.usdPrice(asset);
    if (price == null || price <= 0) return null;
    const whole = usd / price;
    // Guard against sub-base-unit rounding on 6-decimal assets at small sizes.
    return parseUnits(whole.toFixed(Math.min(asset.decimals, 18)), asset.decimals);
  }

  isPriceable(asset: QuoteAsset): boolean {
    return this.usdPrice(asset) != null;
  }

  snapshot(): { strategy: string; anchorNotionalUsd: number | null; prices: Record<string, number> } {
    return {
      strategy: this.strategy,
      anchorNotionalUsd: this.anchorNotionalUsd,
      prices: Object.fromEntries(this.bySymbol),
    };
  }
}
