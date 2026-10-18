import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMonitorUrls } from "./monitors.js";
import { openDb, RANGES } from "./db.js";
import { checkUrl, classify } from "./checker.js";

const RECENT_COUNT = 90;
const DAY_MS = 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;

export function loadConfig(env = process.env) {
  const int = (name, def) => {
    const v = env[name];
    if (v === undefined || v === "") return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${v}"`);
    return n;
  };
  return {
    monitors: parseMonitorUrls(env.MONITOR_URLS),
    allowedOrigin: env.ALLOWED_ORIGIN || "*",
    intervalSeconds: int("INTERVAL_SECONDS", 30),
    slowMs: int("SLOW_MS", 2000),
    timeoutMs: int("TIMEOUT_MS", 10000),
    retentionDays: int("RETENTION_DAYS", 30),
    dataDir: env.DATA_DIR || "./data",
    port: int("PORT", 4040),
    host: env.HOST || "0.0.0.0",
  };
}

// Builds the HTTP request handler. Exported for tests.
export function createHandler({ db, config, now = Date.now }) {
  const byId = new Map(config.monitors.map((m) => [m.id, m]));

  function statusBody() {
    const t = now();
    return {
      generatedAt: t,
      intervalSeconds: config.intervalSeconds,
      slowMs: config.slowMs,
      // Never include m.url: it may contain paths or tokens.
      sites: config.monitors.map((m) => {
        const recent = db.recent(m.id, RECENT_COUNT);
        const last = recent.at(-1) ?? null;
        const stats = db.stats(m.id, t - DAY_MS);
        return {
          id: m.id,
          name: m.name,
          state: classify(last, config.slowMs),
          last,
          uptime24h: stats.uptime,
          avgMs24h: stats.avgMs,
          recent,
        };
      }),
    };
  }

  return function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    const headers = { "X-Content-Type-Options": "nosniff" };
    if (isApi) headers["Access-Control-Allow-Origin"] = config.allowedOrigin;

    const send = (code, body, extra = {}) => {
      const json = typeof body !== "string";
      const payload = json ? JSON.stringify(body) : body;
      res.writeHead(code, {
        ...headers,
        "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : payload);
    };

    if (isApi && req.method === "OPTIONS") {
      res.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
    }

    try {
      if (url.pathname === "/healthz") {
        return send(200, "ok", { "Cache-Control": "no-store" });
      }

      if (url.pathname === "/api/status") {
        return send(200, statusBody(), { "Cache-Control": "public, max-age=15" });
      }

      if (url.pathname === "/api/history") {
        const id = url.searchParams.get("id");
        const range = url.searchParams.get("range") || "24h";
        if (!Object.hasOwn(RANGES, range)) {
          return send(400, { error: "range must be one of 24h, 7d, 30d" }, { "Cache-Control": "no-store" });
        }
        const m = byId.get(id);
        if (!m) return send(404, { error: "unknown id" }, { "Cache-Control": "no-store" });
        const t = now();
        return send(
          200,
          {
            generatedAt: t,
            id: m.id,
            name: m.name,
            range,
            bucketMs: RANGES[range].bucketMs,
            buckets: db.history(m.id, range, t),
          },
          { "Cache-Control": "public, max-age=60" },
        );
      }

      return send(404, { error: "not found" }, { "Cache-Control": "no-store" });
    } catch (err) {
      console.error("request failed:", err);
      return send(500, { error: "internal error" }, { "Cache-Control": "no-store" });
    }
  };
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`config error: ${err.message}`);
    process.exit(1);
  }

  const db = openDb(config.dataDir);
  const shutdown = new AbortController();
  const lastState = new Map();
  let roundTimer = null;
  let pruneTimer = null;

  async function runRound() {
    const started = Date.now();
    const results = await Promise.all(
      config.monitors.map((m) => checkUrl(m.url, { timeoutMs: config.timeoutMs, signal: shutdown.signal })),
    );
    if (shutdown.signal.aborted) return;
    try {
      db.insertMany(config.monitors.map((m, i) => [m.id, results[i]]));
    } catch (err) {
      console.error("failed to record checks:", err);
    }
    config.monitors.forEach((m, i) => {
      const c = results[i];
      const state = classify(c, config.slowMs);
      const prev = lastState.get(m.id);
      if (prev !== state) {
        console.log(`${m.name}: ${prev ?? "start"} -> ${state}${c.error ? ` (${c.error})` : ""}`);
        lastState.set(m.id, state);
      }
    });
    const wait = Math.max(0, config.intervalSeconds * 1000 - (Date.now() - started));
    roundTimer = setTimeout(runRound, wait);
  }

  function prune() {
    const removed = db.prune(Date.now() - config.retentionDays * DAY_MS);
    if (removed) console.log(`pruned ${removed} checks older than ${config.retentionDays} days`);
  }

  const server = createServer(createHandler({ db, config }));
  server.listen(config.port, config.host, () => {
    console.log(
      `listening on ${config.host}:${config.port}; monitoring ${config.monitors.length} sites ` +
        `every ${config.intervalSeconds}s: ${config.monitors.map((m) => m.name).join(", ")}`,
    );
  });

  prune();
  pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
  runRound();

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    shutdown.abort();
    clearTimeout(roundTimer);
    clearInterval(pruneTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
