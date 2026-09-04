import { z } from 'zod';

/**
 * Addresses are normalised to lowercase everywhere inside the pipeline. Checksummed
 * strings only exist at the edges (config, explorer links, tx construction) — comparing
 * mixed-case addresses is a class of bug that silently mismatches wallets against
 * themselves, which in the deployer graph would split a cluster in two.
 */
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
  .transform((a) => a.toLowerCase() as Address);

export type Address = `0x${string}`;

export const HashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte hex hash')
  .transform((h) => h.toLowerCase() as Hash);

export type Hash = `0x${string}`;

/**
 * Every on-chain amount crosses service boundaries as a base-unit decimal string, never
 * as a JS number. Curve reserves routinely exceed 2^53 and a float would quietly corrupt
 * position sizing. Decode to bigint at the point of use.
 */
export const BaseUnitsSchema = z.string().regex(/^\d+$/, 'expected base units as a decimal string');

export const UnixMsSchema = z.number().int().nonnegative();

export const BpsSchema = z.number().int().min(0).max(10_000);

/** A 0..1 confidence or ratio. */
export const UnitIntervalSchema = z.number().min(0).max(1);

export const TradingModeSchema = z.enum(['paper', 'live']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

/**
 * Where a launch sits in the Pons V2 lifecycle. Mirrors the factory's `phase` field,
 * which the docs call the authoritative signal — it must not be inferred from balances
 * or from having seen an event, because a missed log would silently mis-route a sell.
 */
export const LaunchPhaseSchema = z.enum(['curve', 'swept', 'pool', 'rescued']);
export type LaunchPhase = z.infer<typeof LaunchPhaseSchema>;

export const LAUNCH_PHASE_BY_INDEX: Record<number, LaunchPhase> = {
  0: 'curve',
  1: 'swept',
  2: 'pool',
  3: 'rescued',
};

export const QuoteAssetSchema = z.object({
  symbol: z.string(),
  address: AddressSchema,
  decimals: z.number().int().min(0).max(36),
  isNative: z.boolean().default(false),
  /** Base units of this asset that a curve must take in before it graduates. */
  graduationThreshold: BaseUnitsSchema.nullable().default(null),
  /** Virtual reserve that sets the opening price. Pricing input; never withdrawable. */
  phantomQuote: BaseUnitsSchema.nullable().default(null),
});
export type QuoteAsset = z.infer<typeof QuoteAssetSchema>;
