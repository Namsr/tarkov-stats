// `CREATE TRIGGER IF NOT EXISTS` never replaces an existing trigger body: the name
// matches, so the new definition is silently discarded and every database deployed
// before the edit keeps the old body forever. Nothing warns — the trigger still fires,
// it just watches the wrong columns. `ensureIndexDefinition()` in lib/db.ts already
// solves the same hazard for indexes; this is the trigger equivalent, shared by the
// seasonal journal and the player profile change journal.
//
// Dropping unconditionally is not an option: the initializers run on every process
// open and the leaderboard materializer on every scheduled run, and each drop would
// open a window in which the write path has no trigger at all. Comparing the stored
// DDL first restricts the reinstall to the deployments that actually need it.

export interface TriggerDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** A trigger definition paired with its name, so the name is never parsed back out. */
export interface TriggerDdl {
  name: string;
  ddl: string;
}

/** Builds `CREATE TRIGGER IF NOT EXISTS <name>` around a trigger body. */
export function sqliteTrigger(name: string, body: string): TriggerDdl {
  return { name, ddl: `CREATE TRIGGER IF NOT EXISTS ${name}\n${body}` };
}

// SQLite stores the statement it parsed, so the stored text carries neither
// `IF NOT EXISTS` nor the trailing semicolon. Compare a normalized form of both.
//
// Case is preserved on purpose, and the two texts are not stored the same way.
// SQLite rewrites the head to exactly `CREATE TRIGGER <name>`, uppercasing the
// keywords and collapsing the whitespace before the name: `create   TrIgGeR w1`
// comes back as `CREATE TRIGGER w1`. From the name onward the text is verbatim. So
// the head agrees only because sqliteTrigger() emits exactly `CREATE TRIGGER` and
// that is what SQLite normalises it to, and the body agrees because nothing in it
// is rewritten. A TriggerDdl assembled by hand with a differently-cased head never
// converges: it reinstalls on every open, forever.
//
// Case inside a string literal is likewise compared exactly, because SQLite
// compares string literals case-sensitively. A `'Seasonal'` -> `'seasonal'` edit is
// a real change to what the trigger watches, and folding case here would call the
// two definitions equal and skip the reinstall.
//
// Limitation: collapsing whitespace reaches inside string literals, so it is blind
// to an edit that changes the character or the length of a run that is already
// there — a tab for a space, a newline for a space, one space for two. Adding or
// removing a run is still detected, because that changes the run count. No trigger
// compared here carries a run inside a literal; the four seasonal bodies hold only
// 'seasonal' and 'subsec', and the two leaderboard journal bodies only 'regular',
// 'pve' and 'arena'.
//
// Making this exact would mean tokenizing SQL to find the literal boundaries. The
// two ways that goes wrong are not symmetric. A tokenizer that reports a difference
// where there is none reinstalls the trigger on every process open, and that cannot
// ship quietly: `current progression schema initialization performs no migration
// writes` asserts a current database issues only PRAGMA busy_timeout, so a false
// verdict fails the suite on the first run. A tokenizer that misses a difference
// that is there ships untested: the suite pins exactly one such class — case inside
// a string literal, which `a case-only edit to a string literal in a trigger body
// is still a change` covers — and a tokenizer's own blind spots (a doubled
// apostrophe, a `--` comment, a double-quoted identifier) would reach a deployed
// database with nothing to catch them. Prefer the normalizer, because the direction
// the guard does not cover is the one that matters.
function normalizedTriggerDdl(ddl: string): string {
  return ddl.replace(/^(\s*CREATE\s+TRIGGER)\s+IF\s+NOT\s+EXISTS\b/i, "$1")
    .replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

/**
 * Reinstalls any of `triggers` whose stored DDL no longer matches its definition.
 * Names are source literals, never bound input. The trigger is a write path — the
 * journal cursor lives in the table, not the trigger — so the drop loses no state.
 */
export function reissueEditedTriggers(db: TriggerDatabase, triggers: readonly TriggerDdl[]): void {
  for (const { name, ddl } of triggers) {
    // An absent trigger needs no drop; the schema that follows creates it in order.
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name) as { sql?: string | null } | undefined;
    if (typeof row?.sql !== "string") continue;
    if (normalizedTriggerDdl(row.sql) === normalizedTriggerDdl(ddl)) continue;
    // The drop and the recreate are one unit. Autocommitting them separately opens a
    // window in which the write path has no journal trigger at all: a writer that
    // commits inside it is never journaled, never gets a revision, and is therefore
    // never re-scanned by the materializer. A concurrent writer can also fail the
    // recreate with "database is locked" while a savepoint already committed the
    // drop, leaving the write path with no trigger permanently.
    //
    // SAVEPOINT rather than BEGIN/COMMIT: BEGIN throws "cannot start a transaction
    // within a transaction" when a caller already holds one, and the initializers
    // that reach here do run inside other transactions. The rollback restores the
    // previous body, which is the correct fallback, and the error is rethrown so the
    // caller does not walk on believing the schema is current.
    db.exec("SAVEPOINT reissue_trigger");
    try {
      db.exec(`DROP TRIGGER IF EXISTS ${name};`);
      db.exec(ddl);
      db.exec("RELEASE reissue_trigger;");
    } catch (error) {
      db.exec("ROLLBACK TO reissue_trigger; RELEASE reissue_trigger;");
      throw error;
    }
  }
}
