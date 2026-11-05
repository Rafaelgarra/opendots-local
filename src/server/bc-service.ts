import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalHistory } from './local-history.js';
import type { BaseEvent, Message } from '@ag-ui/core';

const MAX_BODY = 8 * 1024 * 1024;
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(value))
    throw new Error('Invalid identifier.');
  return value;
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('JSON required.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('Object required.');
  return value as Record<string, unknown>;
}
function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
/** Only persistence and a fixed Qwen proxy live on BC-250. No CLI execution. */
export function createBcService(options: {
  database: string;
  token: string;
  tls: ServerOptions;
  modelUrl?: string;
  model?: string;
  modelToken?: string;
}) {
  if (options.token.length < 32)
    throw new Error('BC-250 token must have 32+ characters.');
  const upstream = new URL(options.modelUrl ?? 'http://127.0.0.1:11434/v1/');
  if (
    !['http:', 'https:'].includes(upstream.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)
  )
    throw new Error('Qwen upstream must be loopback.');
  if (options.database !== ':memory:')
    mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.database);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
  );
  const history = new LocalHistory(db);
  const server = createServer(options.tls, (req, res) => {
    void (async () => {
      const supplied = Buffer.from(
        req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      );
      const expected = Buffer.from(options.token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        reply(res, 401, { error: 'Unauthorized.' });
        return;
      }
      const path = req.url;
      if (req.method === 'GET' && path === '/health') {
        reply(res, 200, { ready: true });
        return;
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        const body = await json(req);
        if (body.model !== (options.model ?? 'agente')) {
          reply(res, 403, { error: 'Model denied.' });
          return;
        }
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const result = await fetch(
          new URL(
            'chat/completions',
            upstream.href.endsWith('/') ? upstream : `${upstream.href}/`,
          ),
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(600_000),
            ]),
            headers: {
              'content-type': 'application/json',
              ...(options.modelToken
                ? { Authorization: `Bearer ${options.modelToken}` }
                : {}),
            },
            body: JSON.stringify(body),
          },
        );
        if (!result.ok || !result.body) {
          reply(res, 502, { error: 'Qwen unavailable.' });
          return;
        }
        res.writeHead(200, {
          'content-type':
            result.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        await pipeline(Readable.fromWeb(result.body as never), res);
        return;
      }
      if (req.method !== 'POST' || !path?.startsWith('/history/')) {
        reply(res, 404, { error: 'Not found.' });
        return;
      }
      const body = await json(req);
      if (path === '/history/interrupted') {
        if (!Array.isArray(body.threadIds) || body.threadIds.length > 10_000)
          throw new Error('Invalid threads.');
        reply(res, 200, history.interrupted(body.threadIds.map(id)));
        return;
      }
      const threadId = id(body.threadId);
      switch (path) {
        case '/history/snapshot':
          reply(res, 200, history.snapshot(threadId));
          return;
        case '/history/events':
          reply(res, 200, history.events(threadId));
          return;
        case '/history/save':
          if (
            !Array.isArray(body.messages) ||
            !body.messages.every(
              (m) =>
                m &&
                typeof m === 'object' &&
                typeof m.id === 'string' &&
                ['user', 'assistant', 'system', 'developer', 'tool'].includes(
                  m.role,
                ),
            ) ||
            !body.state ||
            typeof body.state !== 'object' ||
            Array.isArray(body.state)
          )
            throw new Error('Invalid snapshot.');
          history.save(threadId, body.messages as Message[], body.state);
          break;
        case '/history/begin':
          history.begin(threadId, id(body.runId));
          break;
        case '/history/finish':
          if (
            !['stopped', 'failed', 'completed', 'interrupted'].includes(
              String(body.status),
            )
          )
            throw new Error('Invalid status.');
          history.finish(threadId, id(body.runId), String(body.status));
          break;
        case '/history/append':
          if (
            !body.event ||
            typeof body.event !== 'object' ||
            typeof (body.event as Record<string, unknown>).type !== 'string'
          )
            throw new Error('Invalid event.');
          history.append(threadId, id(body.runId), body.event as BaseEvent);
          break;
        default:
          reply(res, 404, { error: 'Not found.' });
          return;
      }
      reply(res, 200, null);
    })().catch(() =>
      reply(res, 503, {
        error: 'BC-250 operation failed. No automatic retry.',
      }),
    );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 620_000;
  server.on('close', () => db.close());
  return server;
}
