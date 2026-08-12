/**
 * Test-only Kysely plugins for instrumenting a SPECIFIC query by shape
 * (`selectReferencesTable`), instead of a fixed delay on every query or a
 * boolean read off an outer promise. Three tools:
 * - `createQueryBarrierPlugin`: a rendezvous barrier for forcing two (or
 *   more) genuinely concurrent callers to interleave AT a specific query.
 * - `createQueryTimingPlugin`: records how long calls to a specific query
 *   actually took, for proving a lock blocked THAT query specifically (see
 *   its own doc comment for why this matters beyond a simple "still
 *   pending" check).
 * - `createQueryStartSignal`: resolves as soon as a specific query is SENT,
 *   for releasing a hand-held ADVISORY lock at the right moment instead of
 *   guessing a fixed setTimeout margin (see its own doc comment — this one
 *   was found necessary from a real full-suite failure, not just theory).
 * - `waitForLockWait`: polls `pg_stat_activity` for a REAL Postgres row
 *   lock wait (`FOR UPDATE`/`FOR SHARE`) — NOT a Kysely plugin, and NOT
 *   interchangeable with `createQueryStartSignal` (see its own doc comment
 *   for why reusing the query-emission signal for a row lock produces a
 *   false pass).
 *
 * Both replace the `ArtificialRaceWindowPlugin` copies that used to live
 * inline in panelMoveReservation.test.ts, panelReservationActions.test.ts
 * and panelManualReservation.test.ts (same class, defined three times). That
 * plugin delayed the *result* of every query by a fixed ~120ms — it widens
 * the window but doesn't target it, so under machine load a fixed delay can
 * still not be enough (see server/CLAUDE.md's "Deuda" note on the flaky
 * suite this caused). These tools have no timing assumption of their own.
 *
 * `createQueryBarrierPlugin` usage: build a `Kysely` instance whose `plugins` includes
 * `createQueryBarrierPlugin({ arity: 2, match })`, where `match` inspects
 * the query's `RootOperationNode` to identify the exact dangerous query
 * (e.g. "the SELECT joining reservation_nights and reservations"). Every
 * call to that query through this Kysely instance pauses after the DB has
 * returned a result, until `arity` calls are simultaneously waiting — then
 * all of them are released together.
 */
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, RootOperationNode } from 'kysely';
import type { PoolClient } from 'pg';

export interface QueryBarrierOptions {
  /** How many concurrent callers must reach the matched query before any of them proceeds. */
  arity: number;
  /** Identifies the query to pause on. Receives the pre-compiled AST node. */
  match: (node: RootOperationNode) => boolean;
}

export function createQueryBarrierPlugin(options: QueryBarrierOptions): KyselyPlugin {
  const { arity, match } = options;
  const markedQueryIds = new Set<string>();
  let waiters: Array<() => void> = [];

  return {
    transformQuery(args: PluginTransformQueryArgs) {
      if (match(args.node)) markedQueryIds.add(args.queryId.queryId);
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs) {
      const id = args.queryId.queryId;
      if (!markedQueryIds.has(id)) return args.result;
      markedQueryIds.delete(id);

      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length >= arity) {
          const toRelease = waiters;
          waiters = [];
          for (const release of toRelease) release();
        }
      });
      return args.result;
    },
  };
}

export interface QueryTiming {
  /** ms elapsed between the query being sent and its result coming back. */
  durationMs: number;
}

/**
 * Test-only Kysely plugin: records how long each call to a matched query
 * actually took (send-to-result), instead of inferring "it was blocked"
 * from an outer promise's settle time. Needed when a lock-holding
 * connection can make an UNRELATED later query block too (e.g. an INSERT
 * whose FK forces an implicit lock on the same row a raw `FOR UPDATE`
 * holder is sitting on) — that makes an outer "still not settled after N ms"
 * assertion pass even with the real guard removed, since something else
 * ends up blocking for roughly the same window by coincidence. Timing the
 * SPECIFIC query the guard is supposed to protect pins the proof to the
 * right place: the guard is what should make THIS query wait, not
 * eventually something else, somewhere else, in the same call.
 *
 * Usage: `const { plugin, timings } = createQueryTimingPlugin({ match })`,
 * attach `plugin`, then after the call assert on `timings` (one entry per
 * matched call, in order).
 */
