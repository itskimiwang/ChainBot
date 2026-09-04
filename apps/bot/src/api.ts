import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, jsonSafe, type AppConfig } from '@rhc/core';

const log = createLogger('api');

export type RouteHandler = (body: unknown) => unknown | Promise<unknown>;

/**
 * Operator HTTP API.
 *
 * Written directly on `node:http`. A framework would be more comfortable, but this is a
 * handful of read-only routes plus four control actions in a process that holds a funded
 * key, and the dependency budget is better spent elsewhere.
 *
 * Binds to loopback by default. The control routes can halt trading and liquidate
 * positions, so exposing this on a public interface without a proxy in front of it would
 * hand those buttons to anyone who can reach the port.
 */
export class OperatorApi {
  private readonly routes = new Map<string, RouteHandler>();
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private readonly config: AppConfig) {}

  get(path: string, handler: RouteHandler): void {
    this.routes.set(`GET ${path}`, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.routes.set(`POST ${path}`, handler);
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    const { host, port } = this.config.bot.api;

    this.server = createServer((req, res) => void this.handle(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });

    const url = `http://${host}:${port}`;
    log.info('operator api listening', { url });
    return { host, port, url };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    // The dashboard runs on its own dev-server port, so same-origin does not apply.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const handler = this.routes.get(key);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      const result = await handler(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jsonSafe(result)));
    } catch (err) {
      log.error('request failed', { path: url.pathname, err: (err as Error).message });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Control payloads are tiny; anything larger is not a legitimate request.
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
