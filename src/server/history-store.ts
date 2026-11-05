import type { BaseEvent, Message } from '@ag-ui/core';

type Awaitable<T> = T | Promise<T>;
export interface HistorySnapshot {
  messages: Message[];
  state: Record<string, unknown>;
}
/** Same history operations, with either SQLite or an authenticated remote store. */
export interface HistoryStore {
  snapshot(threadId: string): Awaitable<HistorySnapshot>;
  save(threadId: string, messages: Message[], state: unknown): Awaitable<void>;
  begin(threadId: string, runId: string): Awaitable<void>;
  finish(threadId: string, runId: string, status: string): Awaitable<void>;
  append(threadId: string, runId: string, event: BaseEvent): Awaitable<void>;
  events(threadId: string): Awaitable<BaseEvent[]>;
  interrupted(
    threadIds: string[],
  ): Awaitable<{ threadId: string; runId: string }[]>;
}
