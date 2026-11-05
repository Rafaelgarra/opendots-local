import {
  AgentRunner,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerStopRequest,
  type AgentRunnerIsRunningRequest,
} from '@copilotkit/runtime/v2';
import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { Observable, Subject } from 'rxjs';
import type { WorkspaceStore } from './workspace.js';

type Active = {
  agent: AgentRunnerRunRequest['agent'];
  runId: string;
  events: Subject<BaseEvent>;
  done: Promise<void>;
  stopped: boolean;
};

/** Single-server durable SSE runner. Browser disconnection never retries work. */
export class LocalAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private active = new Map<string, Active>();
  constructor(private workspace: WorkspaceStore) {
    super();
    for (const row of workspace.localHistory.interrupted(
      workspace.conversations().map((t) => t.id),
    )) {
      workspace.localHistory.append(row.threadId, row.runId, {
        type: EventType.RUN_ERROR,
        message:
          'Server restarted during this run. Review any completed actions before retrying.',
      });
      workspace.localHistory.finish(row.threadId, row.runId, 'interrupted');
    }
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent } = request;
    this.workspace.requireThread(threadId, agent.agentId);
    if (this.active.has(threadId))
      throw new Error('Conversation already running.');
    const history = this.workspace.localHistory;
    const saved = history.snapshot(threadId);
    // Previously persisted messages are authoritative. Clients can append user
    // messages or results for outstanding browser tools, never forge assistants.
    const messages = [...saved.messages];
    const ids = new Set(messages.map((m) => m.id));
    const resolved = new Set(
      saved.messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
    );
    const pending = new Set(
      saved.messages.flatMap((m) =>
        m.role === 'assistant'
          ? (m.toolCalls ?? [])
              .map((t) => t.id)
              .filter((id) => !resolved.has(id))
          : [],
      ),
    );
    for (const message of request.input.messages) {
      if (ids.has(message.id)) continue;
      if (
        message.role !== 'user' &&
        !(message.role === 'tool' && pending.has(message.toolCallId))
      )
        continue;
      messages.push(message);
      ids.add(message.id);
    }
    const input = { ...request.input, messages, state: saved.state };
    history.begin(threadId, input.runId);
    history.save(threadId, messages, saved.state);
    agent.threadId = threadId;
    agent.setMessages(messages);
    agent.setState(saved.state);
    const events = new Subject<BaseEvent>();
    let resolveDone!: () => void;
    const active: Active = {
      agent,
      events,
      runId: input.runId,
      stopped: false,
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
    };
    this.active.set(threadId, active);
    queueMicrotask(() => {
      void (async () => {
        let failed = false;
        let terminal = false;
        const emit = (event: BaseEvent) => {
          history.append(threadId, input.runId, event);
          events.next(event);
        };
        const save = () => history.save(threadId, agent.messages, agent.state);
        try {
          await agent.runAgent(input, {
            onEvent: ({ event }) => {
              if (event.type === EventType.RUN_ERROR) failed = true;
              if (
                event.type === EventType.RUN_ERROR ||
                event.type === EventType.RUN_FINISHED
              )
                terminal = true;
              emit(event);
            },
            onMessagesChanged: save,
            onStateChanged: save,
          });
          save();
          if (!terminal)
            emit(
              active.stopped
                ? {
                    type: EventType.RUN_ERROR,
                    message:
                      'Run stopped. Review completed actions before retrying.',
                  }
                : {
                    type: EventType.RUN_FINISHED,
                    threadId,
                    runId: input.runId,
                  },
            );
        } catch {
          failed = true;
          // Keep errors generic: provider exceptions may contain private data.
          if (!terminal)
            emit({
              type: EventType.RUN_ERROR,
              message:
                'Run interrupted. Your local conversation remains saved.',
            });
        } finally {
          history.finish(
            threadId,
            input.runId,
            active.stopped ? 'stopped' : failed ? 'failed' : 'completed',
          );
          this.active.delete(threadId);
          events.complete();
          resolveDone();
        }
      })();
    });
    return events.asObservable();
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.workspace.requireThread(request.threadId, request.agentId);
    return new Observable((subscriber) => {
      const saved = this.workspace.localHistory.snapshot(request.threadId);
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: saved.messages,
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: saved.state,
      });
      const current = this.active.get(request.threadId);
      if (current) return current.events.subscribe(subscriber);
      subscriber.complete();
    });
  }
  async isRunning({ threadId }: AgentRunnerIsRunningRequest) {
    this.workspace.requireThread(threadId);
    return this.active.has(threadId);
  }
  async stop({ threadId, runId }: AgentRunnerStopRequest) {
    this.workspace.requireThread(threadId);
    const current = this.active.get(threadId);
    if (!current || current.stopped || (runId && current.runId !== runId))
      return false;
    current.stopped = true;
    current.agent.abortRun();
    return true;
  }
  listThreads() {
    return this.workspace.conversations().map((t) => ({
      id: t.id,
      name: t.title,
      agentId: t.dotId,
      organizationId: 'local',
      createdById: t.ownerId,
      archived: false,
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.createdAt).toISOString(),
    }));
  }
  getThreadMessages(threadId: string): Message[] {
    this.workspace.requireThread(threadId);
    return this.workspace.localHistory.snapshot(threadId).messages;
  }
  getThreadEvents(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.workspace.localHistory.events(threadId);
  }
  getThreadState(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.workspace.localHistory.snapshot(threadId).state;
  }
  clearThreads(): void {
    throw new Error('Bulk deletion is disabled for durable local history.');
  }
  async shutdown() {
    const current = [...this.active.entries()];
    for (const [threadId] of current) await this.stop({ threadId });
    await Promise.all(current.map(([, run]) => run.done));
  }
}
