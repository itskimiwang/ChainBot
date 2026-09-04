import { toEventSelector, type AbiEvent } from 'viem';
import { createLogger } from '@rhc/core';
import { ponsV2CurveAbi, ponsV2FactoryAbi, ponsV2HookAbi, TOPIC0 } from './abi/pons-v2.js';

const log = createLogger('chain:topics');

/**
 * Guard against a silently broken listener.
 *
 * The pinned topic0 constants came from Pons and Bitquery documentation; the ABI strings
 * were transcribed by hand. If those two ever disagree — a renamed parameter type, a
 * dropped `indexed` — viem would compute a selector that matches no logs on chain, and
 * the bot would run indefinitely seeing zero launches while looking perfectly healthy.
 * Comparing them at boot converts that into a startup crash.
 */
export function assertTopicsMatchAbi(): void {
  const abiItems = [...ponsV2FactoryAbi, ...ponsV2CurveAbi, ...ponsV2HookAbi] as readonly { type: string }[];
  const events = abiItems.filter((item) => item.type === 'event') as unknown as AbiEvent[];

  const computed = new Map<string, string>();
  for (const event of events) computed.set(event.name, toEventSelector(event));

  const mismatches: string[] = [];
  for (const [name, pinned] of Object.entries(TOPIC0)) {
    const actual = computed.get(name);
    if (!actual) {
      mismatches.push(`${name}: pinned topic0 has no matching event in the ABI`);
    } else if (actual.toLowerCase() !== pinned.toLowerCase()) {
      mismatches.push(`${name}: ABI computes ${actual} but pinned value is ${pinned}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      'Pons ABI does not match pinned event topics. The listener would match no logs.\n  - ' +
        mismatches.join('\n  - '),
    );
  }

  log.info('event topic0 constants match ABI', { events: Object.keys(TOPIC0).length });
}
