import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHandler, loadConfig } from "../server.js";
import { openDb } from "../db.js";

async function withApi(fn) {
  const config = loadConfig({
    MONITOR_URLS: "Site=https://example.com/secret?token=abc,https://other.example",
    ALLOWED_ORIGIN: "https://status.example.com",
  });
  const db = openDb(":memory:");
  const now = 1_700_000_000_000;
  db.insert(config.monitors[0].id, { t: now - 1000, ok: true, status: 200, ms: 2500, error: null });
  const server = createServer(createHandler({ db, config, now: () => now }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, config);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
}

test("GET /api/status", async () => {
  await withApi(async (base, config) => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://status.example.com");
    assert.equal(res.headers.get("cache-control"), "public, max-age=15");
    const text = await res.text();
    assert.ok(!text.includes("secret") && !text.includes("token"), "URLs must never be returned");
    const body = JSON.parse(text);
    assert.equal(body.intervalSeconds, 30);
    assert.equal(body.sites.length, 2);
    const [site, other] = body.sites;
    assert.equal(site.id, config.monitors[0].id);
    assert.equal(site.state, "slow");
    assert.equal(site.uptime24h, 100);
    assert.equal(site.recent.length, 1);
    assert.equal(other.name, "other.example");
    assert.equal(other.state, "pending");
    assert.equal(other.last, null);
  });
});

test("GET /api/history", async () => {
  await withApi(async (base, config) => {
    const id = config.monitors[0].id;
    const ok = await fetch(`${base}/api/history?id=${id}&range=7d`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "public, max-age=60");
    const body = await ok.json();
    assert.equal(body.buckets.length, 336);
    assert.equal(body.buckets.at(-1).checks, 1);

    assert.equal((await fetch(`${base}/api/history?id=nope&range=24h`)).status, 404);
    assert.equal((await fetch(`${base}/api/history?id=${id}&range=1y`)).status, 400);
  });
});

test("OPTIONS preflight, /healthz, 404s", async () => {
  await withApi(async (base) => {
    const pre = await fetch(`${base}/api/status`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://status.example.com");

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    assert.equal(health.headers.get("cache-control"), "no-store");

    const nf = await fetch(`${base}/whatever`);
    assert.equal(nf.status, 404);
    assert.equal(nf.headers.get("access-control-allow-origin"), null);
  });
});

test("loadConfig validates numbers", () => {
  assert.throws(() => loadConfig({ MONITOR_URLS: "https://a.com", INTERVAL_SECONDS: "abc" }));
  assert.equal(loadConfig({ MONITOR_URLS: "https://a.com" }).allowedOrigin, "*");
});
