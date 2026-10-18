import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const RANGES = {
  "24h": { spanMs: 24 * 3600_000, bucketMs: 5 * 60_000 },
  "7d": { spanMs: 7 * 24 * 3600_000, bucketMs: 30 * 60_000 },
  "30d": { spanMs: 30 * 24 * 3600_000, bucketMs: 2 * 3600_000 },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id     INTEGER PRIMARY KEY,
  site   TEXT    NOT NULL,
  t      INTEGER NOT NULL,
  ok     INTEGER NOT NULL,
  status INTEGER,
  ms     INTEGER NOT NULL,
  error  TEXT
);
CREATE INDEX IF NOT EXISTS checks_site_t ON checks (site, t);
`;

// Opens (creating if needed) DATA_DIR/status.db. Pass ":memory:" for tests.
export function openDb(dataDir) {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "status.db");
  }

  const db = new DatabaseSync(path);
  // Litestream requires WAL and a busy timeout; it handles checkpointing.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const q = {
    insert: db.prepare("INSERT INTO checks (site, t, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)"),
    recent: db.prepare("SELECT t, ok, status, ms, error FROM checks WHERE site = ? ORDER BY t DESC LIMIT ?"),
    stats: db.prepare(`
      SELECT COUNT(*) AS checks, SUM(ok) AS up, AVG(CASE WHEN ok THEN ms END) AS avgMs
      FROM checks WHERE site = ? AND t >= ?`),
    history: db.prepare(`
      SELECT (t / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS b, COUNT(*) AS checks, SUM(ok) AS up,
             AVG(CASE WHEN ok THEN ms END) AS avgMs, MAX(CASE WHEN ok THEN ms END) AS maxMs
      FROM checks WHERE site = ?2 AND t >= ?3 AND t < ?4
      GROUP BY b ORDER BY b`),
    prune: db.prepare("DELETE FROM checks WHERE t < ?"),
  };

  return {
    insert(site, c) {
      q.insert.run(site, c.t, c.ok ? 1 : 0, c.status ?? null, c.ms, c.error ?? null);
    },

    // One short transaction per check round. Litestream 0.5 uploads one file
    // per transaction, so this keeps R2 writes independent of the site count.
    insertMany(entries) {
      db.exec("BEGIN");
      try {
        for (const [site, c] of entries) this.insert(site, c);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    // Last n checks, oldest first.
    recent(site, n) {
      return q.recent.all(site, n).reverse().map(toCheck);
    },

    stats(site, since) {
      const r = q.stats.get(site, since);
      return {
        uptime: r.checks ? Math.round((r.up / r.checks) * 10000) / 100 : null,
        avgMs: r.avgMs == null ? null : Math.round(r.avgMs),
      };
    },

    // Fixed-size buckets covering the range ending at `now`, gaps included.
    history(site, range, now) {
      const { spanMs, bucketMs } = RANGES[range];
      const end = Math.floor(now / bucketMs) * bucketMs + bucketMs; // exclusive
      const from = end - spanMs;
      const rows = q.history.all(bucketMs, site, from, end);
      return fillBuckets(rows, from, end, bucketMs);
    },

    prune(before) {
      return Number(q.prune.run(before).changes);
    },

    close() {
      db.close();
    },
  };
}

function toCheck(r) {
  return { t: r.t, ok: r.ok === 1, status: r.status, ms: r.ms, error: r.error };
}

export function fillBuckets(rows, from, end, bucketMs) {
  const byStart = new Map(rows.map((r) => [Number(r.b), r]));
  const out = [];
  for (let t = from; t < end; t += bucketMs) {
    const r = byStart.get(t);
    out.push(
      r
        ? {
            t,
            checks: r.checks,
            up: r.up,
            avgMs: r.avgMs == null ? null : Math.round(r.avgMs),
            maxMs: r.maxMs,
          }
        : { t, checks: 0, up: 0, avgMs: null, maxMs: null },
    );
  }
  return out;
}
