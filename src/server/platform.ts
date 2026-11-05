import { LocalAgentRunner } from './local-runner.js';
import { privacyConfig } from './privacy.js';
import { EventType, type Message } from '@ag-ui/core';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';
import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { currentTurnText, runThreadTurn } from './headless.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { SetupTelemetry } from './setup-telemetry.js';
export class Platform {
  private channelStartupFailed = false;
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly localRunner?: LocalAgentRunner;
  readonly intelligence?: CopilotKitIntelligence;
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.config = config = privacyConfig(config);
    this.setupTelemetry = new SetupTelemetry(store);
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(
      workspace.connections,
      undefined,
      undefined,
      config.localOnly,
    );
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      if (this.localRunner)
        return {
          getOrCreateThread: async (input) => {
            if (
              input.userId !== workspace.ownerId ||
              !workspace.dot(input.agentId)
            )
              throw new Error('Conversation scope denied.');
          },
          getThreadMessages: async (input) => {
            if (input.userId !== workspace.ownerId)
              throw new Error('Conversation scope denied.');
            return {
              messages: this.localRunner!.getThreadMessages(input.threadId),
            };
          },
        };
      return this.intelligence!;
    });
    if (config.conversationStorage === 'local') {
      this.localRunner = new LocalAgentRunner(workspace);
      const runtime = new CopilotRuntime({
        runner: this.localRunner,
        agents: async () =>
          Object.fromEntries(
            workspace
              .dots()
              .map((dot) => [
                dot.id,
                new DotAgent(
                  store,
                  workspace,
                  config,
                  dot.id,
                  false,
                  this.setupTelemetry,
                ),
              ]),
          ),
      });
      this.handler = createCopilotHonoHandler({
        runtime,
        basePath: '/api/copilotkit',
        cors: { origin: [] },
      });
      return;
    }
    if (!config.intelligenceKey) return;
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
      getLearningContainerId: learningSelector(
        workspace,
        config.slackDotId ?? workspace.dots()[0]?.id,
      ),
    });
    const channels = [];
    if (config.slackChannel && config.slackTeam && config.slackUsers.length) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            this.setupTelemetry,
          ),
      });
      channels.push(slack);
    }
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(
                store,
                workspace,
                config,
                dot.id,
                false,
                this.setupTelemetry,
              ),
            ]),
        ),
      channels,
      generateThreadNames: true,
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Configure the selected conversation storage and model.`,
      );
  }
  async start() {
    this.setupTelemetry.start();
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        this.setupTelemetry.capture({
          kind: 'setup_failed',
          step: 'settings',
          error_class: 'channel_start_failed',
        });
        throw error;
      }
    }
  }
  async stop() {
    await this.localRunner?.shutdown();
    await this.setupTelemetry.stop();
    await this.handler?.channels?.stop();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    if (this.localRunner) return this.workspace.bindThread(id, dotId, title);
    try {
      await this.intelligence!.createThread({
        threadId: id,
        userId: this.workspace.ownerId,
        agentId: dotId,
        name: title,
      });
    } catch {
      throw new Error(
        'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
    return this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = this.localRunner
      ? { messages: this.localRunner.getThreadMessages(threadId) }
      : await this.intelligence!.getThreadMessages({
          threadId,
          userId: this.workspace.ownerId,
        });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json(
        { error: `Setup required: ${INTELLIGENCE_KEY_MISSING_LABEL}.` },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    if (this.localRunner) {
      signal.throwIfAborted();
      const agent = new DotAgent(
        this.store,
        this.workspace,
        this.config,
        thread.dotId,
        false,
        this.setupTelemetry,
      );
      const prefix =
        metadata?.opendotsSource === 'voice_receipt'
          ? voiceReceiptMessagePrefix
          : metadata?.opendotsSource === 'scheduled_task'
            ? scheduledTaskMessagePrefix
            : '';
      const message = {
        id: `${prefix}${randomUUID()}`,
        role: 'user',
        content: prompt,
        ...(metadata ? { metadata } : {}),
      } as Message;
      return new Promise<string>((resolve, reject) => {
        let runError: Error | undefined;
        const abort = () => {
          void this.localRunner!.stop({ threadId });
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          this.localRunner!.run({
            threadId,
            agent,
            input: {
              threadId,
              runId: randomUUID(),
              messages: [message],
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
            },
          }).subscribe({
            next: (event) => {
              if (event.type === EventType.RUN_ERROR)
                runError = new Error(
                  String(
                    (event as { message?: string }).message ??
                      'Run interrupted.',
                  ),
                );
            },
            error: (error) => {
              signal.removeEventListener('abort', abort);
              reject(error);
            },
            complete: () => {
              signal.removeEventListener('abort', abort);
              try {
                signal.throwIfAborted();
                resolve(currentTurnText(agent.messages, runError));
              } catch (error) {
                reject(error);
              }
            },
          });
        } catch (error) {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      });
    }
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
