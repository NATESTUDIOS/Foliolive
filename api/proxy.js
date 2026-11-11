// api/proxy.js
// ═══════════════════════════════════════════════════════════════════
//  Folio — live-site proxy
//  ────────────────────────────────────────────────────────────────
//  Forwards every public-site request to the main app, preserving
//  method, body, headers, and status.
//
//  Why a function and not a cross-domain rewrite?
//    Vercel's `rewrites` to another domain are GET-only. POST bodies
//    are dropped. That broke every `api/run` call from the live site.
//    This function proxies both verbs correctly.
//
//  Routing:
//    /{username}/project/{slug}/api/{route}   → /api/run
//    /{username}/project/{slug}/…             → /api/host?action=serve
//    /{username}/{slug}                       → /api/host?action=share
//    /{username}                              → /api/host?action=profile
//
//  The rewrite rules in vercel.json forward to this function with a
//  `__kind` query param describing which destination to hit, plus the
//  parsed segments.
// ═══════════════════════════════════════════════════════════════════

const MAIN_BASE =
  process.env.BASE_URL || "https://foliostudios.vercel.app";

export const config = { runtime: "nodejs" };

// Headers we must not forward — hop-by-hop or dangerous.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
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
      // Preserve recursion depth + caller for internal chain calls
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
      // Preserve ?from= for historical deployment previews
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
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });

  // Redirects — pass through untouched (needed for offline redirects,
  // slug rename 301s, private→live-site redirects).
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) res.setHeader("Location", loc);
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