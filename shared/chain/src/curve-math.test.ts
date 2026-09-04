import { describe, expect, it } from 'vitest';
import {
  amountIn,
  amountOut,
  fillSlippageBps,
  graduationProgress,
  quoteBuy,
  quoteSell,
  realizablePrice,
  sellImpactBps,
  spotPrice,
  type CurveState,
} from './curve-math.js';

const ETH = 10n ** 18n;

/**
 * A curve part-way up: 1 ETH of real quote against a 4.2 ETH threshold, with the phantom
 * reserve folded into the pricing quote reserve the way `getReserves()` reports it.
 */
function curve(overrides: Partial<CurveState> = {}): CurveState {
  return {
    quoteReserve: 2n * ETH,
    tokenReserve: 700_000_000n * ETH,
    sellableTokens: 500_000_000n * ETH,
    feeBps: 100n,
    creatorTaxBps: 0n,
    realQuoteReserve: 1n * ETH,
    graduationThreshold: 42n * ETH / 10n,
    ...overrides,
  };
}

describe('constant-product primitives', () => {
  it('prices out against the product invariant', () => {
    // 1 in, 10 reserve in, 100 reserve out -> 100 * 1 / 11
    expect(amountOut(1n, 10n, 100n)).toBe(9n);
  });

  it('returns zero for a non-positive input rather than throwing', () => {
    expect(amountOut(0n, 10n, 100n)).toBe(0n);
    expect(amountOut(-5n, 10n, 100n)).toBe(0n);
    expect(amountIn(0n, 10n, 100n)).toBe(0n);
  });

  it('rounds the required input up, so a quote is never short by a wei', () => {
    // The +1 in amountIn is what keeps a computed input from landing just under the
    // amount the contract actually requires.
    const required = amountIn(9n, 10n, 100n);
    expect(amountOut(required, 10n, 100n)).toBeGreaterThanOrEqual(9n);
  });

  it('refuses to price a withdrawal of the entire output reserve', () => {
    expect(() => amountIn(100n, 10n, 100n)).toThrow(/exceeds reserve/);
  });
});

describe('quoteBuy', () => {
  it('takes fees off the input before pricing, so a buy moves price less than its spend', () => {
    const state = curve({ feeBps: 100n, creatorTaxBps: 0n });
    const withFee = quoteBuy(state, ETH, 0n);
    const withoutFee = quoteBuy(curve({ feeBps: 0n, creatorTaxBps: 0n }), ETH, 0n);

    expect(withFee.feePaid).toBe(ETH / 100n);
    expect(withFee.tokensOut).toBeLessThan(withoutFee.tokensOut);

    // The tokens actually bought correspond to the post-fee input, not the gross spend.
    const net = ETH - withFee.feePaid;
    expect(withFee.tokensOut).toBe(amountOut(net, state.quoteReserve, state.tokenReserve));
  });

  it('charges the creator tax on top of the protocol fee', () => {
    const quote = quoteBuy(curve({ creatorTaxBps: 300n }), ETH, 0n);
    expect(quote.feePaid).toBe(ETH / 100n);
    expect(quote.taxPaid).toBe((ETH * 300n) / 10_000n);
  });

  it('caps the snipe tax so a buyer always nets at least one percent of spend', () => {
    const state = curve({ feeBps: 100n, creatorTaxBps: 300n });
    // Ask for an absurd snipe tax; the contract clamps it to 10000 - 100 - 300 - 100.
    const quote = quoteBuy(state, ETH, 9_900n);

    const expectedBps = 10_000n - 100n - 300n - 100n;
    expect(quote.snipeTaxPaid).toBe((ETH * expectedBps) / 10_000n);

    const netToCurve = quote.spent - quote.feePaid - quote.taxPaid - quote.snipeTaxPaid;
    expect(netToCurve).toBeGreaterThanOrEqual(ETH / 100n);
    expect(quote.tokensOut).toBeGreaterThan(0n);
  });

  it('returns an empty quote for a non-positive input', () => {
    const quote = quoteBuy(curve(), 0n, 0n);
    expect(quote).toMatchObject({ tokensOut: 0n, spent: 0n, refund: 0n, clamped: false });
  });

  describe('when the buy crosses the reserved allocation', () => {
    // A tiny allocation next to a large spend: the fill has to stop at the edge.
    const state = curve({ sellableTokens: 1_000n * ETH });
    const quote = quoteBuy(state, 100n * ETH, 0n);

    it('fills to the edge rather than over it', () => {
      expect(quote.clamped).toBe(true);
      expect(quote.tokensOut).toBe(state.sellableTokens);
    });

    it('refunds the unspent remainder', () => {
      expect(quote.spent).toBeLessThan(100n * ETH);
      expect(quote.refund).toBe(100n * ETH - quote.spent);
    });

    it('charges fees on what was actually spent, not on what was offered', () => {
      expect(quote.feePaid).toBe((quote.spent * state.feeBps) / 10_000n);
    });

    it('never spends more than was offered', () => {
      // The gross-up divides by (1 - fees), so a rounding slip here would overspend.
      const tight = quoteBuy(curve({ sellableTokens: 1n }), 5n, 0n);
      expect(tight.spent).toBeLessThanOrEqual(5n);
    });
  });
});

