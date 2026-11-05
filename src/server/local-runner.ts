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
  writes: Promise<void>;
};

/** One OpenDots writer. The same runner supports SQLite or remote history. */
export class LocalAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private active = new Map<string, Active>();
  private seen = new Set<string>();
  readonly ready: Promise<void>;
  constructor(private workspace: WorkspaceStore) {
    super();
    this.ready = this.recover();
    void this.ready.catch(() => {}); // Operations below surface readiness failures.
  }
  private async recover() {
    const history = this.workspace.localHistory;
    for (const row of await history.interrupted(
      this.workspace.conversations().map((t) => t.id),
    )) {
      await history.append(row.threadId, row.runId, {
        type: EventType.RUN_ERROR,
        message:
          'Server restarted during this run. Review any completed actions before retrying.',
      });
      await history.finish(row.threadId, row.runId, 'interrupted');
    }
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent } = request;
    this.workspace.requireThread(threadId, agent.agentId);
    if (this.active.has(threadId))
      throw new Error('Conversation already running.');
    const key = `${threadId}:${request.input.runId}`;
    if (this.seen.has(key)) throw new Error('Run ID already used.');
    this.seen.add(key);
    const events = new Subject<BaseEvent>();
    let resolveDone!: () => void;
    const active: Active = {
      agent,
      events,
      runId: request.input.runId,
      stopped: false,
      writes: Promise.resolve(),
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
    };
    this.active.set(threadId, active);
    queueMicrotask(() => {
      void this.execute(request, active).finally(resolveDone);
    });
    return events.asObservable();
  }
  private async execute(request: AgentRunnerRunRequest, active: Active) {
    const { threadId, agent } = request;
    const history = this.workspace.localHistory;
    const runId = request.input.runId;
    let begun = false;
    let persistenceFailed = false;
    let terminal: BaseEvent | undefined;
    const queue = (action: () => void | Promise<void>) => {
      active.writes = active.writes.then(action);
      void active.writes.catch(() => {
        persistenceFailed = true;
        active.agent.abortRun();
      });
    };
    try {
      await this.ready;
      const saved = await history.snapshot(threadId);
      const messages = [...saved.messages];
      const ids = new Set(messages.map((m) => m.id));
      const resolved = new Set(
        messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
      );
      const pending = new Set(
        messages.flatMap((m) =>
          m.role === 'assistant'
            ? (m.toolCalls ?? [])
                .map((t) => t.id)
                .filter((id) => !resolved.has(id))
            : [],
        ),
      );
      for (const message of request.input.messages) {
        if (
          ids.has(message.id) ||
          (message.role !== 'user' &&
            !(message.role === 'tool' && pending.has(message.toolCallId)))
        )
          continue;
        messages.push(message);
        ids.add(message.id);
      }
      const input = { ...request.input, messages, state: saved.state };
      await history.begin(threadId, runId);
      begun = true;
      await history.save(threadId, messages, saved.state);
      if (active.stopped) throw new Error('Stopped.');
      agent.threadId = threadId;
      agent.setMessages(messages);
      agent.setState(saved.state);
      const save = () => {
        const snapshot = structuredClone({
          messages: agent.messages,
          state: agent.state,
        });
        queue(() => history.save(threadId, snapshot.messages, snapshot.state));
      };
      await agent.runAgent(input, {
        onEvent: ({ event }) => {
          if (
            event.type === EventType.RUN_ERROR ||
            event.type === EventType.RUN_FINISHED
          ) {
            terminal = event;
            return;
          }
          const copy = structuredClone(event);
          queue(async () => {
            await history.append(threadId, runId, copy);
            active.events.next(copy);
          });
        },
        onMessagesChanged: save,
        onStateChanged: save,
      });
      save();
      await active.writes;
      const failed = terminal?.type === EventType.RUN_ERROR;
      const ending = active.stopped
        ? {
            type: EventType.RUN_ERROR,
            message: 'Run stopped. Review completed actions before retrying.',
          }
        : (terminal ?? { type: EventType.RUN_FINISHED, threadId, runId });
      await history.append(threadId, runId, ending);
      await history.finish(
        threadId,
        runId,
        active.stopped ? 'stopped' : failed ? 'failed' : 'completed',
      );
      // Success is released only after the selected history store acknowledges it.
      active.events.next(ending);
    } catch {
      const event = {
        type: EventType.RUN_ERROR,
        message: persistenceFailed
          ? 'BC-250 history write failed. The run is not confirmed saved; review effects before retrying.'
          : 'Run interrupted. Check history availability and review completed actions before retrying.',
      };
      try {
        await active.writes.catch(() => {});
        if (begun) {
          await history.append(threadId, runId, event);
          await history.finish(threadId, runId, 'failed');
        }
      } catch {
        /* No local fallback and no automatic re-execution. */
      }
      active.events.next(event);
    } finally {
      this.active.delete(threadId);
      active.events.complete();
    }
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.workspace.requireThread(request.threadId, request.agentId);
    return new Observable((subscriber) => {
      const current = this.active.get(request.threadId);
      let subscription: { unsubscribe(): void } | undefined;
      const snapshot = async () => {
        await this.ready;
        const saved = await this.workspace.localHistory.snapshot(
          request.threadId,
        );
        if (subscriber.closed) return;
        subscriber.next({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: saved.messages,
        });
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: saved.state,
        });
        if (current) subscription = current.events.subscribe(subscriber);
        else subscriber.complete();
      };
      // Snapshot and subscription share the event-write barrier: no replayed
      // deltas already included in the snapshot and no gap before subscription.
      const operation = current
        ? (current.writes = current.writes.then(snapshot))
        : snapshot();
      void operation.catch((error) => {
        subscription?.unsubscribe();
        subscriber.error(error);
      });
      return () => subscription?.unsubscribe();
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
  async getThreadMessages(threadId: string): Promise<Message[]> {
    this.workspace.requireThread(threadId);
    await this.ready;
    return (await this.workspace.localHistory.snapshot(threadId)).messages;
  }
  async getThreadEvents(threadId: string) {
    this.workspace.requireThread(threadId);
    await this.ready;
    return this.workspace.localHistory.events(threadId);
  }
  async getThreadState(threadId: string) {
    this.workspace.requireThread(threadId);
    await this.ready;
    return (await this.workspace.localHistory.snapshot(threadId)).state;
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
