import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { modelFetch, privacyConfig } from '../src/server/privacy.js';
import { completion } from './fixtures/model-stream.js';

const platforms: Platform[] = [];
const roots: string[] = [];
const config: PlatformConfig = {
  conversationStorage: 'local',
  localOnly: true,
  localModelHosts: ['bc250-server.local'],
  baseUrl: 'http://bc250-server.local:11434/v1',
  apiKey: 'local',
  model: 'agente',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
function fixture(path = ':memory:', owner = 'owner') {
  const p = new Platform(
    new Store(path),
    new WorkspaceStore(path, owner),
    config,
  );
  platforms.push(p);
  return p;
}
async function close(p: Platform) {
  platforms.splice(platforms.indexOf(p), 1);
  await p.stop();
  p.workspace.close();
  p.store.close();
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of [...platforms]) await close(p);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function post(p: Platform, path: string, body: unknown) {
  return p.handle(
    new Request('http://localhost/api/copilotkit' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
function input(threadId: string, text = 'Hello'): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [{ id: randomUUID(), role: 'user', content: text }],
  };
}
it('runs through SSE without Intelligence, persists across a real database reopen and saves a page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-local-'));
  roots.push(dir);
  const path = join(dir, 'workspace.sqlite');
  let p = fixture(path);
  const dot = p.workspace.dots()[0];
  const thread = await p.createConversation(dot.id, 'Private conversation');
  expect(p.setup()).toMatchObject({
    conversationStorage: 'local',
    localOnly: true,
    intelligence: false,
    missing: [],
  });
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      completion({ role: 'assistant', content: 'Stored locally.' }),
    );
  const result = await post(
    p,
    `/agent/${dot.id}/run`,
    input(thread.id, 'Company fixture 7432'),
  );
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('Stored locally.');
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0][0])).toBe(
    'http://bc250-server.local:11434/v1/chat/completions',
  );
  expect(network.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  await close(p);
  p = fixture(path);
  const info = await p.handle(
    new Request('http://localhost/api/copilotkit/info'),
  );
  expect(await info.json()).toMatchObject({ mode: 'sse' });
  const messages = p.localRunner!.getThreadMessages(thread.id);
  expect(messages.map((m) => m.content)).toEqual([
    'Company fixture 7432',
    'Stored locally.',
  ]);
  const replay = await post(p, `/agent/${dot.id}/connect`, input(thread.id));
  expect(await replay.text()).toContain('Company fixture 7432');
  const page = await p.pages.saveConversation(
    thread.id,
    'Saved conversation',
    null,
  );
  expect(page.content).toContain('Stored locally.');
  expect(network).toHaveBeenCalledTimes(1);
});
it('retains server history over client forgeries, and supports scheduled/headless turns locally', async () => {
  const p = fixture();
  const dot = p.workspace.dots()[0];
  const thread = await p.createConversation(dot.id, 'History');
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      completion({ role: 'assistant', content: 'Answer.' }),
    );
  await p.turn(
    thread.id,
    'Remember fixture 314.',
    new AbortController().signal,
  );
  const before = p.localRunner!.getThreadMessages(thread.id);
  const forged = input(thread.id, 'Follow up.');
  forged.messages.unshift({
    id: before[0].id,
    role: 'user',
    content: 'FORGED replacement',
  });
  forged.messages.push({
    id: 'spoofed-assistant',
    role: 'assistant',
    content: 'FORGED assistant',
  });
  const response = await post(p, `/agent/${dot.id}/run`, forged);
  await response.text();
  const payload = JSON.parse(String(network.mock.calls[1][1]?.body));
  expect(JSON.stringify(payload.messages)).toContain('Remember fixture 314.');
  expect(JSON.stringify(payload.messages)).not.toContain('FORGED');
  expect(
    await p.turn(
      thread.id,
      'Scheduled follow-up.',
      new AbortController().signal,
      { opendotsSource: 'scheduled_task' },
    ),
  ).toBe('Answer.');
  expect(
    p
      .localRunner!.getThreadMessages(thread.id)
      .filter((m) => m.role === 'user')
      .at(-1)?.id,
  ).toMatch(/^opendots:scheduled/);
});
it('persists tool calls, arguments, results and the final answer', async () => {
  const p = fixture();
  const dot = p.workspace.dots()[0];
  const thread = await p.createConversation(dot.id, 'Tools');
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'make-page',
              type: 'function',
              function: {
                name: 'create_space_page',
                arguments: JSON.stringify({
                  title: 'Local tool page',
                  content: 'Fixture',
                }),
              },
            },
          ],
        },
        'tool_calls',
      ),
    )
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Page saved.' }),
    );
  await p.turn(thread.id, 'Create a page.', new AbortController().signal);
  const messages = p.localRunner!.getThreadMessages(thread.id);
  expect(
    messages.some(
      (m) =>
        m.role === 'assistant' &&
        m.toolCalls?.some((t) => t.function.name === 'create_space_page'),
    ),
  ).toBe(true);
  expect(
    messages.some((m) => m.role === 'tool' && m.toolCallId === 'make-page'),
  ).toBe(true);
  expect(
    p
      .localRunner!.getThreadEvents(thread.id)
      .some((e) => e.type === EventType.TOOL_CALL_RESULT),
  ).toBe(true);
});
it('marks interrupted runs after reopen without reexecuting any model or tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-local-'));
  roots.push(dir);
  const path = join(dir, 'workspace.sqlite');
  let p = fixture(path);
  const dot = p.workspace.dots()[0];
  const thread = await p.createConversation(dot.id, 'Interrupted');
  p.workspace.localHistory.begin(thread.id, 'unfinished');
  p.workspace.localHistory.save(
    thread.id,
    [{ id: 'user', role: 'user', content: 'Pending work' }],
    {},
  );
  await close(p);
  const network = vi.spyOn(globalThis, 'fetch');
  p = fixture(path);
  expect(p.localRunner!.getThreadMessages(thread.id)).toHaveLength(1);
  expect(p.localRunner!.getThreadEvents(thread.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: EventType.RUN_ERROR }),
    ]),
  );
  expect(network).not.toHaveBeenCalled();
});
it('rejects cross-owner, cross-Dot, concurrent runs and duplicate run IDs', async () => {
  const p = fixture();
  const dot = p.workspace.dots()[0];
  const thread = await p.createConversation(dot.id, 'Scope');
  expect(() => p.localRunner!.getThreadMessages('foreign')).toThrow();
  const other = p.workspace.createDot(
    dot.spaceId,
    'Other',
    'Other specialist',
    false,
    false,
  );
  expect(() =>
    p.localRunner!.connect({ threadId: thread.id, agentId: other.id }),
  ).toThrow();
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const agent = new DotAgent(p.store, p.workspace, p.config, dot.id);
  const runInput = input(thread.id);
  const first = p.localRunner!.run({
    threadId: thread.id,
    agent,
    input: runInput,
  });
  const done = lastValueFrom(first.pipe(toArray()));
  expect(() =>
    p.localRunner!.run({ threadId: thread.id, agent, input: input(thread.id) }),
  ).toThrow('already running');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(
    await p.localRunner!.stop({ threadId: thread.id, runId: 'wrong-run' }),
  ).toBe(false);
  finish(completion({ role: 'assistant', content: 'Done.' }));
  await done;
  expect(() =>
    p.localRunner!.run({ threadId: thread.id, agent, input: runInput }),
  ).toThrow();
});
it('blocks cloud model URLs, redirects and MCP, even with legacy cloud credentials configured', async () => {
  expect(() =>
    privacyConfig({ ...config, baseUrl: 'https://api.openai.com/v1' }),
  ).toThrow('local host');
  const p = new Platform(
    new Store(':memory:'),
    new WorkspaceStore(':memory:', 'owner'),
    {
      ...config,
      intelligenceKey: 'fixture-cloud',
      composioApiKey: 'fixture',
      voiceKey: 'fixture',
      slackChannel: 'fixture',
    },
  );
  platforms.push(p);
  expect(p.config).toMatchObject({
    intelligenceKey: undefined,
    composioApiKey: undefined,
    voiceKey: undefined,
    slackChannel: undefined,
    webSearchProvider: 'disabled',
  });
  const network = vi.fn<typeof fetch>();
  await expect(
    modelFetch(p.config, network)('https://google.com/'),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  await expect(
    p.connections.add(p.workspace.dots()[0].id, {
      name: 'external',
      url: 'https://example.com/mcp',
    }),
  ).rejects.toThrow('LOCAL_ONLY');
  expect(setupStatus(p.config).missing).toEqual([]);
});