describe('quoteSell', () => {
  it('prices the trade first and takes fees off the output', () => {
    const state = curve({ feeBps: 100n, creatorTaxBps: 200n });
    const tokens = 1_000_000n * ETH;
    const quote = quoteSell(state, tokens);

    const gross = amountOut(tokens, state.tokenReserve, state.quoteReserve);
    expect(quote.grossQuote).toBe(gross);
    expect(quote.feePaid).toBe((gross * 100n) / 10_000n);
    expect(quote.taxPaid).toBe((gross * 200n) / 10_000n);
    expect(quote.quoteOut).toBe(gross - quote.feePaid - quote.taxPaid);
  });

  it('returns less than a mirrored buy would suggest', () => {
    // Fees on the way in and on the way out mean a round trip cannot break even. Pricing
    // a sell as the inverse of a buy is the mistake this asserts against.
    const state = curve();
    const buy = quoteBuy(state, ETH, 0n);

    const after: CurveState = {
      ...state,
      quoteReserve: state.quoteReserve + (buy.spent - buy.feePaid - buy.taxPaid),
      tokenReserve: state.tokenReserve - buy.tokensOut,
    };
    const sell = quoteSell(after, buy.tokensOut);

    expect(sell.quoteOut).toBeLessThan(buy.spent);
  });

  it('returns an empty quote for a non-positive input', () => {
    expect(quoteSell(curve(), 0n)).toMatchObject({ quoteOut: 0n, grossQuote: 0n });
  });
});

describe('marks', () => {
  it('derives spot from the pricing reserves, including the phantom balance', () => {
    const state = curve({ quoteReserve: 2n * ETH, tokenReserve: 1_000_000n * ETH });
    expect(spotPrice(state)).toBe((2n * ETH * ETH) / (1_000_000n * ETH));
  });

  it('reports zero spot on an empty curve rather than dividing by zero', () => {
    expect(spotPrice(curve({ tokenReserve: 0n }))).toBe(0n);
    expect(realizablePrice(curve(), 0n)).toBe(0n);
  });

  it('marks a position below spot, because selling it moves the price', () => {
    const state = curve();
    const held = 50_000_000n * ETH;
    expect(realizablePrice(state, held)).toBeLessThan(spotPrice(state));
  });

  it('marks a larger position further below spot than a smaller one', () => {
    // This is what makes the mark honest on a thin curve: size has a price.
    const state = curve();
    const small = realizablePrice(state, 1_000_000n * ETH);
    const large = realizablePrice(state, 200_000_000n * ETH);
    expect(large).toBeLessThan(small);
  });
});

describe('graduationProgress', () => {
  it('measures collected quote against the threshold, ignoring the phantom reserve', () => {
    // quoteReserve is 2 ETH but only 1 ETH was actually contributed.
    expect(graduationProgress(curve())).toBeCloseTo(1 / 4.2, 6);
  });

  it('clamps to one once the threshold is met or passed', () => {
    expect(graduationProgress(curve({ realQuoteReserve: 5n * ETH }))).toBe(1);
  });

  it('returns zero when no threshold is configured', () => {
    expect(graduationProgress(curve({ graduationThreshold: 0n }))).toBe(0);
  });
});

describe('sellImpactBps', () => {
  it('grows with size', () => {
    const state = curve();
    expect(sellImpactBps(state, 100_000_000n * ETH)).toBeGreaterThan(sellImpactBps(state, 1_000_000n * ETH));
  });

  it('is smaller on a deeper curve for the same size', () => {
    // The whole premise of the depth-aware stop: identical sells mean different things
    // at different reserve levels.
    const thin = curve({ quoteReserve: 1n * ETH, tokenReserve: 900_000_000n * ETH });
    const deep = curve({ quoteReserve: 20n * ETH, tokenReserve: 900_000_000n * ETH });
    const size = 50_000_000n * ETH;

    expect(sellImpactBps(deep, size)).toBeLessThan(sellImpactBps(thin, size));
  });

  it('is never negative, and is zero for an empty sell or an empty curve', () => {
    expect(sellImpactBps(curve(), 0n)).toBe(0);
    expect(sellImpactBps(curve({ tokenReserve: 0n }), 100n)).toBe(0);
    expect(sellImpactBps(curve(), 1n)).toBeGreaterThanOrEqual(0);
  });
});

describe('fillSlippageBps', () => {
  it('reports adverse fills as positive for both sides', () => {
    // Buying above spot and selling below spot are both bad, and must read the same way
    // or paper and live slippage cannot be compared.
    expect(fillSlippageBps(100n, 110n, 'buy')).toBeCloseTo(1000, 6);
    expect(fillSlippageBps(100n, 90n, 'sell')).toBeCloseTo(1000, 6);
  });

  it('reports favourable fills as negative for both sides', () => {
    expect(fillSlippageBps(100n, 90n, 'buy')).toBeCloseTo(-1000, 6);
    expect(fillSlippageBps(100n, 110n, 'sell')).toBeCloseTo(-1000, 6);
  });

  it('returns zero when there is no spot to compare against', () => {
    expect(fillSlippageBps(0n, 100n, 'buy')).toBe(0);
  });
});
