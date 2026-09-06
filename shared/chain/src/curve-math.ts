import { bigintMin, ceilDiv, clamp01, divRound, ratio } from '@rhc/core';

/**
 * Pons V2 bonding-curve pricing, reimplemented locally.
 *
 * The curve exposes no `quote` view function, so anything that needs a fill price — the
 * paper engine, slippage checks, the depth-aware stop — has to price the trade itself.
 * These functions mirror the contract's integer order of operations exactly; changing
 * the order to something algebraically equivalent will drift from the real fill by a few
 * wei, and near the reserved allocation by considerably more.
 *
 * The invariant is constant-product against a *phantom* quote reserve: `getReserves()`
 * returns a pricing quote reserve that includes a virtual balance nobody deposited.
 * `realQuoteReserve()` is what the curve physically holds, and is the wrong input for a
 * quote — but it is the right input for graduation progress.
 */

export const BPS = 10_000n;

export interface CurveState {
  /** Pricing quote reserve, inclusive of the phantom amount. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  /** Tokens still buyable before the curve closes and graduates. */
  sellableTokens: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** Quote actually collected. Compare against the threshold for progress. */
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
}

/**
 * Constant-product output.
 *
 * Both reserves must be positive for the invariant to mean anything. An empty
 * `reserveIn` is the dangerous case: the formula degenerates to `reserveOut`, so a swept
 * curve would price *any* sell at its entire remaining quote balance and mark the
 * position at a multiple that no trade could ever realise. There is no price here, so
 * this reports none rather than an enormous one.
 */
export function amountOut(inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (inAmount <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  return (inAmount * reserveOut) / (reserveIn + inAmount);
}

export function amountIn(outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (outAmount <= 0n) return 0n;
  if (outAmount >= reserveOut) throw new Error('output exceeds reserve');
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
}

export interface BuyQuote {
  tokensOut: bigint;
  /** Quote actually consumed. Below `quoteIn` when the fill clamps at the allocation. */
  spent: bigint;
  refund: bigint;
  feePaid: bigint;
  taxPaid: bigint;
  snipeTaxPaid: bigint;
  /** True when the buy crossed the reserved allocation and was filled to the edge. */
  clamped: boolean;
}

/**
 * Price a buy. Every fee comes off the input before the curve prices the trade, so a
 * buyer moves the price less than their spend implies.
 *
 * `snipeTaxBps` must be read per *recipient* — exemptions are held against the wallet
 * receiving the tokens, not the sender.
 */
export function quoteBuy(state: CurveState, quoteIn: bigint, snipeTaxBps: bigint): BuyQuote {
  if (quoteIn <= 0n) {
    return { tokensOut: 0n, spent: 0n, refund: 0n, feePaid: 0n, taxPaid: 0n, snipeTaxPaid: 0n, clamped: false };
  }

  // The contract caps the snipe tax so a buyer always nets at least 1% of spend.
  let snipeBps = snipeTaxBps;
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - state.feeBps - state.creatorTaxBps - 100n;
    if (snipeBps > maxSnipeBps) snipeBps = maxSnipeBps;
  }

  let spent = quoteIn;
  const fee = (spent * state.feeBps) / BPS;
  const tax = (spent * state.creatorTaxBps) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;

  let tokensOut = amountOut(spent - fee - tax - snipeTax, state.quoteReserve, state.tokenReserve);
  let clamped = false;

  // A buy that would cross the reserved allocation fills to the edge and the input is
  // repriced from the token side, refunding the rest in the same transaction.
  if (tokensOut > state.sellableTokens) {
    clamped = true;
    tokensOut = state.sellableTokens;
    const net = amountIn(state.sellableTokens, state.quoteReserve, state.tokenReserve);
    const denominator = BPS - state.feeBps - state.creatorTaxBps - snipeBps;
    const grossed = denominator > 0n ? ceilDiv(net * BPS, denominator) : quoteIn;
    spent = bigintMin(grossed, quoteIn);
  }

  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    feePaid: (spent * state.feeBps) / BPS,
    taxPaid: (spent * state.creatorTaxBps) / BPS,
    snipeTaxPaid: (spent * snipeBps) / BPS,
    clamped,
  };
}

export interface SellQuote {
  quoteOut: bigint;
  grossQuote: bigint;
  feePaid: bigint;
  taxPaid: bigint;
}

/**
 * Price a sell. The trade is priced first and fees come off the output, which is why a
 * sell cannot be quoted as a mirrored buy — doing so overstates the proceeds.
 */
export function quoteSell(state: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) return { quoteOut: 0n, grossQuote: 0n, feePaid: 0n, taxPaid: 0n };

  const gross = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  const fee = (gross * state.feeBps) / BPS;
  const tax = (gross * state.creatorTaxBps) / BPS;
  return { quoteOut: gross - fee - tax, grossQuote: gross, feePaid: fee, taxPaid: tax };
}

