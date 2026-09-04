/**
 * Structured logger with mandatory secret redaction.
 *
 * A funded hot wallet makes logs an exfiltration surface, so redaction lives in the
 * logger itself rather than at call sites. Anything that looks like a private key,
 * mnemonic, or bearer token is scrubbed before it can reach stdout or a log file, and
 * every value registered via `registerSecret` is masked wherever it appears.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const registeredSecrets = new Set<string>();

/**
 * Mask a known secret value everywhere it appears in log output. Call this for every
 * value read out of the environment that must never be printed.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) registeredSecrets.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  // Raw 32-byte private key, with or without the 0x prefix.
  [/\b(0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED_KEY_OR_HASH]'],
  // BIP-39 style mnemonics: twelve or more lowercase words in a row.
  [/\b(?:[a-z]{3,}\s+){11,23}[a-z]{3,}\b/g, '[REDACTED_MNEMONIC]'],
  [/\b[Bb]earer\s+[\w.\-]+/g, 'Bearer [REDACTED]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]'],
];

const SENSITIVE_KEY = /(private|secret|seed|mnemonic|passphrase|password|token|apikey|api_key|auth)/i;

/**
 * 32-byte hex is ambiguous: it matches both private keys and tx hashes, and blanket
 * redaction would make trade logs useless. Fields that are structurally hashes are
 * allow-listed by name so they survive, and everything else in that shape does not.
 */
const HASH_FIELD = /^(txHash|hash|blockHash|poolId|topic0|salt|.*Hash)$/;

export function redact(value: unknown, keyName?: string): unknown {
  if (value == null) return value;

  if (typeof value === 'string') {
    if (keyName && SENSITIVE_KEY.test(keyName)) return '[REDACTED]';
    let out = value;
    for (const secret of registeredSecrets) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    const skipHexRule = keyName != null && HASH_FIELD.test(keyName);
    for (const [pattern, replacement] of PATTERNS) {
      if (skipHexRule && replacement === '[REDACTED_KEY_OR_HASH]') continue;
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, k);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

type Sink = (record: LogRecord) => void;

const sinks: Sink[] = [];

export function addLogSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR == null;
const jsonLogs = process.env.LOG_FORMAT === 'json';

function emit(level: LogLevel, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const safeMsg = redact(msg) as string;
  const safeFields = fields ? (redact(fields) as Record<string, unknown>) : undefined;
  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    scope,
    msg: safeMsg,
    ...(safeFields ? { fields: safeFields } : {}),
  };

  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      // A failing sink must never take down the trading loop.
    }
  }

  if (jsonLogs) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }

  const time = record.time.slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor
    ? `${COLOR[level]}${tag}\x1b[0m \x1b[90m${time}\x1b[0m \x1b[1m${scope}\x1b[0m`
    : `${tag} ${time} ${scope}`;
  const tail = safeFields && Object.keys(safeFields).length > 0 ? ` ${formatFields(safeFields)}` : '';
  process.stdout.write(`${head} ${safeMsg}${tail}\n`);
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const dim = useColor ? '\x1b[90m' : '';
      const reset = useColor ? '\x1b[0m' : '';
      return `${dim}${k}=${reset}${s}`;
    })
    .join(' ');
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
