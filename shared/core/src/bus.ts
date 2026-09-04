import { EventEmitter } from 'node:events';
import type { BusTopic, BusTopics } from '@rhc/types';
import { createLogger } from './logger.js';

/**
 * Typed pub/sub between services.
 *
 * The in-process implementation is the default because every service in this repo runs
 * in one composition root today. The interface is deliberately narrow — publish,
 * subscribe, a replay buffer — so a Redis Streams transport can be dropped in when the
 * services are split across hosts without touching a single service implementation.
 */
export interface MessageBus {
  publish<T extends BusTopic>(topic: T, payload: BusTopics[T]): void;
  subscribe<T extends BusTopic>(topic: T, handler: (payload: BusTopics[T]) => void | Promise<void>): () => void;
  /** Most recent messages on a topic, oldest first. Powers dashboard hydration. */
  recent<T extends BusTopic>(topic: T, limit?: number): Array<BusTopics[T]>;
  counts(): Record<string, number>;
}

const log = createLogger('bus');

export interface InProcessBusOptions {
  /** Messages retained per topic for replay. Bounded so a long run cannot leak memory. */
  bufferSize?: number;
}

export function createInProcessBus(options: InProcessBusOptions = {}): MessageBus {
  const bufferSize = options.bufferSize ?? 500;
  const emitter = new EventEmitter();
  // The listener count is unbounded by design: the tracker subscribes per token.
  emitter.setMaxListeners(0);

  const buffers = new Map<string, unknown[]>();
  const counts = new Map<string, number>();

  return {
    publish(topic, payload) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);

      let buf = buffers.get(topic);
      if (!buf) {
        buf = [];
        buffers.set(topic, buf);
      }
      buf.push(payload);
      if (buf.length > bufferSize) buf.splice(0, buf.length - bufferSize);

      emitter.emit(topic, payload);
    },

    subscribe(topic, handler) {
      const wrapped = (payload: unknown): void => {
        // A handler that throws must not abort delivery to the other subscribers, and an
        // async rejection must not surface as an unhandled rejection that kills the run.
        try {
          const result = handler(payload as never);
          if (result instanceof Promise) {
            result.catch((err: unknown) => log.error('async subscriber failed', { topic, err }));
          }
        } catch (err) {
          log.error('subscriber failed', { topic, err });
        }
      };
      emitter.on(topic, wrapped);
      return () => emitter.off(topic, wrapped);
    },

    recent(topic, limit = 50) {
      const buf = (buffers.get(topic) ?? []) as Array<BusTopics[typeof topic]>;
      return buf.slice(-limit);
    },

    counts() {
      return Object.fromEntries(counts);
    },
  };
}
