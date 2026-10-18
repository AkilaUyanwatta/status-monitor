import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, fillBuckets } from "../db.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const check = (t, ok = true, ms = 100) => ({ t, ok, status: ok ? 200 : 503, ms, error: ok ? null : "HTTP 503" });

test("schema uses WAL on a file database", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-db-"));
  try {
    const db = openDb(dir);
    db.insert("a", check(1));
    assert.equal(db.recent("a", 10).length, 1);
    db.close();
    // Reopen: data persists.
    const db2 = openDb(dir);
    assert.equal(db2.recent("a", 10).length, 1);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recent returns the last n checks oldest first", () => {
  const db = openDb(":memory:");
  for (let i = 1; i <= 100; i++) db.insert("a", check(i * 1000, i % 10 !== 0, i));
  db.insert("b", check(5));
  const r = db.recent("a", 90);
  assert.equal(r.length, 90);
  assert.equal(r[0].t, 11_000);
  assert.equal(r.at(-1).t, 100_000);
  assert.equal(r.at(-1).ok, false);
  assert.equal(typeof r[0].ok, "boolean");
  db.close();
});

test("insertMany writes all rows or none", () => {
  const db = openDb(":memory:");
  db.insertMany([["a", check(1)], ["b", check(2)]]);
  assert.equal(db.recent("a", 10).length + db.recent("b", 10).length, 2);
  assert.throws(() => db.insertMany([["a", check(3)], ["b", { t: 4, ok: true, ms: null }]]));
  assert.deepEqual(db.recent("a", 10).map((c) => c.t), [1]);
  db.close();
});

test("stats: uptime and average of successful checks", () => {
  const db = openDb(":memory:");
  db.insert("a", check(10, true, 100));
  db.insert("a", check(20, true, 300));
  db.insert("a", check(30, false, 10000));
  db.insert("a", check(40, true, 200));
  db.insert("a", check(1, true, 9999)); // before `since`
  assert.deepEqual(db.stats("a", 5), { uptime: 75, avgMs: 200 });
  assert.deepEqual(db.stats("missing", 0), { uptime: null, avgMs: null });
  db.close();
});

test("history buckets: alignment, aggregation and gap filling", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 0, 2, 12, 2, 0); // 12:02
  const bucket = 5 * MIN;
  const cur = Math.floor(now / bucket) * bucket; // 12:00
  db.insert("a", check(cur + 1000, true, 100));
  db.insert("a", check(cur + 2000, false, 10000));
  db.insert("a", check(cur + 3000, true, 300));
  db.insert("a", check(cur - bucket + 5, true, 50)); // previous bucket
  db.insert("a", check(now - 2 * DAY, true, 50)); // out of range

  const h = db.history("a", "24h", now);
  assert.equal(h.length, 288);
  assert.equal(h.at(-1).t, cur);
  assert.equal(h[0].t, cur + bucket - DAY);
  assert.deepEqual(h.at(-1), { t: cur, checks: 3, up: 2, avgMs: 200, maxMs: 300 });
  assert.deepEqual(h.at(-2), { t: cur - bucket, checks: 1, up: 1, avgMs: 50, maxMs: 50 });
  assert.deepEqual(h[0], { t: h[0].t, checks: 0, up: 0, avgMs: null, maxMs: null });
  assert.equal(h.reduce((n, b) => n + b.checks, 0), 4);

  assert.equal(db.history("a", "7d", now).length, 336);
  assert.equal(db.history("a", "30d", now).length, 360);
  db.close();
});

test("fillBuckets marks a bucket with only failures as avgMs null", () => {
  const out = fillBuckets([{ b: 0, checks: 2, up: 0, avgMs: null, maxMs: null }], 0, 20, 10);
  assert.deepEqual(out, [
    { t: 0, checks: 2, up: 0, avgMs: null, maxMs: null },
    { t: 10, checks: 0, up: 0, avgMs: null, maxMs: null },
  ]);
});

test("prune deletes only rows older than the cutoff", () => {
  const db = openDb(":memory:");
  const now = 100 * DAY;
  db.insert("a", check(now - 31 * DAY));
  db.insert("b", check(now - 30 * DAY - 1));
  db.insert("a", check(now - 30 * DAY));
  db.insert("a", check(now - HOUR));
  assert.equal(db.prune(now - 30 * DAY), 2);
  assert.deepEqual(db.recent("a", 10).map((c) => c.t), [now - 30 * DAY, now - HOUR]);
  assert.equal(db.recent("b", 10).length, 0);
  db.close();
});
