import { createHash } from "node:crypto";

// Parses MONITOR_URLS into [{ id, name, url }].
//
// Entries are separated by commas or newlines. Each entry is either a bare
// URL ("https://example.com") or "Name=https://example.com". Only the first
// "=" separates the name, so query strings like "?a=b" are safe. A URL that
// itself contains a comma must encode it as %2C.
//
// Throws on any invalid entry so a typo fails loudly at startup.
export function parseMonitorUrls(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("MONITOR_URLS is empty");
  }

  const monitors = [];
  const seen = new Set();

  for (const raw of input.split(/[\n,]/)) {
    const entry = raw.trim();
    if (entry === "") continue;

    let name = null;
    let rawUrl = entry;
    if (!/^https?:\/\//i.test(entry)) {
      const eq = entry.indexOf("=");
      if (eq === -1) throw new Error(`Invalid MONITOR_URLS entry "${entry}": expected a URL or Name=URL`);
      name = entry.slice(0, eq).trim();
      rawUrl = entry.slice(eq + 1).trim();
      if (name === "") throw new Error(`Invalid MONITOR_URLS entry "${entry}": empty name`);
    }

    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid MONITOR_URLS entry "${entry}": not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Invalid MONITOR_URLS entry "${entry}": only http and https are supported`);
    }

    const href = url.href;
    const id = monitorId(href);
    if (seen.has(id)) continue;
    seen.add(id);

    monitors.push({ id, name: name ?? url.host, url: href });
  }

  if (monitors.length === 0) throw new Error("MONITOR_URLS contains no URLs");
  return monitors;
}

// Stable id: first 10 hex chars of SHA-256 of the normalized URL.
export function monitorId(normalizedUrl) {
  return createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 10);
}
