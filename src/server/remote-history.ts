import type { BaseEvent, Message } from '@ag-ui/core';
import type { HistorySnapshot, HistoryStore } from './history-store.js';

/** No local history cache, replica, synchronization or automatic write retries. */
export class RemoteHistory implements HistoryStore {
  constructor(
    private url: string,
    private token: string,
    private transport: typeof fetch,
  ) {
    if (new URL(url).protocol !== 'https:' || token.length < 32)
      throw new Error(
        'Remote history requires HTTPS and a 32+ character token.',
      );
  }
  private async call<T>(op: string, body: unknown): Promise<T> {
    const result = await this.transport(
      `${this.url.replace(/\/$/, '')}/history/${op}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!result.ok)
      throw new Error(
        `BC-250 history unavailable (HTTP ${result.status}). No local fallback.`,
      );
    return (await result.json()) as T;
  }
  snapshot(threadId: string) {
    return this.call<HistorySnapshot>('snapshot', { threadId });
  }
  save(threadId: string, messages: Message[], state: unknown) {
    return this.call<void>('save', { threadId, messages, state });
  }
  begin(threadId: string, runId: string) {
    return this.call<void>('begin', { threadId, runId });
  }
  finish(threadId: string, runId: string, status: string) {
    return this.call<void>('finish', { threadId, runId, status });
  }
  append(threadId: string, runId: string, event: BaseEvent) {
    return this.call<void>('append', { threadId, runId, event });
  }
  events(threadId: string) {
    return this.call<BaseEvent[]>('events', { threadId });
  }
  interrupted(threadIds: string[]) {
    return this.call<{ threadId: string; runId: string }[]>('interrupted', {
      threadIds,
    });
  }
}