export function createQueryTimingPlugin(options: { match: (node: RootOperationNode) => boolean }): {
  plugin: KyselyPlugin;
  timings: QueryTiming[];
} {
  const { match } = options;
  const startedAt = new Map<string, number>();
  const timings: QueryTiming[] = [];

  const plugin: KyselyPlugin = {
    transformQuery(args: PluginTransformQueryArgs) {
      if (match(args.node)) startedAt.set(args.queryId.queryId, Date.now());
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs) {
      const id = args.queryId.queryId;
      const start = startedAt.get(id);
      if (start !== undefined) {
        startedAt.delete(id);
        timings.push({ durationMs: Date.now() - start });
      }
      return args.result;
    },
  };

  return { plugin, timings };
}

/**
 * Test-only Kysely plugin: resolves `started` as soon as a matched query is
 * SENT (not when it returns) — a real signal for "the code under test has
 * reached the point that should now be waiting on a lock", instead of a
 * fixed `setTimeout` guess. Found necessary the hard way: a fixed
 * setTimeout margin (200-350ms) picked by hand for a single isolated run
 * turned out to be too tight under real load — 5 consecutive full-suite
 * runs (22 files, ~230s each) produced 2 false failures on the SAME
 * hand-lock test at the SAME assertion, the exact "delay fixed compitiendo
 * con velocidad de máquina variable" problem server/CLAUDE.md already
 * documents for `ArtificialRaceWindowPlugin` — just reintroduced in a
 * smaller, per-test form via the setTimeout before releasing the holder.
 *
 * Falls back to `fallbackMs` (default 3000) so a test doesn't hang forever
 * when the guard being tested is ABSENT (the target query then never gets
 * sent at all) — the test still proceeds and fails cleanly on whatever
 * assertion checks the guard's effect (e.g. `timings` staying empty),
 * rather than hitting vitest's own test timeout with a less specific error.
 */
export function createQueryStartSignal(options: {
  match: (node: RootOperationNode) => boolean;
  fallbackMs?: number;
}): { plugin: KyselyPlugin; started: Promise<void> } {
  const { match, fallbackMs = 3000 } = options;
  let resolveStarted: () => void;
  let settled = false;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      resolveStarted();
    }
  }, fallbackMs);
  // Don't hold the test process open just for this fallback timer.
  timer.unref?.();

  const plugin: KyselyPlugin = {
    transformQuery(args: PluginTransformQueryArgs) {
      if (!settled && match(args.node)) {
        settled = true;
        clearTimeout(timer);
        resolveStarted();
      }
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs) {
      return args.result;
    },
  };

  return { plugin, started };
}

/**
 * Polls `pg_stat_activity` until some OTHER connection (not in
 * `excludePids`) shows `wait_event_type = 'Lock'` AND its current `query`
 * text contains `queryContains`, or `timeoutMs` elapses. Returns whether it
 * actually observed that specific wait.
 *
 * NOT a Kysely plugin — for a REAL row lock (`FOR UPDATE`/`FOR SHARE`),
 * unlike an advisory lock, the query that takes it is emitted identically
 * whether or not the lock modifier is present; only Postgres knows whether
 * it's actually blocked. `createQueryStartSignal` (resolves when a query is
 * SENT) is the right tool for an advisory lock, whose OWN query
 * (`pg_advisory_xact_lock(...)`) simply never gets sent at all when the
 * guard is removed — but it is the WRONG tool here: reusing it for a
 * FOR UPDATE test produced a false pass (verified by hand — see
 * server/CLAUDE.md's concurrency-test lesson on this exact failure mode).
 *
 * `queryContains` is REQUIRED, not optional, for the same reason: a bare
 * "is ANYTHING waiting on a lock" check produced its OWN false pass on the
 * first version of this helper — with the `.forUpdate()` guard removed, the
 * caller's LATER `INSERT` (blocked on an unrelated implicit FK-reference
 * lock on the same row — see the FOR UPDATE test's own doc comment) still
 * showed up as a genuine `wait_event_type = 'Lock'`, so the check passed
 * for the wrong reason. Filtering the waiting query's own text to the
 * SPECIFIC statement the guard protects closes that gap.
 */
