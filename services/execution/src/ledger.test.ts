import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsdPriceOracle } from '@rhc/core';
import type { Fill, QuoteAsset } from '@rhc/types';
import { PortfolioLedger } from './ledger.js';

const ETH: QuoteAsset = {
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  isNative: true,
  graduationThreshold: '4200000000000000000',
  phantomQuote: null,
};

const USDG: QuoteAsset = {
  symbol: 'USDG',
  address: '0x0000000000000000000000000000000000000001',
  decimals: 6,
  graduationThreshold: '8090000000',
  isNative: false,
  phantomQuote: null,
};

let tempDir: string;
let ledger: PortfolioLedger | null = null;

function build(startingBalanceUsd = 1_000) {
  const oracle = new UsdPriceOracle('derive-from-graduation-threshold', 'USDG', {});
  oracle.ingest([USDG, ETH]);

  ledger = new PortfolioLedger(join(tempDir, 'ledger.sqlite'), 'paper', startingBalanceUsd, oracle);
  return { ledger, oracle };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    kind: 'fill',
    intentId: `int_${Math.random()}`,
    mode: 'paper',
    side: 'buy',
    tokenAddress: '0xaaaa000000000000000000000000000000000001',
    venue: 'curve',
    quoteAsset: ETH,
    quoteAmount: '1000000000000000000',
    tokenAmount: '1000000000000000000000',
    price: '1000000000000000',
    slippageBps: 0,
    feePaid: '0',
    taxPaid: '0',
    gasCostWei: '0',
    txHash: null,
    blockNumber: 1,
    timestamp: 1_000,
    ...overrides,
  };
}

function open(l: PortfolioLedger, f: Fill = fill()) {
  return l.applyBuy({
    fill: f,
    curveAddress: '0xbbbb000000000000000000000000000000000001',
    poolAddress: null,
    symbol: 'TEST',
    stage: 'scout',
    phase: 'curve',
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rhc-ledger-'));
});

afterEach(() => {
  ledger?.close();
  ledger = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('virtual funding', () => {
  it('splits the configured balance across quote assets rather than duplicating it', () => {
    // Funding each asset with the full amount would silently start the run with
    // startingBalance x assetCount of capital and make every P&L figure meaningless.
    const { ledger } = build(1_000);
    ledger.fundVirtual([ETH, USDG]);

    expect(ledger.equityUsd()).toBeCloseTo(1_000, 2);
  });

  it('is idempotent, so a restart does not top the wallet back up', () => {
    const { ledger } = build(1_000);
    ledger.fundVirtual([ETH, USDG]);
    ledger.fundVirtual([ETH, USDG]);

    expect(ledger.equityUsd()).toBeCloseTo(1_000, 2);
  });
});

describe('position accounting', () => {
  it('averages into an existing position on a second buy', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);

    open(ledger);
    const position = open(ledger, fill({ quoteAmount: '3000000000000000000', tokenAmount: '1000000000000000000000' }));

    expect(position.quoteInvested).toBe('4000000000000000000');
    expect(position.tokensHeld).toBe('2000000000000000000000');
    // 4 ETH for 2000 tokens -> 0.002 ETH each.
    expect(position.averageEntryPrice).toBe('2000000000000000');
  });

  it('releases cost basis in proportion to the tokens sold', () => {
    // A laddered exit must realise its share of the entry, not all of it on the first
    // rung — otherwise the first sale books the entire loss or gain.
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    const sold = ledger.applySell({
      fill: fill({
        side: 'sell',
        tokenAmount: '250000000000000000000',
        quoteAmount: '400000000000000000',
      }),
      positionId: position.positionId,
      reason: 'take-profit-ladder',
      ladderStep: 0,
    });

    // Sold a quarter: a quarter of the 1 ETH basis is released, and the 0.4 ETH received
    // realises 0.15 ETH of profit.
    expect(sold!.quoteInvested).toBe('750000000000000000');
    expect(sold!.realizedPnlQuote).toBe('150000000000000000');
    expect(sold!.status).toBe('open');
    expect(sold!.ladderStepsFilled).toEqual([0]);
  });

  it('closes the position once the remainder is dust', () => {
    // Chasing the last few wei costs more in fees than it returns, and a position that
    // never closes holds a slot forever.
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    const sold = ledger.applySell({
      fill: fill({ side: 'sell', tokenAmount: '999999999999999999999', quoteAmount: '1200000000000000000' }),
      positionId: position.positionId,
      reason: 'trailing-stop',
      ladderStep: null,
    });

    expect(sold!.status).toBe('closed');
    expect(sold!.tokensHeld).toBe('0');
    expect(sold!.exitReason).toBe('trailing-stop');
    expect(ledger.openPositions()).toHaveLength(0);
    expect(ledger.positionForToken(position.tokenAddress)).toBeUndefined();
  });

  it('records the peak multiple as a ratchet', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    ledger.updateMark(position.positionId, 3_000_000_000_000_000n, 3_000_000_000_000_000n);
    ledger.updateMark(position.positionId, 1_500_000_000_000_000n, 1_500_000_000_000_000n);

    const current = ledger.getPosition(position.positionId)!;
    expect(current.peakMultiple).toBe(3);
    expect(ledger.currentMultiple(current)).toBe(1.5);
  });
});

