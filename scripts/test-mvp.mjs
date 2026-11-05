// Explicitly opt-in, synthetic-only live acceptance. Never uses company projects.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/server/server/store.js';
import { WorkspaceStore } from '../dist/server/server/workspace.js';
import { Platform } from '../dist/server/server/platform.js';
import { Runner } from '../dist/server/server/runner.js';
import { createApp } from '../dist/server/server/app.js';
import { bcFetch } from '../dist/server/server/bc-fetch.js';
import { RemoteHistory } from '../dist/server/server/remote-history.js';
import { readCliConfig } from '../dist/server/server/cli-connection.js';
import { connectionActionTool } from '../dist/server/shared/connection-types.js';

if (process.env.MVP_SYNTHETIC_TEST_APPROVED !== 'true')
  throw new Error(
    'Set MVP_SYNTHETIC_TEST_APPROVED=true to authorize only this synthetic test and its CLI approval cards.',
  );
const url = process.env.BC250_URL;
const token = process.env.BC250_TOKEN;
if (
  !url ||
  !token ||
  !process.env.BC250_CA_FILE ||
  !process.env.CLI_CONFIG_FILE
)
  throw new Error(
    'Configure BC250_URL, BC250_TOKEN, BC250_CA_FILE and CLI_CONFIG_FILE first.',
  );
const transport = bcFetch(url, process.env.BC250_CA_FILE);
const health = await transport(`${url.replace(/\/$/, '')}/health`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(5000),
});
if (!health.ok)
  throw new Error(
    'BC-250 authenticated HTTPS is not ready. No SSH fallback is used.',
  );
const reportFile = resolve('.opendots/mvp-acceptance.json');
mkdirSync(resolve('.opendots'), { recursive: true });
const verify = process.argv.includes('--verify');
const config = readCliConfig(process.env.CLI_CONFIG_FILE);
const previous = verify
  ? JSON.parse(readFileSync(reportFile, 'utf8'))
  : undefined;
const root =
  previous?.root ?? mkdtempSync(join(tmpdir(), 'opendots-mvp-acceptance-'));
if (!verify) {
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  writeFileSync(
    join(root, 'README.md'),
    'Synthetic OpenDots acceptance fixture. No company data.\n',
  );
}
const cli = {
  ...config,
  corporateAuthorized: false,
  projects: {
    synthetic: {
      path: root,
      classification: 'synthetic',
      access: 'workspace-write',
    },
  },
};
const database = join(root, 'workspace.sqlite');
const store = new Store(database);
const history = new RemoteHistory(url, token, transport);
const workspace = new WorkspaceStore(
  database,
  'synthetic-acceptance-owner',
  history,
);
const p = new Platform(store, workspace, {
  conversationStorage: 'local',
  localOnly: true,
  localModelHosts: [new URL(url).hostname],
  baseUrl: `${url.replace(/\/$/, '')}/v1`,
  apiKey: token,
  model: 'agente',
  bcFetch: transport,
  cli,
  agentRunTimeoutMs: 600000,
  runtimeUrl: '',
  voiceName: '',
  slackUsers: [],
});
const modelConfig = {
  mode: 'live',
  baseUrl: `${url}/v1`,
  apiKey: token,
  model: 'agente',
  webSearchProvider: 'disabled',
};
const runner = new Runner(store, modelConfig);
const ownerToken = randomUUID();
const app = createApp({
  store,
  runner,
  config: modelConfig,
  platform: p,
  ownerToken,
});
try {
  await p.localRunner.ready;
  if (verify) {
    const messages = await p.localRunner.getThreadMessages(previous.threadId);
    for (const result of previous.results) {
      if (!JSON.stringify(messages).includes(result.marker))
        throw new Error('Remote history marker missing after restart.');
      if (
        readFileSync(join(root, result.file), 'utf8').trim() !== result.marker
      )
        throw new Error('CLI artifact missing after restart.');
    }
    console.log(
      'Verified persisted conversation and both CLI artifacts after reopening OpenDots.',
    );
  } else {
    const dot = workspace.dots()[0];
    const thread = await p.createConversation(
      dot.id,
      'Synthetic MVP acceptance',
    );
    const report = { root, threadId: thread.id, results: [] };
    const run = async (messages) => {
      const response = await p.handle(
        new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            threadId: thread.id,
            runId: randomUUID(),
            state: {},
            tools: [connectionActionTool],
            context: [],
            forwardedProps: {},
            messages,
          }),
        }),
      );
      const stream = await response.text();
      if (!response.ok || stream.includes('"type":"RUN_ERROR"'))
        throw new Error(
          'OpenDots run failed. Inspect its synthetic remote history.',
        );
      return p.localRunner.getThreadMessages(thread.id);
    };
    for (const worker of ['codex', 'claude']) {
      const marker = `MVP_${worker.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
      const file = `${worker}-acceptance.txt`;
      console.log(`Asking Qwen to delegate a synthetic task to ${worker}.`);
      const messages = await run([
        {
          id: randomUUID(),
          role: 'user',
          content: `This is an explicitly authorized synthetic integration test. Use ${worker}__delegate with project synthetic to create ${file} containing exactly ${marker} plus a newline. Ask owner approval with request_connection_action and wait. Do not create pages or write the file yourself.`,
        },
      ]);
      const call = messages
        .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
        .findLast((t) => t.function.name === 'request_connection_action');
      if (!call)
        throw new Error(
          'Qwen did not request a CLI approval. Nothing was executed.',
        );
      const args = JSON.parse(call.function.arguments);
      const approval = workspace.connections.approval(args.approvalId);
      const connection =
        approval && workspace.connections.get(approval.connectionId);
      if (
        !approval ||
        connection?.name !== worker ||
        approval.arguments.project !== 'synthetic' ||
        typeof approval.arguments.task !== 'string' ||
        !approval.arguments.task.includes(marker)
      )
        throw new Error('Unexpected approval request. Nothing was executed.');
      const response = await app.request(
        `/api/conversations/${thread.id}/connection-actions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            approvalId: approval.id,
            toolCallId: call.id,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok || result.isError)
        throw new Error(
          `${worker} execution failed. Review synthetic project effects.`,
        );
      if (readFileSync(join(root, file), 'utf8').trim() !== marker)
        throw new Error('CLI claimed a result without the requested artifact.');
      await run([
        {
          id: randomUUID(),
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({ approved: true, ...result }),
        },
      ]);
      if (!JSON.stringify(await history.snapshot(thread.id)).includes(marker))
        throw new Error('Remote history does not contain the CLI result.');
      report.results.push({ worker, marker, file, artifactVerified: true });
      writeFileSync(reportFile, JSON.stringify(report, null, 2));
      console.log(
        `${worker}: approval, real artifact, return to OpenDots and BC history verified.`,
      );
    }
    console.log(
      'Run this script again with --verify after restarting OpenDots and the BC persistence service.',
    );
  }
} finally {
  await p.stop();
  workspace.close();
  store.close();
}
