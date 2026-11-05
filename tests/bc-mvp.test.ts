import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createBcService } from '../src/server/bc-service.js';
import { bcFetch } from '../src/server/bc-fetch.js';
import { RemoteHistory } from '../src/server/remote-history.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import { ConnectionService } from '../src/server/connections.js';
import { connectionRoutes } from '../src/server/connection-routes.js';
import { connectionTools } from '../src/server/connection-tools.js';
import {
  executeCli,
  installCliConnections,
  readCliConfig,
  type CliConfig,
} from '../src/server/cli-connection.js';
import { completion } from './fixtures/model-stream.js';

const root = mkdtempSync(join(tmpdir(), 'opendots-bc-mvp-'));
const cert = join(root, 'test-cert.pem');
const key = join(root, 'test-key.pem');
const token = 'synthetic-test-token-'.repeat(3);
const cleanups: (() => Promise<void> | void)[] = [];
beforeAll(() => {
  const gitOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
  execFileSync(
    process.platform === 'win32' && existsSync(gitOpenSSL)
      ? gitOpenSSL
      : 'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}, 20000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
// All files below are synthetic. No login or live model is used by this suite.
const close = (server: Server | ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
async function fixture(
  path = join(root, `history-${Math.random()}.sqlite`),
  modelUrl?: string,
) {
  const server = createBcService({
    database: path,
    token,
    tls: { cert: readFileSync(cert), key: readFileSync(key) },
    modelUrl,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test address.');
  const url = `https://127.0.0.1:${address.port}`;
  const transport = bcFetch(url, cert);
  cleanups.push(() => (server.listening ? close(server) : undefined));
  return {
    server,
    path,
    url,
    transport,
    history: new RemoteHistory(url, token, transport),
  };
}
it('requires authenticated, trusted TLS; rejects redirects/origin changes and stores history only on the server across restart', async () => {
  let f = await fixture();
  expect((await f.transport(`${f.url}/health`)).status).toBe(401);
  await expect(fetch(`${f.url}/health`)).rejects.toThrow();
  await expect(f.transport('https://example.com/health')).rejects.toThrow(
    'origin denied',
  );
  const wrong = new RemoteHistory(f.url, 'wrong-token-'.repeat(4), f.transport);
  await expect(wrong.snapshot('thread')).rejects.toThrow('401');
  await f.history.begin('thread', 'run');
  await f.history.save(
    'thread',
    [{ id: 'u', role: 'user', content: 'Synthetic restart marker' }],
    { saved: true },
  );
  await f.history.append('thread', 'run', { type: EventType.RUN_STARTED });
  await f.history.finish('thread', 'run', 'completed');
  await expect(f.history.begin('thread', 'run')).rejects.toThrow('503');
  await close(f.server);
  f = await fixture(f.path);
  expect((await f.history.snapshot('thread')).messages[0].content).toBe(
    'Synthetic restart marker',
  );
  expect(await f.history.events('thread')).toHaveLength(1);
  const localPath = join(root, `local-${Math.random()}.sqlite`);
  const workspace = new WorkspaceStore(localPath, 'owner', f.history);
  workspace.close();
  const local = new DatabaseSync(localPath);
  expect(
    local
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'local_chat_%'")
      .all(),
  ).toEqual([]);
  local.close();
});
it('proxies only the selected Qwen model and never exposes upstream admin APIs', async () => {
  let hits = 0;
  const upstream = createServer(async (req, res) => {
    hits++;
    let text = '';
    for await (const part of req) text += part;
    expect(JSON.parse(text).model).toBe('agente');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: synthetic\n\n');
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  cleanups.push(() => close(upstream));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('No upstream.');
  const f = await fixture(undefined, `http://127.0.0.1:${addr.port}/v1/`);
  const call = (path: string, body?: unknown) =>
    f.transport(`${f.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  expect((await call('/slots')).status).toBe(404);
  expect((await call('/v1/chat/completions', { model: 'other' })).status).toBe(
    403,
  );
  expect(
    await (
      await call('/v1/chat/completions', { model: 'agente', stream: true })
    ).text(),
  ).toContain('synthetic');
  expect(hits).toBe(1);
});
function fakeCli(): CliConfig {
  const script = join(root, `worker-${Math.random()}.cjs`);
  writeFileSync(
    script,
    `let task='';process.stdin.on('data',d=>task+=d);process.stdin.on('end',()=>{if(process.env.BC250_TOKEN||process.env.OPENAI_API_KEY)process.exit(9); const text='EXECUTED: '+task; if(process.argv.includes('exec'))console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})); else console.log(JSON.stringify({result:text,is_error:false}));});`,
  );
  return {
    corporateAuthorized: false,
    timeoutMs: 3000,
    commands: {
      codex: [process.execPath, script],
      claude: [process.execPath, script],
    },
    projects: {
      fixture: { path: root, classification: 'synthetic', access: 'read-only' },
    },
  };
}
it('delegates through the existing MCP approval route, forces approval, retains disabled tools and never reexecutes an approved receipt', async () => {
  const config = fakeCli();
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Synthetic');
  installCliConnections(workspace.connections, [dot.id], config);
  const service = new ConnectionService(
    workspace.connections,
    undefined,
    undefined,
    true,
    config,
  );
  for (const tool of service.tools(dot.id))
    expect(tool.tool.requiresApproval).toBe(true);
  const codex = service
    .tools(dot.id)
    .find((t) => t.connection.name === 'codex')!;
  service.setTool(codex.connection.id, 'delegate', { requiresApproval: false });
  expect(service.resolve(dot.id, codex.name).tool.requiresApproval).toBe(true);
  const tool = connectionTools(
    service,
    dot.id,
    'thread',
    () => {},
    new AbortController().signal,
    true,
  ).find((t) => t.name === codex.name)!;
  const gated = (await tool.execute!(
    { project: 'fixture', task: 'SYNTHETIC_OK' },
    {} as never,
  )) as { approvalId: string };
  expect(gated).toMatchObject({ status: 'approval_required' });
  const routes = connectionRoutes(workspace, service);
  const approve = () =>
    routes.request('/conversations/thread/connection-actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: gated.approvalId, toolCallId: 'tc' }),
    });
  const result = await (await approve()).json();
  expect(result).toMatchObject({
    isError: false,
    text: 'EXECUTED: SYNTHETIC_OK',
  });
  expect(await (await approve()).json()).toEqual(result);
  service.setTool(codex.connection.id, 'delegate', { enabled: false });
  installCliConnections(workspace.connections, [dot.id], config);
  expect(service.tools(dot.id).some((t) => t.connection.name === 'codex')).toBe(
    false,
  );
});
it('rejects unknown/corporate projects and strips OpenDots provider secrets from CLI processes', async () => {
  const config = fakeCli();
  await expect(
    executeCli(
      'codex',
      config,
      'unknown',
      'Task',
      new AbortController().signal,
    ),
  ).rejects.toThrow('denied');
  config.projects.fixture.classification = 'corporate';
  await expect(
    executeCli(
      'claude',
      config,
      'fixture',
      'Task',
      new AbortController().signal,
    ),
  ).rejects.toThrow('denied');
  const file = join(root, 'corporate.json');
  writeFileSync(file, JSON.stringify(config));
  expect(() => readCliConfig(file)).toThrow('company authorization');
  config.projects.fixture.classification = 'synthetic';
  vi.stubEnv('OPENAI_API_KEY', 'test-secret');
  vi.stubEnv('BC250_TOKEN', 'test-secret');
  try {
    expect(
      await executeCli(
        'claude',
        config,
        'fixture',
        'SAFE',
        new AbortController().signal,
      ),
    ).toMatchObject({ isError: false, text: 'EXECUTED: SAFE' });
  } finally {
    vi.unstubAllEnvs();
  }
});
it('uses remote history through the real runner and never reports a finished turn when persistence fails', async () => {
  const f = await fixture();
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner', f.history);
  const p = new Platform(store, workspace, {
    conversationStorage: 'local',
    localOnly: true,
    localModelHosts: ['bc250-server.local'],
    baseUrl: 'http://bc250-server.local:11434/v1',
    apiKey: 'local',
    model: 'agente',
    runtimeUrl: '',
    voiceName: '',
    slackUsers: [],
  });
  cleanups.push(async () => {
    await p.stop();
    workspace.close();
    store.close();
  });
  const thread = await p.createConversation(
    workspace.dots()[0].id,
    'Synthetic',
  );
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(completion({ role: 'assistant', content: 'REMOTE_OK' }));
  // History uses the dedicated HTTPS transport, not the mocked model transport.
  expect(
    await p.turn(thread.id, 'Synthetic', new AbortController().signal),
  ).toBe('REMOTE_OK');
  expect(
    (await f.history.snapshot(thread.id)).messages.some(
      (m) => m.content === 'REMOTE_OK',
    ),
  ).toBe(true);
  await close(f.server);
  await expect(
    p.turn(thread.id, 'Must fail', new AbortController().signal),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});