export async function waitForLockWait(
  pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  options: { excludePids: number[]; queryContains: string; timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const { excludePids, queryContains, timeoutMs = 3000, pollIntervalMs = 20 } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `select 1 from pg_stat_activity where wait_event_type = 'Lock' and pid != all($1::int[]) and query ilike $2`,
      [excludePids, `%${queryContains}%`],
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

/**
 * `processID` is set on the underlying connection at runtime but isn't part
 * of `@types/pg`'s `PoolClient` — used to exclude the lock holder's own
 * connection from `waitForLockWait`'s `pg_stat_activity` scan.
 */
export function getProcessId(client: PoolClient): number {
  return (client as unknown as { processID: number }).processID;
}

interface TableNodeLike {
  kind: string;
  table?: { identifier?: { name?: string } };
}

/**
 * True when a SELECT's FROM or JOIN clauses reference `table` — used to
 * fingerprint a specific query by the tables it touches (e.g. "joins
 * reservation_nights AND reservations") instead of by fragile SQL-string
 * matching.
 */
export function selectReferencesTable(node: RootOperationNode, table: string): boolean {
  if (node.kind !== 'SelectQueryNode') return false;
  const selectNode = node as unknown as {
    from?: { froms?: TableNodeLike[] };
    joins?: { table: TableNodeLike }[];
  };
  const froms = selectNode.from?.froms ?? [];
  const joinTables = (selectNode.joins ?? []).map((j) => j.table);
  return [...froms, ...joinTables].some(
    (t) => t.kind === 'TableNode' && t.table?.identifier?.name === table,
  );
}

function collectColumnNames(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnNames(item, acc);
    return acc;
  }
  const obj = node as { kind?: string; column?: { name?: string }; [key: string]: unknown };
  if (obj.kind === 'ColumnNode' && typeof obj.column?.name === 'string') {
    acc.add(obj.column.name);
  }
  for (const value of Object.values(obj)) collectColumnNames(value, acc);
  return acc;
}

/**
 * True when a SELECT's WHERE clause references `column`, anywhere in the
 * (possibly nested AND/OR) condition tree — used to fingerprint a query by
 * what it filters on when two queries hit the SAME table with the SAME
 * shape but different conditions (e.g. "payments dedup'd by
 * idempotency_key" vs "payments filtered by kind + status").
 */
export function selectWhereReferencesColumn(node: RootOperationNode, column: string): boolean {
  if (node.kind !== 'SelectQueryNode') return false;
  const whereNode = (node as { where?: unknown }).where;
  if (!whereNode) return false;
  return collectColumnNames(whereNode).has(column);
}

/**
 * True when a raw `sql\`...\`` query's fragments contain `substring` — used
 * to fingerprint queries issued via the `sql` tag (e.g.
 * `pg_advisory_xact_lock`), which compile to a `RawNode` with no
 * table/column structure to inspect. IMPORTANT for lock timing: an advisory
 * lock is its OWN query, separate from whatever SELECT runs after it — the
 * wait happens on THIS query, not on the one that follows it inside the
 * same transaction. Time this one, not the next one (see
 * server/CLAUDE.md's concurrency-test lesson on measuring the wrong query).
 */
export function rawSqlContains(node: RootOperationNode, substring: string): boolean {
  if (node.kind !== 'RawNode') return false;
  const fragments = (node as { sqlFragments?: readonly string[] }).sqlFragments ?? [];
  return fragments.some((f) => f.includes(substring));
}
