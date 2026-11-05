import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConnectionStore } from './connection-store.js';

const project = z.object({
  path: z.string(),
  classification: z.enum(['synthetic', 'corporate']),
  access: z.enum(['read-only', 'workspace-write']).default('read-only'),
});
const cliConfig = z
  .object({
    corporateAuthorized: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(600_000).default(540_000),
    commands: z
      .object({
        codex: z.array(z.string()).min(1),
        claude: z.array(z.string()).min(1),
      })
      .partial(),
    projects: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), project),
  })
  .strict();
export type CliConfig = z.infer<typeof cliConfig>;
export type CliWorker = 'codex' | 'claude';
export function readCliConfig(path: string): CliConfig {
  const config = cliConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!Object.keys(config.projects).length)
    throw new Error('Configure at least one CLI project.');
  for (const item of Object.values(config.projects)) {
    if (!isAbsolute(item.path))
      throw new Error('CLI project paths must be absolute.');
    item.path = realpathSync(item.path);
    if (!statSync(item.path).isDirectory())
      throw new Error('CLI project directory missing.');
    if (item.classification === 'corporate' && !config.corporateAuthorized)
      throw new Error(
        'Corporate projects require explicit company authorization before BC-250 use.',
      );
  }
  for (const command of Object.values(config.commands)) {
    if (
      !command ||
      !isAbsolute(command[0]) ||
      /\.(cmd|bat|ps1)$/i.test(command[0])
    )
      throw new Error(
        'Use an absolute native executable, or node.exe plus the Codex JS entry; no shell wrappers.',
      );
    if (!statSync(command[0]).isFile())
      throw new Error('CLI executable missing.');
  }
  return config;
}
export const cliUrl = (worker: CliWorker) => `opendots-internal://${worker}`;
export function cliWorker(url: string): CliWorker | undefined {
  return url === cliUrl('codex')
    ? 'codex'
    : url === cliUrl('claude')
      ? 'claude'
      : undefined;
}
function schema(config: CliConfig) {
  return z
    .object({
      project: z.enum(Object.keys(config.projects) as [string, ...string[]]),
      task: z.string().trim().min(1).max(16000),
    })
    .strict();
}
export function installCliConnections(
  store: ConnectionStore,
  dotIds: string[],
  config: CliConfig,
) {
  for (const dotId of dotIds)
    for (const worker of ['codex', 'claude'] as const) {
      if (!config.commands[worker]) continue;
      const tools = [
        {
          name: 'delegate',
          title: `Delegate to ${worker}`,
          description: `Execute an owner-approved task using the authenticated ${worker} CLI on this OpenDots PC. Projects: ${Object.keys(config.projects).join(', ')}.`,
          inputSchema: z.toJSONSchema(schema(config)),
          readOnly: false,
          enabled: true,
          requiresApproval: true,
        },
      ];
      const existing = store.list(dotId).find((c) => c.url === cliUrl(worker));
      if (!existing)
        store.create(dotId, { name: worker, url: cliUrl(worker) }, tools);
      else
        store.saveTools(
          existing.id,
          tools.map((t) => ({
            ...t,
            enabled:
              existing.tools.find((p) => p.name === t.name)?.enabled ?? false,
          })),
        );
    }
}
/** Thin MCP adapter in the OpenDots process. No listener, daemon or new agent loop. */
export function cliTransport(
  worker: CliWorker,
  config: CliConfig,
  signal: AbortSignal,
) {
  const server = new McpServer({
    name: `opendots-${worker}`,
    version: '1.0.0',
  });
  server.registerTool(
    'delegate',
    {
      description: `Delegate to ${worker}. Owner approval is enforced by OpenDots.`,
      inputSchema: schema(config),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => {
      const result = await executeCli(
        worker,
        config,
        args.project,
        args.task,
        signal,
      );
      return {
        isError: result.isError,
        content: [{ type: 'text' as const, text: result.text }],
      };
    },
  );
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  void server.connect(serverSide);
  const close = client.close.bind(client);
  client.close = async () => {
    await close();
    await server.close();
  };
  return client;
}
export async function executeCli(
  worker: CliWorker,
  config: CliConfig,
  projectId: string,
  task: string,
  signal: AbortSignal,
) {
  const target = config.projects[projectId];
  const command = config.commands[worker];
  if (
    !target ||
    !command ||
    (target.classification === 'corporate' && !config.corporateAuthorized)
  )
    throw new Error('CLI project denied.');
  // Recheck canonical paths at execution, not only at startup.
  if (realpathSync(target.path) !== target.path)
    throw new Error('Project path changed.');
  const writable = target.access === 'workspace-write';
  const args =
    worker === 'codex'
      ? [
          'exec',
          '--json',
          '--sandbox',
          writable ? 'workspace-write' : 'read-only',
          '--cd',
          target.path,
          '-',
        ]
      : [
          '-p',
          '--output-format',
          'json',
          '--permission-mode',
          'dontAsk',
          '--allowedTools',
          writable ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
          '--tools',
          writable ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
        ];
  const env = { ...process.env };
  // Preserve each CLI's saved subscription auth; never send OpenDots service keys.
  for (const name of Object.keys(env))
    if (
      /^(OPENAI_|ANTHROPIC_API_KEY$|BC250_|BC_|OWNER_TOKEN$|INTELLIGENCE_|CPK_|COMPOSIO_|PARALLEL_|VOICE_)/.test(
        name,
      )
    )
      delete env[name];
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(config.timeoutMs),
  ]);
  bounded.throwIfAborted();
  return new Promise<{ isError: boolean; text: string }>((resolve) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd: target.path,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let killed = false;
    const stop = () => {
      if (killed) return;
      killed = true;
      // Kill only this child's tree on Windows; shell text is never generated.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => child.kill());
      } else child.kill('SIGTERM');
    };
    bounded.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024) stop();
      else output += data;
    });
    // Never expose stderr: startup diagnostics can include credentials or paths.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => {
      bounded.removeEventListener('abort', stop);
      resolve({
        isError: true,
        text: 'CLI could not start. Verify installation and subscription login on this PC.',
      });
    });
    child.once('close', (code) => {
      bounded.removeEventListener('abort', stop);
      if (killed) {
        resolve({
          isError: true,
          text: 'CLI interrupted or output limit reached. Review project effects before retrying; nothing was automatically retried.',
        });
        return;
      }
      try {
        let text = '';
        let failed = code !== 0;
        if (worker === 'claude') {
          const result = JSON.parse(output);
          failed ||= !!result.is_error;
          text = typeof result.result === 'string' ? result.result : '';
        } else {
          for (const line of output.split(/\r?\n/).filter(Boolean)) {
            const event = JSON.parse(line);
            if (
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message'
            )
              text += `${event.item.text}\n`;
            if (event.type === 'turn.failed' || event.type === 'error')
              failed = true;
          }
        }
        resolve({
          isError: failed || !text.trim(),
          text:
            text.trim().slice(-20000) ||
            'CLI returned no confirmed result. Verify authentication and review project effects before retrying.',
        });
      } catch {
        resolve({
          isError: true,
          text: 'CLI output format was not recognized. Review project effects before retrying.',
        });
      }
    });
    child.stdin.end(task);
  });
}
