import { createLogger, type AppConfig } from '@rhc/core';

const log = createLogger('vetting:goplus');

export interface ScannerVerdict {
  provider: string;
  available: boolean;
  flagged: boolean;
  reasons: string[];
  raw?: unknown;
}

/**
 * GoPlus token-security lookup.
 *
 * Scam detection on standard EVM patterns is commoditised, so this defers to a
 * specialist rather than reimplementing it. What it is *not* is a substitute for the
 * on-chain round trip: GoPlus has no confirmed Robinhood Chain coverage, and a scanner
 * that does not know the chain will happily return an empty result that reads like a
 * clean bill of health. `available: false` is therefore propagated distinctly from
 * `flagged: false`, and the vetting service is what decides how to treat the difference.
 */
export class GoPlusClient {
  private chainSupported: boolean | null = null;
  private readonly endpoint: string;
  private readonly chainId: string;

  constructor(config: AppConfig, private readonly apiKey: string | undefined) {
    this.endpoint = config.chain.externalApis.goplus?.endpoint ?? 'https://api.gopluslabs.io/api/v1';
    this.chainId = String(config.chain.chain.id);
  }

  async check(tokenAddress: string): Promise<ScannerVerdict> {
    if (this.chainSupported === false) {
      return { provider: 'goplus', available: false, flagged: false, reasons: ['chain not supported'] };
    }

    try {
      const url = `${this.endpoint}/token_security/${this.chainId}?contract_addresses=${tokenAddress}`;
      const response = await fetch(url, {
        headers: this.apiKey ? { Authorization: this.apiKey } : {},
        signal: AbortSignal.timeout(4_000),
      });

      if (!response.ok) {
        this.noteUnsupported(`http ${response.status}`);
        return { provider: 'goplus', available: false, flagged: false, reasons: [`http ${response.status}`] };
      }

      const body = (await response.json()) as { code?: number; message?: string; result?: Record<string, unknown> };

      // Code 1 is success. Anything else — including "chain not supported" — means the
      // answer carries no information about this token.
      if (body.code !== 1 || !body.result) {
        this.noteUnsupported(body.message ?? `code ${body.code}`);
        return {
          provider: 'goplus',
          available: false,
          flagged: false,
          reasons: [body.message ?? `api code ${body.code}`],
        };
      }

      const entry = body.result[tokenAddress.toLowerCase()] as Record<string, string> | undefined;
      if (!entry) {
        return { provider: 'goplus', available: false, flagged: false, reasons: ['token not indexed'] };
      }

      this.chainSupported = true;

      const reasons: string[] = [];
      const isTrue = (key: string): boolean => entry[key] === '1';
      if (isTrue('is_honeypot')) reasons.push('flagged as honeypot');
      if (isTrue('cannot_sell_all')) reasons.push('cannot sell all');
      if (isTrue('transfer_pausable')) reasons.push('transfers pausable');
      if (isTrue('is_blacklisted')) reasons.push('blacklist function present');
      if (isTrue('trading_cooldown')) reasons.push('trading cooldown');
      if (isTrue('is_proxy')) reasons.push('proxy contract');
      if (isTrue('can_take_back_ownership')) reasons.push('ownership reclaimable');
      if (isTrue('hidden_owner')) reasons.push('hidden owner');

      return { provider: 'goplus', available: true, flagged: reasons.length > 0, reasons, raw: entry };
    } catch (err) {
      return {
        provider: 'goplus',
        available: false,
        flagged: false,
        reasons: [(err as Error).message],
      };
    }
  }

  private noteUnsupported(detail: string): void {
    if (this.chainSupported === null) {
      this.chainSupported = false;
      log.warn('external scanner does not cover this chain; vetting relies on on-chain simulation', {
        chainId: this.chainId,
        detail,
      });
    }
  }
}