describe('stranded positions', () => {
  it('frees the position slot without counting as a close', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    ledger.markStranded(position.positionId, 'curve closed to sells');

    expect(ledger.openPositions()).toHaveLength(0);
    expect(ledger.strandedPositions()).toHaveLength(1);
    expect(ledger.closedPositions()).toHaveLength(0);
  });

  it('is carried at zero, so an unsellable holding cannot inflate equity', () => {
    // The last curve mark on a token that ran hard into graduation can be arbitrarily
    // high. Marking it there would suppress drawdown and feed the go/no-go gate a number
    // no exit could have produced.
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    ledger.updateMark(position.positionId, 500_000_000_000_000_000n, 500_000_000_000_000_000n);
    const inflated = ledger.equityUsd();

    ledger.markStranded(position.positionId, 'curve closed to sells');
    const honest = ledger.equityUsd();

    expect(inflated).toBeGreaterThan(honest);
    expect(ledger.strandedCostUsd()).toBeGreaterThan(0);
  });

  it('keeps the token mapped so the bot will not re-enter a name it cannot exit', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    ledger.markStranded(position.positionId, 'curve closed to sells');

    expect(ledger.positionForToken(position.tokenAddress)?.status).toBe('stranded');
  });

  it('strands only once, so the alert and the counter do not repeat', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);

    expect(ledger.markStranded(position.positionId, 'first')).not.toBeNull();
    expect(ledger.markStranded(position.positionId, 'second')).toBeNull();
  });

  it('refuses to re-mark a stranded position', () => {
    const { ledger } = build();
    ledger.fundVirtual([ETH]);
    const position = open(ledger);
    ledger.markStranded(position.positionId, 'curve closed to sells');

    expect(ledger.updateMark(position.positionId, 9n, 9n)).toBeNull();
  });
});

describe('durability', () => {
  it('restores open and stranded positions across a restart', () => {
    const { ledger: first } = build();
    first.fundVirtual([ETH]);
    const kept = open(first);
    const lost = open(first, fill({ tokenAddress: '0xaaaa000000000000000000000000000000000002' }));
    first.markStranded(lost.positionId, 'curve closed to sells');
    first.close();

    const oracle = new UsdPriceOracle('derive-from-graduation-threshold', 'USDG', {});
    oracle.ingest([USDG, ETH]);
    ledger = new PortfolioLedger(join(tempDir, 'ledger.sqlite'), 'paper', 1_000, oracle);

    expect(ledger.openPositions().map((p) => p.positionId)).toEqual([kept.positionId]);
    expect(ledger.strandedPositions().map((p) => p.positionId)).toEqual([lost.positionId]);
  });
});
