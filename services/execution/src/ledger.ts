import { formatUnits, migrate, newId, openDb, type Db, type UsdPriceOracle } from '@rhc/core';
import { createLogger } from '@rhc/core';
import type { EntryStage, ExitReason, Fill, LaunchPhase, Position, QuoteAsset, TradingMode } from '@rhc/types';

const log = createLogger('ledger');

/**
 * The portfolio ledger. One implementation, used by both modes.
 *
 * This is deliberately not a "paper ledger" with a live counterpart. Paper and live fills
 * are the same record with a different `mode` and a `txHash` that is null in one case,
 * so paper results are directly comparable to live results without reconciling two
 * schemas. Sizing, P&L, ladder progress, and risk accounting all run through this one
 * path — which is what makes the mode switch a one-line difference in the execution
 * service rather than a second code path.
 */
export class PortfolioLedger {
  private readonly db: Db;
  private readonly positions = new Map<string, Position>();
  private readonly byToken = new Map<string, string>();

  /** Virtual quote balances, per asset, in base units. Paper mode only. */
  private readonly virtualBalances = new Map<string, bigint>();

  constructor(
    dbPath: string,
    private readonly mode: TradingMode,
    private readonly startingBalanceUsd: number,
    private readonly oracle: UsdPriceOracle,
  ) {
    this.db = openDb(dbPath);
    migrate(this.db, 'ledger', [
      `CREATE TABLE positions (
         position_id TEXT PRIMARY KEY,
         token_address TEXT NOT NULL,
         symbol TEXT NOT NULL,
         mode TEXT NOT NULL,
         status TEXT NOT NULL,
         payload TEXT NOT NULL,
         opened_at INTEGER NOT NULL,
         closed_at INTEGER
       );
       CREATE INDEX idx_positions_token ON positions(token_address);
       CREATE INDEX idx_positions_status ON positions(status);`,
      `CREATE TABLE fills (
         fill_id TEXT PRIMARY KEY,
         position_id TEXT NOT NULL,
         intent_id TEXT NOT NULL,
         mode TEXT NOT NULL,
         side TEXT NOT NULL,
         token_address TEXT NOT NULL,
         payload TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );
       CREATE INDEX idx_fills_position ON fills(position_id);`,
    ]);

    this.restore();
  }

  private restore(): void {
    const rows = this.db.all<{ payload: string }>("SELECT payload FROM positions WHERE status != 'closed'");
    for (const row of rows) {
      const position = JSON.parse(row.payload) as Position;
      this.positions.set(position.positionId, position);
      this.byToken.set(position.tokenAddress, position.positionId);
    }
    if (rows.length > 0) log.info('restored open positions', { count: rows.length });
  }

  /**
   * Seed the virtual wallet. Paper mode only — in live mode the balance is whatever the
   * hot wallet actually holds, and pretending otherwise would let the bot size trades it
   * cannot fund.
   */
  fundVirtual(asset: QuoteAsset): void {
    if (this.mode !== 'paper') return;
    if (this.virtualBalances.has(asset.address)) return;
    const amount = this.oracle.fromUsd(this.startingBalanceUsd, asset);
    if (amount == null) return;
    this.virtualBalances.set(asset.address, amount);
    log.info('funded virtual balance', {
      asset: asset.symbol,
      amount: formatUnits(amount, asset.decimals, 6),
      usd: this.startingBalanceUsd,
    });
  }

  virtualBalance(asset: QuoteAsset): bigint {
    return this.virtualBalances.get(asset.address) ?? 0n;
  }

  /**
   * Equity in USD: uncommitted virtual balance plus the mark value of open positions.
   *
   * Positions are marked at their *realisable* price — what selling the remaining tokens
   * into the current curve would actually return — not at spot. On a thin bonding curve
   * those differ a lot, and marking at spot is how a paper ledger reports gains that
   * were never exitable.
   */
  equityUsd(): number {
    let total = 0;
    const counted = new Set<string>();

    for (const [address, balance] of this.virtualBalances) {
      const asset = this.assetOf(address);
      if (!asset) continue;
      total += this.oracle.toUsd(balance, asset) ?? 0;
      counted.add(address);
    }

    for (const position of this.positions.values()) {
      if (position.status === 'closed') continue;
      const markValue = (BigInt(position.tokensHeld) * BigInt(position.markPrice)) / 10n ** 18n;
      total += this.oracle.toUsd(markValue, position.quoteAsset) ?? 0;
    }

    return total;
  }

