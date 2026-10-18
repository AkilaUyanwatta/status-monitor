import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMonitorUrls, monitorId } from "../monitors.js";

test("named and bare entries; bare name defaults to host", () => {
  const m = parseMonitorUrls("Website=https://example.com,https://api.example.org:8443/health");
  assert.deepEqual(
    m.map((x) => [x.name, x.url]),
    [
      ["Website", "https://example.com/"],
      ["api.example.org:8443", "https://api.example.org:8443/health"],
    ],
  );
});

test("URLs with = in the query string", () => {
  const [named, bare] = parseMonitorUrls("Search=https://x.com/q?a=1&b=2\nhttps://y.com/?token=abc=");
  assert.equal(named.name, "Search");
  assert.equal(named.url, "https://x.com/q?a=1&b=2");
  assert.equal(bare.name, "y.com");
  assert.equal(bare.url, "https://y.com/?token=abc=");
});

test("newlines, commas, blank lines and whitespace", () => {
  const m = parseMonitorUrls("\n  A=https://a.com ,\r\n\n B = https://b.com\n,,C=https://c.com\n");
  assert.deepEqual(m.map((x) => x.name), ["A", "B", "C"]);
});

test("duplicates are ignored after normalization (first wins)", () => {
  const m = parseMonitorUrls("One=https://Example.com,Two=https://example.com/,https://EXAMPLE.com");
  assert.equal(m.length, 1);
  assert.equal(m[0].name, "One");
});

test("ids are stable and independent of order", () => {
  const a = parseMonitorUrls("A=https://a.com,B=https://b.com");
  const b = parseMonitorUrls("B renamed=https://b.com,A=https://a.com");
  assert.equal(a[0].id, b[1].id);
  assert.equal(a[1].id, b[0].id);
  assert.match(a[0].id, /^[0-9a-f]{10}$/);
  assert.equal(a[0].id, monitorId("https://a.com/"));
});

test("invalid input throws", () => {
  for (const bad of [
    undefined,
    "",
    "  ,\n ",
    "not a url",
    "Name=",
    "=https://a.com",
    "Name=not a url",
    "ftp://a.com",
    "FTP=ftp://a.com",
    "https://ok.com,broken",
  ]) {
    assert.throws(() => parseMonitorUrls(bad), Error, `expected throw for ${JSON.stringify(bad)}`);
  }
});
