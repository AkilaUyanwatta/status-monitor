import { STATUS_CODES } from "node:http";

const USER_AGENT = "status-monitor/1.0";

// up | slow | down | pending, from the most recent check.
export function classify(last, slowMs) {
  if (!last) return "pending";
  if (!last.ok) return "down";
  return last.ms > slowMs ? "slow" : "up";
}

const ERROR_MESSAGES = {
  ENOTFOUND: "Domain not found (DNS)",
  EAI_AGAIN: "DNS lookup failed (temporary)",
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  ETIMEDOUT: "Connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
  UND_ERR_SOCKET: "Connection closed unexpectedly",
  CERT_HAS_EXPIRED: "TLS certificate expired",
  CERT_NOT_YET_VALID: "TLS certificate not yet valid",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS certificate does not match the domain",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS certificate is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "TLS certificate chain is self-signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate could not be verified",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "TLS certificate issuer unknown",
};

// Turns a fetch() failure into a short human-readable message.
export function describeError(err, timeoutMs) {
  if (err?.name === "TimeoutError") return `Timed out after ${formatSeconds(timeoutMs)}`;
  // fetch wraps network errors: TypeError("fetch failed", { cause })
  let e = err;
  for (let i = 0; e && i < 5; i++) {
    if (e.code && ERROR_MESSAGES[e.code]) return ERROR_MESSAGES[e.code];
    if (e.code?.startsWith?.("ERR_TLS") || /certificate/i.test(e.message ?? "")) return "TLS certificate error";
    // Dual-stack connects fail with an AggregateError of per-address errors.
    e = e.cause ?? e.errors?.[0];
  }
  const code = err?.cause?.code ?? err?.code;
  return code ? `Request failed (${code})` : "Request failed";
}

export function describeStatus(status) {
  const text = STATUS_CODES[status];
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
}

function formatSeconds(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

// Performs one check. Never throws; returns { t, ok, status, ms, error }.
export async function checkUrl(url, { timeoutMs, signal } = {}) {
  const t = Date.now();
  const start = performance.now();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.any(signals),
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    });
    // Read and discard the body without buffering it.
    if (res.body) for await (const _chunk of res.body); // eslint-disable-line no-unused-vars
    const ms = Math.round(performance.now() - start);
    const ok = res.status < 400;
    return { t, ok, status: res.status, ms, error: ok ? null : describeStatus(res.status) };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return { t, ok: false, status: null, ms, error: describeError(err, timeoutMs) };
  }
}
