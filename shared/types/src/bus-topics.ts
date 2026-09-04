import type {
  CurveTradeEvent,
  DeployerScore,
  ExitSignal,
  Fill,
  GraduationEvent,
  NewLaunchEvent,
  Position,
  TradeIntent,
  VettingResult,
  WalletSignal,
} from './events.js';

/**
 * The wiring between phases. Each service declares the topics it publishes and consumes,
 * so a service can be developed and tested against this map alone rather than against
 * the services on either side of it.
 */
export interface BusTopics {
  'launch.new': NewLaunchEvent;
  'launch.trade': CurveTradeEvent;
  'launch.graduated': GraduationEvent;
  'vetting.result': VettingResult;
  'deployer.score': DeployerScore;
  'wallet.signal': WalletSignal;
  'trade.intent': TradeIntent;
  'trade.fill': Fill;
  'exit.signal': ExitSignal;
  'position.update': Position;
  'alert.notify': { level: 'info' | 'warn' | 'error'; title: string; body: string };
}

export type BusTopic = keyof BusTopics;
