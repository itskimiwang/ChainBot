/**
 * Fixed-point helpers over bigint.
 *
 * Every amount that touches a contract stays a bigint from decode to encode. Floats
 * appear only where a value is about to be rendered or compared against a percentage
 * threshold, and never on the path that computes a trade size.
 */

export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`cannot parse "${value}" as a decimal amount`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const result = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  return negative ? -result : result;
}

export function formatUnits(value: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0');
  if (maxFractionDigits < decimals) fraction = fraction.slice(0, maxFractionDigits);
  fraction = fraction.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** Lossy on purpose: display and threshold comparisons only. */
export function toNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

export function bpsOf(value: bigint, bps: number | bigint): bigint {
  return (value * BigInt(bps)) / 10_000n;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  return (a + b - 1n) / b;
}

/**
 * Division rounded to nearest, ties away from zero.
 *
 * Flooring a derived quantity biases it one way every single time. On a fixed-point
 * price that shows up as a phantom loss on every position the moment it opens, so
 * anything we derive ourselves (as opposed to mirroring contract arithmetic, which must
 * truncate exactly as the contract does) rounds instead.
 */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  const negative = a < 0n !== b < 0n;
  const [absA, absB] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const quotient = (absA + absB / 2n) / absB;
  return negative ? -quotient : quotient;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Ratio of two bigints as a float. Scales through an intermediate to keep precision when
 * the operands differ by many orders of magnitude, which curve reserves routinely do.
 */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  const SCALE = 1_000_000_000_000n;
  return Number((numerator * SCALE) / denominator) / Number(SCALE);
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Gini coefficient of a value distribution. 0 is perfectly even, approaching 1 means one
 * participant holds everything. Used on per-buyer volume to detect the wash-trade shape
 * where "many trades" is really one actor.
 */
export function gini(values: number[]): number {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = positive.length;
  if (n === 0) return 0;
  if (n === 1) return 1;

  let total = 0;
  let weighted = 0;
  for (const [i, v] of positive.entries()) {
    total += v;
    weighted += v * (i + 1);
  }
  if (total === 0) return 0;
  return clamp01((2 * weighted) / (n * total) - (n + 1) / n);
}