  private readonly knownAssets = new Map<string, QuoteAsset>();
  private assetOf(address: string): QuoteAsset | undefined {
    return this.knownAssets.get(address);
  }
  registerAsset(asset: QuoteAsset): void {
    this.knownAssets.set(asset.address, asset);
  }

  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }

  positionForToken(tokenAddress: string): Position | undefined {
    const id = this.byToken.get(tokenAddress.toLowerCase());
    return id ? this.positions.get(id) : undefined;
  }

  openPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status !== 'closed');
  }

  allPositions(limit = 200): Position[] {
    const rows = this.db.all<{ payload: string }>(
      'SELECT payload FROM positions ORDER BY opened_at DESC LIMIT ?',
      limit,
    );
    return rows.map((r) => JSON.parse(r.payload) as Position);
  }

  closedPositions(sinceMs = 0): Position[] {
    const rows = this.db.all<{ payload: string }>(
      "SELECT payload FROM positions WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at DESC",
      sinceMs,
    );
    return rows.map((r) => JSON.parse(r.payload) as Position);
  }

  /** Apply a buy fill, opening a position or averaging into an existing one. */
  applyBuy(params: {
    fill: Fill;
    curveAddress: string | null;
    poolAddress: string | null;
    symbol: string;
    stage: EntryStage;
    phase: LaunchPhase;
  }): Position {
    const { fill, symbol, stage, phase } = params;
    this.registerAsset(fill.quoteAsset);
    this.debitVirtual(fill.quoteAsset, BigInt(fill.quoteAmount));

    const existing = this.positionForToken(fill.tokenAddress);

    if (existing) {
      const prevTokens = BigInt(existing.tokensHeld);
      const prevInvested = BigInt(existing.quoteInvested);
      const newTokens = prevTokens + BigInt(fill.tokenAmount);
      const newInvested = prevInvested + BigInt(fill.quoteAmount);

      existing.tokensHeld = newTokens.toString();
      existing.quoteInvested = newInvested.toString();
      existing.averageEntryPrice =
        newTokens > 0n ? ((newInvested * 10n ** 18n) / newTokens).toString() : existing.averageEntryPrice;
      existing.stage = stage;
      existing.fills.push(fill);
      this.persist(existing);
      return existing;
    }

    const position: Position = {
      positionId: newId('pos'),
      tokenAddress: fill.tokenAddress,
      curveAddress: params.curveAddress as Position['curveAddress'],
      poolAddress: params.poolAddress as Position['poolAddress'],
      symbol,
      venue: fill.venue,
      phase,
      quoteAsset: fill.quoteAsset,
      mode: fill.mode,
      status: 'open',
      stage,
      quoteInvested: fill.quoteAmount,
      tokensHeld: fill.tokenAmount,
      averageEntryPrice: fill.price,
      lastPrice: fill.price,
      markPrice: fill.price,
      peakMultiple: 1,
      realizedPnlQuote: '0',
      unrealizedPnlQuote: '0',
      ladderStepsFilled: [],
      openedAt: fill.timestamp,
      closedAt: null,
      exitReason: null,
      fills: [fill],
    };

    this.positions.set(position.positionId, position);
    this.byToken.set(position.tokenAddress, position.positionId);
    this.persist(position);
    return position;
  }

  /** Apply a sell fill, realising P&L and closing the position when it is emptied. */
  applySell(params: { fill: Fill; positionId: string; reason: ExitReason; ladderStep: number | null }): Position | null {
    const position = this.positions.get(params.positionId);
    if (!position) return null;

    const { fill } = params;
    this.creditVirtual(fill.quoteAsset, BigInt(fill.quoteAmount));

    const tokensSold = BigInt(fill.tokenAmount);
    const tokensBefore = BigInt(position.tokensHeld);
    const investedBefore = BigInt(position.quoteInvested);

    // Cost basis is released in proportion to the tokens leaving, so a laddered exit
    // realises the right share of the entry rather than all of it on the first rung.
    const costReleased = tokensBefore > 0n ? (investedBefore * tokensSold) / tokensBefore : 0n;
    const realized = BigInt(fill.quoteAmount) - costReleased;

    position.tokensHeld = (tokensBefore - tokensSold).toString();
    position.quoteInvested = (investedBefore - costReleased).toString();
    position.realizedPnlQuote = (BigInt(position.realizedPnlQuote) + realized).toString();
    position.fills.push(fill);
    if (params.ladderStep != null && !position.ladderStepsFilled.includes(params.ladderStep)) {
      position.ladderStepsFilled.push(params.ladderStep);
    }

    // Dust below a millionth of the original size is not worth another sell attempt: the
    // fee would exceed the proceeds and the position would never close.
    const dustThreshold = tokensBefore / 1_000_000n;
    if (BigInt(position.tokensHeld) <= dustThreshold) {
      position.tokensHeld = '0';
      position.status = 'closed';
      position.closedAt = fill.timestamp;
      position.exitReason = params.reason;
      position.unrealizedPnlQuote = '0';
      this.byToken.delete(position.tokenAddress);
    }

    this.persist(position);
    return position;
  }

  /** Refresh the mark and peak multiple from current chain state. */
  updateMark(positionId: string, markPrice: bigint, lastPrice: bigint, phase?: LaunchPhase): Position | null {
    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed') return null;

    position.markPrice = markPrice.toString();
    position.lastPrice = lastPrice.toString();
    if (phase) position.phase = phase;

    const entry = BigInt(position.averageEntryPrice);
    if (entry > 0n) {
      const multiple = Number((markPrice * 10_000n) / entry) / 10_000;
      if (multiple > position.peakMultiple) position.peakMultiple = multiple;
    }

    const tokens = BigInt(position.tokensHeld);
    const markValue = (tokens * markPrice) / 10n ** 18n;
    position.unrealizedPnlQuote = (markValue - BigInt(position.quoteInvested)).toString();

    this.persist(position);
    return position;
  }

  currentMultiple(position: Position): number {
    const entry = BigInt(position.averageEntryPrice);
    if (entry <= 0n) return 1;
    return Number((BigInt(position.markPrice) * 10_000n) / entry) / 10_000;
  }

  private debitVirtual(asset: QuoteAsset, amount: bigint): void {
    if (this.mode !== 'paper') return;
    this.virtualBalances.set(asset.address, this.virtualBalance(asset) - amount);
  }

  private creditVirtual(asset: QuoteAsset, amount: bigint): void {
    if (this.mode !== 'paper') return;
    this.virtualBalances.set(asset.address, this.virtualBalance(asset) + amount);
  }

  private persist(position: Position): void {
    this.db.run(
      `INSERT INTO positions (position_id, token_address, symbol, mode, status, payload, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(position_id) DO UPDATE SET status = excluded.status, payload = excluded.payload, closed_at = excluded.closed_at`,
      position.positionId,
      position.tokenAddress,
      position.symbol,
      position.mode,
      position.status,
      JSON.stringify(position),
      position.openedAt,
      position.closedAt,
    );

    const latest = position.fills.at(-1);
    if (latest) {
      this.db.run(
        `INSERT OR IGNORE INTO fills (fill_id, position_id, intent_id, mode, side, token_address, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `${latest.intentId}:${latest.side}:${latest.timestamp}`,
        position.positionId,
        latest.intentId,
        latest.mode,
        latest.side,
        latest.tokenAddress,
        JSON.stringify(latest),
        latest.timestamp,
      );
    }

    if (position.status === 'closed') this.positions.delete(position.positionId);
  }

  close(): void {
    this.db.close();
  }
}
