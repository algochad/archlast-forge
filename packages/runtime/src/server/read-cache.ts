import type { Row } from "./db/types";

/** Thrown inside a read-only transaction that would combine cached rows with a database snapshot taken after a commit; the read re-runs. */
export class SnapshotMoved extends Error {}

/**
 * Rows of document reads, by statement and parameters, kept exactly up to date. Only valid in a process that is the database's only
 * writer (the local SQLite database with one function runtime): every write goes through this process's DocStore.
 *
 * Never stale, by construction:
 * - a table with uncommitted writes (a mutation running, or a group-commit batch not yet committed) is `pending`: nothing is read from or
 *   stored for it until those writes commit or roll back; then the entries whose topics they wrote are dropped (the same topics the query
 *   cache and subscriptions use, so a like on one post drops that post's count, not every count);
 * - a read uses an entry only if its table wasn't invalidated after the reading transaction's snapshot, and stores one under the same rule;
 * - a read-only transaction that used cached rows and then needs the database after a commit landed re-runs (`SnapshotMoved`), so one
 *   query never mixes two states.
 */
export class ReadCache {
  /** Each entry is tagged with the topics its statement read (as DocStore tracks them): a write drops only entries whose topics it wrote. */
  private entries = new Map<string, { rows: Row[]; topics: string[]; size: number }>();
  private byTopic = new Map<string, Set<string>>();
  /** When each table was last invalidated, on a counter shared by all tables. */
  private invalidatedAt = new Map<string, number>();
  /** Tables with writes not yet committed or rolled back, and how many transactions hold them. */
  private pending = new Map<string, number>();
  private clock = 0;
  private bytes = 0;

  constructor(
    private maxEntries = 20_000,
    private maxBytes = 32 * 2 ** 20,
  ) {}

  /** The current point on the invalidation counter: a transaction's snapshot stamp. */
  now() {
    return this.clock;
  }

  /** Whether `table`'s cached rows are the state as of `stamp`. */
  usable(table: string, stamp: number) {
    return !this.pending.has(table) && (this.invalidatedAt.get(table) ?? -1) <= stamp;
  }

  get(key: string, table: string, stamp: number): Row[] | undefined {
    if (!this.usable(table, stamp)) return undefined;
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key); // LRU bump
    this.entries.set(key, e);
    return e.rows;
  }

  set(key: string, table: string, rows: Row[], stamp: number, topics: string[]) {
    if (!this.usable(table, stamp)) return;
    let size = 64 + topics.length * 32;
    for (const r of rows) size += 48 + (typeof r.doc === "string" ? r.doc.length : 64);
    if (size > this.maxBytes / 8) return;
    this.remove(key);
    this.entries.set(key, { rows, topics, size });
    this.bytes += size;
    for (const t of topics) {
      let keys = this.byTopic.get(t);
      if (!keys) this.byTopic.set(t, (keys = new Set()));
      keys.add(key);
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
  }

  /** A transaction is about to write `table` (once per transaction and table): until it settles, the table is off limits. */
  writing(table: string) {
    this.pending.set(table, (this.pending.get(table) ?? 0) + 1);
    this.invalidatedAt.set(table, ++this.clock);
  }

  /** Drops every entry, after a write too broad to name its topics (a restore). */
  clear() {
    this.entries.clear();
    this.byTopic.clear();
    this.bytes = 0;
  }

  /** That transaction committed or rolled back; `topics` are those it wrote (a rolled-back one may pass them too: dropping more is safe). */
  settled(table: string, topics: Iterable<string>) {
    const n = (this.pending.get(table) ?? 1) - 1;
    if (n > 0) this.pending.set(table, n);
    else this.pending.delete(table);
    this.invalidatedAt.set(table, ++this.clock);
    for (const t of topics) {
      const keys = this.byTopic.get(t);
      if (keys) for (const key of [...keys]) this.remove(key);
    }
  }

  private remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.bytes -= e.size;
    for (const t of e.topics) {
      const keys = this.byTopic.get(t);
      keys?.delete(key);
      if (keys && !keys.size) this.byTopic.delete(t);
    }
  }
}
