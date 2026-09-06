import { PRICE_SCALE, priceOf, quoteValueOf } from '@rhc/chain';
import { formatUnits, migrate, newId, openDb, type Db, type UsdPriceOracle } from '@rhc/core';
import { createLogger } from '@rhc/core';
import type { EntryStage, ExitReason, Fill, LaunchPhase, Position, QuoteAsset, TradingMode } from '@rhc/types';

const log = createLogger('ledger');

/**
 * Prices were originally stored as plain quote base units per whole token. That carries
 * about one significant figure under a 6-decimal quote asset, so they are now scaled by
 * `PRICE_SCALE`. Rows written before the change have to be brought onto the same scale
 * or a restart would mark every restored position at ~1e-18 of its real value.
 */
function rescalePricesToFixedPoint(db: Db): void {
  const scale = (value: unknown): string =>
    typeof value === 'string' && /^\d+$/.test(value) ? (BigInt(value) * PRICE_SCALE).toString() : String(value ?? '0');

  for (const row of db.all<{ position_id: string; payload: string }>('SELECT position_id, payload FROM positions')) {
    const position = JSON.parse(row.payload) as Record<string, unknown>;
    for (const field of ['averageEntryPrice', 'lastPrice', 'markPrice']) {
      position[field] = scale(position[field]);
    }
    for (const fill of (position.fills ?? []) as Record<string, unknown>[]) {
      fill.price = scale(fill.price);
    }
    db.run('UPDATE positions SET payload = ? WHERE position_id = ?', JSON.stringify(position), row.position_id);
  }

  for (const row of db.all<{ fill_id: string; payload: string }>('SELECT fill_id, payload FROM fills')) {
    const fill = JSON.parse(row.payload) as Record<string, unknown>;
    fill.price = scale(fill.price);
    db.run('UPDATE fills SET payload = ? WHERE fill_id = ?', JSON.stringify(fill), row.fill_id);
  }
}

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
      rescalePricesToFixedPoint,
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
   *
   * The configured starting balance is the total across all quote assets, split evenly
   * so the bot can trade launches in any of them. Funding each asset with the full
   * amount would silently multiply the starting capital by the number of assets.
   */
  fundVirtual(assets: QuoteAsset[]): void {
    if (this.mode !== 'paper' || assets.length === 0) return;

    const perAssetUsd = this.startingBalanceUsd / assets.length;
    for (const asset of assets) {
      if (this.virtualBalances.has(asset.address)) continue;
      const amount = this.oracle.fromUsd(perAssetUsd, asset);
      if (amount == null) continue;
      this.registerAsset(asset);
      this.virtualBalances.set(asset.address, amount);
      log.info('funded virtual balance', {
        asset: asset.symbol,
        amount: formatUnits(amount, asset.decimals, 6),
        usd: Number(perAssetUsd.toFixed(2)),
      });
    }
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
   *
   * Stranded positions are carried at zero for the same reason, taken to its conclusion:
   * their last curve mark can be arbitrarily high (a token that ran hard on its way to
   * graduation), and counting an unsellable holding at that price would inflate equity,
   * suppress drawdown, and hand the go/no-go gate a number that no exit could ever have
   * produced. Zero understates them — the tokens do have value in the v4 pool — but the
   * error points the safe way for a decision about risking real capital.
   */
  equityUsd(): number {
    let total = 0;

    for (const [address, balance] of this.virtualBalances) {
      const asset = this.assetOf(address);
      if (!asset) continue;
      total += this.oracle.toUsd(balance, asset) ?? 0;
    }

    for (const position of this.positions.values()) {
      if (position.status === 'closed' || position.status === 'stranded') continue;
      const markValue = quoteValueOf(BigInt(position.tokensHeld), BigInt(position.markPrice));
      total += this.oracle.toUsd(markValue, position.quoteAsset) ?? 0;
    }

    return total;
  }

  /** Quote-asset cost basis locked up in positions that cannot be sold. */
  strandedCostUsd(): number {
    let total = 0;
    for (const position of this.strandedPositions()) {
      total += this.oracle.toUsd(BigInt(position.quoteInvested), position.quoteAsset) ?? 0;
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

  /**
   * Positions the exit engine should still be working on.
   *
   * Stranded positions are excluded. They are unsellable until a Uniswap v4 route
   * exists, so leaving them here would re-evaluate them on every tick forever and — far
   * worse — hold a concurrency slot against `maxConcurrentPositions` permanently, which
   * silently starves the bot of capacity one stranding at a time.
   */
  openPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === 'open' || p.status === 'closing');
  }

  strandedPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === 'stranded');
  }

  /**
   * Record that a position can no longer be sold through any route this bot implements.
   *
   * The token stays mapped so the decision engine will not re-enter a name we are
   * already stuck in.
   */
  markStranded(positionId: string, detail: string): Position | null {
    const position = this.positions.get(positionId);
    if (!position || position.status === 'stranded' || position.status === 'closed') return null;

    position.status = 'stranded';
    position.closedAt = Date.now();
    position.exitReason = 'graduation-exit';
    position.unrealizedPnlQuote = '0';
    this.persist(position);

    log.warn('position stranded', {
      positionId,
      token: position.tokenAddress,
      symbol: position.symbol,
      detail,
    });
    return position;
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
        newTokens > 0n ? priceOf(newInvested, newTokens).toString() : existing.averageEntryPrice;
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

  /**
   * Refresh the mark and peak multiple from current chain state.
   *
   * A non-positive mark means the curve could not price a sale at all, which is not the
   * same as the position being worthless: writing it in would ratchet nothing but would
   * report a -100% drawdown and trip every stop at once. The previous mark is kept and
   * the caller decides what an unpriceable curve means.
   */
  updateMark(positionId: string, markPrice: bigint, lastPrice: bigint, phase?: LaunchPhase): Position | null {
    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed' || position.status === 'stranded') return null;
    if (phase) position.phase = phase;
    if (markPrice <= 0n) return position;

    position.markPrice = markPrice.toString();
    position.lastPrice = lastPrice.toString();

    const entry = BigInt(position.averageEntryPrice);
    if (entry > 0n) {
      const multiple = Number((markPrice * 10_000n) / entry) / 10_000;
      if (multiple > position.peakMultiple) position.peakMultiple = multiple;
    }

    const markValue = quoteValueOf(BigInt(position.tokensHeld), markPrice);
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
