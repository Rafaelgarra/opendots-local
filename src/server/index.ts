import { bcFetch } from './bc-fetch.js';
import { RemoteHistory } from './remote-history.js';
import { readCliConfig } from './cli-connection.js';
import { serverTls } from './tls.js';
import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import {
  agentRunTimeoutMsFromEnv,
  intelligenceApiKeyFromEnv,
  intelligenceWsUrlFromEnv,
  type PlatformConfig,
} from './platform-config.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const tls = serverTls(process.env, host, process.env.LOCAL_ONLY !== 'false');
const protocol = tls ? 'https' : 'http';
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const bcUrl = process.env.BC250_URL;
if (bcUrl && process.env.LOCAL_ONLY === 'false')
  throw new Error(
    'MVP BC-250 mode requires LOCAL_ONLY=true; native CLI connections are explicitly scoped exceptions.',
  );
const bcTransport = bcUrl
  ? bcFetch(bcUrl, process.env.BC250_CA_FILE ?? '')
  : undefined;
const remoteHistory =
  bcUrl && bcTransport
    ? new RemoteHistory(bcUrl, process.env.BC250_TOKEN ?? '', bcTransport)
    : undefined;
if (remoteHistory && process.env.CONVERSATION_STORAGE === 'intelligence')
  throw new Error(
    'BC-250 history requires local conversation mode, without Intelligence.',
  );
const cli = process.env.CLI_CONFIG_FILE
  ? readCliConfig(process.env.CLI_CONFIG_FILE)
  : undefined;
if (cli?.corporateAuthorized && process.env.BC250_COMPANY_AUTHORIZED !== 'true')
  throw new Error(
    'Corporate CLI projects require explicit company authorization for BC-250.',
  );
if (
  process.env.BC250_DATA_CLASS === 'corporate' &&
  process.env.BC250_COMPANY_AUTHORIZED !== 'true'
)
  throw new Error(
    'Explicit company authorization is required for corporate data on BC-250.',
  );
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
  remoteHistory,
);
const conversationStorage = process.env.CONVERSATION_STORAGE ?? 'local';
if (!['local', 'intelligence'].includes(conversationStorage))
  throw new Error('CONVERSATION_STORAGE must be local or intelligence.');
const config: PlatformConfig = {
  cli,
  bcFetch: bcTransport,
  conversationStorage: conversationStorage as 'local' | 'intelligence',
  localOnly: process.env.LOCAL_ONLY !== 'false',
  localModelHosts: (
    process.env.LOCAL_MODEL_HOSTS ??
    'localhost,127.0.0.1,[::1],bc250-server.local'
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  intelligenceKey: intelligenceApiKeyFromEnv(process.env),
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: intelligenceWsUrlFromEnv(process.env),
  apiKey: bcUrl ? process.env.BC250_TOKEN : process.env.OPENAI_API_KEY,
  model: bcUrl ? 'agente' : process.env.OPENAI_MODEL,
  baseUrl:
    (bcUrl ? `${bcUrl.replace(/\/$/, '')}/v1` : process.env.OPENAI_BASE_URL) ??
    'https://api.openai.com/v1',
  agentRunTimeoutMs: agentRunTimeoutMsFromEnv(process.env),
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  composioApiKey: process.env.COMPOSIO_API_KEY || undefined,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `${protocol}://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
};
const platform = new Platform(store, workspace, config);
await platform.localRunner?.ready;
const researchConfig = {
  mode: 'live' as const,
  apiKey: platform.config.apiKey,
  model: platform.config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: platform.config.webSearchProvider,
  parallelApiKey: platform.config.parallelApiKey,
  browserUrl: platform.config.browserUrl,
  browserSecret: platform.config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no bound conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its saved conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal, {
      opendotsSource: 'scheduled_task',
    });
    return { text, sources: [], sample: false };
  },
  config.agentRunTimeoutMs,
);
const wsOrigin =
  conversationStorage === 'local'
    ? ''
    : new URL(
        platform.config.intelligenceWsUrl ??
          'wss://realtime.intelligence.copilotkit.ai',
      ).origin;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve(
  { fetch: app.fetch, hostname: host, port, ...tls },
  (info) => {
    console.log(
      `OpenDots template listening on ${protocol}://${host}:${info.port}`,
    );
    runner.start();
    void platform
      .start()
      .catch((error) =>
        reportChannelFailure(
          'Slack Channels activation failed; check setup status',
          [safeFailure(error)],
        ),
      );
  },
);
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