/**
 * Fixed-point scale for every price in this system.
 *
 * A price is quote base units per whole token, multiplied by `PRICE_SCALE`. The scale is
 * not cosmetic: a 1B-supply token quoted in a 6-decimal asset like USDG costs single
 * digits of base units per whole token, so an unscaled integer price carries about one
 * significant figure. At that resolution the smallest representable move is tens of
 * percent, entry and mark round to the same number while the position is visibly up or
 * down, and every multiple, ladder rung and stop derived from them is quantisation
 * noise. Scaling first keeps low-decimal quote assets as precise as 18-decimal ones.
 */
export const PRICE_SCALE = 10n ** 18n;

/** Price per whole token implied by a fill or a reserve ratio. */
export function priceOf(quoteAmount: bigint, tokenAmount: bigint, tokenDecimals = 18): bigint {
  if (tokenAmount <= 0n) return 0n;
  return divRound(quoteAmount * 10n ** BigInt(tokenDecimals) * PRICE_SCALE, tokenAmount);
}

/** Quote base units that `tokenAmount` is worth at `price`. Inverse of `priceOf`. */
export function quoteValueOf(tokenAmount: bigint, price: bigint, tokenDecimals = 18): bigint {
  if (tokenAmount <= 0n || price <= 0n) return 0n;
  return divRound(tokenAmount * price, 10n ** BigInt(tokenDecimals) * PRICE_SCALE);
}

/** Token base units that `quoteAmount` buys at `price`. Inverse of `quoteValueOf`. */
export function tokensForQuote(quoteAmount: bigint, price: bigint, tokenDecimals = 18): bigint {
  if (quoteAmount <= 0n || price <= 0n) return 0n;
  return divRound(quoteAmount * 10n ** BigInt(tokenDecimals) * PRICE_SCALE, price);
}

/**
 * Marginal price of one whole token, `PRICE_SCALE`-scaled. Display only — it carries no
 * slippage, so sizing or P&L computed from it will be optimistic.
 */
export function spotPrice(state: CurveState, tokenDecimals = 18): bigint {
  return priceOf(state.quoteReserve, state.tokenReserve, tokenDecimals);
}

/**
 * Realisable price per whole token for a specific position size, from `quoteSell`. This
 * is the honest mark: on a thin curve it can sit far below spot, and marking a position
 * at spot is how a paper ledger ends up reporting profits that were never exitable.
 */
export function realizablePrice(state: CurveState, tokensHeld: bigint, tokenDecimals = 18): bigint {
  if (tokensHeld <= 0n) return 0n;
  const { quoteOut } = quoteSell(state, tokensHeld);
  return priceOf(quoteOut, tokensHeld, tokenDecimals);
}

/**
 * Progress toward graduation in 0..1, measured on collected quote against the threshold.
 * Uses `realQuoteReserve` because the phantom balance was never contributed by anyone.
 */
export function graduationProgress(state: CurveState): number {
  if (state.graduationThreshold <= 0n) return 0;
  return clamp01(ratio(state.realQuoteReserve, state.graduationThreshold));
}

/**
 * Price impact in bps of selling `tokensIn`, against the current marginal price.
 *
 * This is the input to the depth-aware stop. Pre-graduation, impact is mechanically
 * determined by curve reserves, so we can ask a precise question a generic percentage
 * stop cannot: "could a single sell the size of my own position have produced the
 * drawdown I am seeing?" If yes, the move is noise from one wallet. If the drawdown is
 * deeper than that, real selling pressure is arriving and the stop should fire.
 */
export function sellImpactBps(state: CurveState, tokensIn: bigint): number {
  if (tokensIn <= 0n || state.tokenReserve === 0n) return 0;
  const spot = spotPrice(state);
  if (spot === 0n) return 0;
  const executed = realizablePrice(state, tokensIn);
  const impact = ratio(spot - executed, spot);
  return Math.max(0, impact * 10_000);
}

/**
 * Slippage of an achieved fill against the marginal price at the time, in bps.
 *
 * Signed as adverse-positive: a buy that filled above spot and a sell that filled below
 * spot both report a positive number. Recorded on every fill in both modes, so paper
 * slippage can be compared against live slippage without re-deriving a convention.
 */
export function fillSlippageBps(spot: bigint, executed: bigint, side: 'buy' | 'sell'): number {
  if (spot === 0n) return 0;
  const diff = executed > spot ? executed - spot : spot - executed;
  const magnitude = ratio(diff, spot) * 10_000;
  const adverse = side === 'buy' ? executed > spot : executed < spot;
  return adverse ? magnitude : -magnitude;
}
