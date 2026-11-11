// api/proxy.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — live-site proxy
//  ────────────────────────────────────────────────────────────────
//  Forwards public-site requests to the main app, preserving method,
//  body, and headers — and rewriting any absolute Location headers
//  so the browser never leaves foliosites.vercel.app.
//
//  Why a function and not a cross-domain rewrite?
//    Vercel's `rewrites` to another origin are GET-only (POST bodies
//    are dropped) and don't rewrite Location headers (browser jumps
//    to the editor domain). This function handles both.
// ═══════════════════════════════════════════════════════════════════

const MAIN_BASE =
  process.env.BASE_URL || "https://foliostudios.vercel.app";

const LIVE_HOST =
  process.env.PUBLIC_SITE_BASE || "https://foliosites.vercel.app";

export const config = { runtime: "nodejs" };

// Hop-by-hop and dangerous headers — never forward either direction.
// Note: we DO forward `host`. That's what makes handleServe's
// requestOrigin (req.headers.host) resolve to the live domain,
// so 301s from previousUsernames / previousSlugs / private-to-public
// stay on foliosites.vercel.app.
const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

function buildTarget(kind, query) {
  switch (kind) {
    case "run": {
      const qs = new URLSearchParams({
        username: query.username || "",
        project: query.project || "",
        route: query.route || "",
      });
      if (query["x-recursion-depth"]) qs.set("x-recursion-depth", query["x-recursion-depth"]);
      return `${MAIN_BASE}/api/run?${qs.toString()}`;
    }
    case "serve": {
      const qs = new URLSearchParams({
        action: "serve",
        username: query.username || "",
        project: query.project || "",
        path: query.path || "index.html",
      });
      if (query.from) qs.set("from", query.from);
      if (query.v) qs.set("v", query.v);
      if (query.download) qs.set("download", query.download);
      return `${MAIN_BASE}/api/host?${qs.toString()}`;
    }
    case "share": {
      const qs = new URLSearchParams({
        action: "share",
        username: query.username || "",
        project: query.project || "",
      });
      return `${MAIN_BASE}/api/host?${qs.toString()}`;
    }
    case "profile": {
      const qs = new URLSearchParams({
        action: "profile",
        username: query.username || "",
      });
      return `${MAIN_BASE}/api/host?${qs.toString()}`;
    }
    default:
      return null;
  }
}

async function readRequestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (req.body === undefined || req.body === null) return undefined;
  if (typeof req.body === "string" || Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.stringify(req.body);
  } catch {
    return undefined;
  }
}

// Rewrite an absolute Location header so it stays on the live domain.
// - Editor → live domain prefix swap.
// - Already-live URLs pass through untouched.
// - Relative URLs pass through untouched.
function rewriteLocation(location) {
  if (!location || typeof location !== "string") return location;
  const editorHost = (() => {
    try { return new URL(MAIN_BASE).host; } catch { return null; }
  })();
  const liveBase = (() => {
    try { return new URL(LIVE_HOST).origin; } catch { return "https://foliosites.vercel.app"; }
  })();

  try {
    const u = new URL(location, liveBase);
    if (editorHost && u.host === editorHost) {
      return liveBase + u.pathname + (u.search || "") + (u.hash || "");
    }
    return location;
  } catch {
    return location;
  }
}

export default async function handler(req, res) {
  const kind = String(req.query?.__kind || "").trim();
  const target = buildTarget(kind, req.query || {});

  if (!target) {
    return res.status(400).json({ success: false, error: "Unknown proxy kind" });
  }

  // ── Build outbound request ─────────────────────────────────
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) headers[k] = v.join(", ");
    else if (typeof v === "string") headers[k] = v;
  }

  // Ensure the upstream sees the live host, not the proxy's local host
  headers["host"] = (() => {
    try { return new URL(LIVE_HOST).host; } catch { return "foliosites.vercel.app"; }
  })();

  const body = await readRequestBody(req);
  if (body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  // ── Forward ─────────────────────────────────────────────────
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method || "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const isTimeout = /timeout/i.test(String(err?.message || ""));
    return res.status(isTimeout ? 504 : 502).json({
      success: false,
      error: isTimeout ? "Upstream timeout" : "Upstream unreachable",
    });
  }

  // ── Relay status + headers ─────────────────────────────────
  res.status(upstream.status);

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) return;
    if (lower === "location") return; // handled below
    res.setHeader(key, value);
  });

  // ── Redirects — rewrite Location so it stays on the live domain
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) {
      const rewritten = rewriteLocation(loc);
      res.setHeader("Location", rewritten);
    }
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  // ── Body ────────────────────────────────────────────────────
  let buf;
  try {
    buf = Buffer.from(await upstream.arrayBuffer());
  } catch {
    return res.status(502).json({ success: false, error: "Upstream body read failed" });
  }

  res.setHeader("Content-Length", String(buf.length));
  return res.send(buf);
}