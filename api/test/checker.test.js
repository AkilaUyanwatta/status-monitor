import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { classify, describeError, checkUrl } from "../checker.js";

test("classify", () => {
  assert.equal(classify(null, 2000), "pending");
  assert.equal(classify({ ok: false, ms: 5 }, 2000), "down");
  assert.equal(classify({ ok: false, ms: 9000 }, 2000), "down");
  assert.equal(classify({ ok: true, ms: 2000 }, 2000), "up");
  assert.equal(classify({ ok: true, ms: 2001 }, 2000), "slow");
});

test("describeError maps common codes", () => {
  const wrap = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  assert.equal(describeError(wrap("ENOTFOUND")), "Domain not found (DNS)");
  assert.equal(describeError(wrap("ECONNREFUSED")), "Connection refused");
  assert.equal(describeError(wrap("ECONNRESET")), "Connection reset");
  assert.equal(describeError(wrap("CERT_HAS_EXPIRED")), "TLS certificate expired");
  assert.equal(describeError(wrap("ERR_TLS_SOMETHING_NEW")), "TLS certificate error");
  assert.equal(describeError(wrap("EWHATEVER")), "Request failed (EWHATEVER)");
  assert.equal(describeError(new DOMException("t", "TimeoutError"), 10000), "Timed out after 10s");
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("checkUrl: up, redirect, 5xx, timeout, refused", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/redirect") return res.writeHead(302, { location: "/" }).end();
      if (req.url === "/fail") return res.writeHead(503).end("no");
      if (req.url === "/hang") return; // never respond
      res.end("hello");
    },
    async (base) => {
      const up = await checkUrl(`${base}/`, { timeoutMs: 2000 });
      assert.equal(up.ok, true);
      assert.equal(up.status, 200);
      assert.equal(up.error, null);

      const redirect = await checkUrl(`${base}/redirect`, { timeoutMs: 2000 });
      assert.equal(redirect.status, 200);

      const fail = await checkUrl(`${base}/fail`, { timeoutMs: 2000 });
      assert.equal(fail.ok, false);
      assert.equal(fail.error, "HTTP 503 Service Unavailable");

      const hang = await checkUrl(`${base}/hang`, { timeoutMs: 200 });
      assert.equal(hang.ok, false);
      assert.equal(hang.status, null);
      assert.equal(hang.error, "Timed out after 0.2s");
    },
  );

  // A port that was just freed is very likely closed.
  const closedPort = await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const refused = await checkUrl(`http://127.0.0.1:${closedPort}/`, { timeoutMs: 2000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "Connection refused");
});
