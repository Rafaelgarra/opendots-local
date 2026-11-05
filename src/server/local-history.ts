import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent, Message } from '@ag-ui/core';

/** Durable chat data shares the workspace database and its backup boundary. */
export class LocalHistory {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_chat_snapshots (
        threadId TEXT PRIMARY KEY, messages TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_chat_runs (
        threadId TEXT NOT NULL, runId TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(threadId, runId));
      CREATE UNIQUE INDEX IF NOT EXISTS local_chat_active
        ON local_chat_runs(threadId) WHERE status='running';
      CREATE TABLE IF NOT EXISTS local_chat_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL,
        runId TEXT NOT NULL, event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_chat_event_thread ON local_chat_events(threadId, seq);
    `);
  }
  snapshot(threadId: string): {
    messages: Message[];
    state: Record<string, unknown>;
  } {
    const row = this.db
      .prepare(
        'SELECT messages, state FROM local_chat_snapshots WHERE threadId=?',
      )
      .get(threadId);
    return row
      ? {
          messages: JSON.parse(String(row.messages)),
          state: JSON.parse(String(row.state)),
        }
      : { messages: [], state: {} };
  }
  save(threadId: string, messages: Message[], state: unknown) {
    this.db
      .prepare(
        'INSERT INTO local_chat_snapshots VALUES (?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET messages=excluded.messages, state=excluded.state',
      )
      .run(threadId, JSON.stringify(messages), JSON.stringify(state ?? {}));
  }
  begin(threadId: string, runId: string) {
    this.db
      .prepare("INSERT INTO local_chat_runs VALUES (?, ?, 'running')")
      .run(threadId, runId);
  }
  finish(threadId: string, runId: string, status: string) {
    this.db
      .prepare(
        'UPDATE local_chat_runs SET status=? WHERE threadId=? AND runId=?',
      )
      .run(status, threadId, runId);
  }
  append(threadId: string, runId: string, event: BaseEvent) {
    this.db
      .prepare(
        'INSERT INTO local_chat_events(threadId, runId, event) VALUES (?, ?, ?)',
      )
      .run(threadId, runId, JSON.stringify(event));
  }
  events(threadId: string): BaseEvent[] {
    return this.db
      .prepare(
        'SELECT event FROM local_chat_events WHERE threadId=? ORDER BY seq',
      )
      .all(threadId)
      .map((row) => JSON.parse(String(row.event)));
  }
  interrupted(threadIds: string[]): { threadId: string; runId: string }[] {
    const owned = new Set(threadIds);
    const rows = this.db
      .prepare(
        "SELECT threadId, runId FROM local_chat_runs WHERE status='running'",
      )
      .all();
    return rows
      .filter((row) => owned.has(String(row.threadId)))
      .map((row) => ({
        threadId: String(row.threadId),
        runId: String(row.runId),
      }));
  }
}
