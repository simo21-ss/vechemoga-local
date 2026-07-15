// Tiny, dependency-free provider proxy-mock (Node built-in http only).
//
// It sits in front of an outbound provider the VecheMoga API calls (Loops for
// transactional email, and any other HTTP provider later). Point the API's
// provider base URL at this server once (e.g. -Dvechemoga.email.loops.base-url=
// http://localhost:1080) and it behaves like WireMock's proxy pattern:
//
//   - Unmatched traffic is forwarded to PROXY_UPSTREAM_URL and the real response is
//     returned, so an already-running API is unaffected until a test opts in. In the
//     local stack that variable is deliberately UNSET (see ../.env.example), so
//     unmatched mail 502s loudly instead of reaching real recipients; set it to
//     https://app.loops.so/api when you actually want passthrough.
//   - A test registers an EXPECTATION at runtime (keyed on a unique field, the
//     way Sesame keys a WireMock stub on a player id). A request matching that
//     expectation is short-circuited: the canned response is returned and the
//     request body is recorded so the test can read it back (e.g. the emailed
//     verification link, whose token is only stored hashed in the DB).
//
// No app restart, no application.yml rewrite, no third-party mock, no DB.
//
// This server is part of the local stack (VecheMogaLocal), not of any test suite:
// docker/docker-compose.yml runs it as the `provider-proxy` service, and it is the API's
// provider base URL for the whole stack, tests or not. Test suites are *clients* - they
// drive it over the control plane below and need nothing from this repo but the port.
//
// Run:  ./run.sh up          (as part of the stack; see ../docker/run.sh)
//       node provider-proxy.mjs   (standalone on the host, e.g. against an IDE-run API)
// Test: node --test test/     (dependency-free; Node's built-in runner)
//
// Control plane (test-facing), all under /__proxy:
//   POST   /__proxy/expectations      body { method?, path?, bodyMatch?, respond? } -> { id }
//   DELETE /__proxy/expectations/:id   remove one expectation
//   DELETE /__proxy/expectations       remove all
//   GET    /__proxy/requests           recorded (matched) requests, newest last
//   DELETE /__proxy/requests           clear the journal
//   GET    /__proxy/health             { status, upstream }
//
// Data plane: anything else -> first matching expectation wins (canned response
// + journal), otherwise proxied to PROXY_UPSTREAM_URL.

import http from "node:http";

/** An env var read as an integer, else the fallback. Empty-string and non-numeric are
 *  treated as unset, so `PROXY_PORT=` can't silently collapse to 0 (Compose passes
 *  through an empty string for an unset .env key). */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// The compose maps the host port and lets the container keep this default.
const PORT = intEnv("PROXY_PORT", 1080);
// Where unmatched traffic is proxied. Unset locally (tests always register an
// expectation for their own traffic, so the proxy path is never taken); set it
// in dev to the real provider so non-test traffic passes straight through.
const UPSTREAM = (process.env.PROXY_UPSTREAM_URL ?? "").replace(/\/$/, "");
// Safety cap so a suite that forgets to dispose can't grow the journal unbounded.
// Disposing an expectation prunes its own entries, so in practice the journal tracks
// only in-flight captures and stays far below this.
const JOURNAL_MAX = intEnv("PROXY_JOURNAL_MAX", 5000);

let seq = 0;
/** @type {{ id: string, method?: string, path?: string, bodyMatch?: Record<string, unknown>, respond: { status: number, headers: Record<string,string>, body: string } }[]} */
const expectations = [];
/** @type {{ id: string, method: string, path: string, body: unknown, receivedAt: number, matchedExpectationId: string }[]} */
const journal = [];

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    // Collect raw Buffers and decode once — string concatenation would split a
    // multi-byte UTF-8 char (e.g. a Cyrillic name) across chunk boundaries.
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function parseJson(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Drop journal entries captured for a given expectation id (called when it's disposed). */
function pruneJournalBy(expectationId) {
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i].matchedExpectationId === expectationId) journal.splice(i, 1);
  }
}

/** Resolve a dotted path ("dataVariables.actionButtonUrl") against a parsed body. */
function dig(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function pathOf(url) {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Build an expectation from a request payload, filling in a sensible default response. */
function toExpectation(payload) {
  const respond = payload.respond ?? {};
  const rawBody = respond.body ?? { success: true };
  const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  return {
    id: `exp_${++seq}`,
    method: payload.method ? String(payload.method).toUpperCase() : undefined,
    path: payload.path,
    bodyMatch: payload.bodyMatch,
    respond: {
      status: respond.status ?? 200,
      headers: { "content-type": "application/json", ...(respond.headers ?? {}) },
      body,
    },
  };
}

function matches(exp, method, reqPath, parsedBody) {
  if (exp.method && exp.method !== method) return false;
  if (exp.path && !reqPath.startsWith(exp.path)) return false;
  if (exp.bodyMatch) {
    for (const [key, want] of Object.entries(exp.bodyMatch)) {
      if (dig(parsedBody, key) !== want) return false;
    }
  }
  return true;
}

async function proxyThrough(req, reqPath, raw, res) {
  if (!UPSTREAM) {
    return json(res, 502, {
      error:
        "No expectation matched and PROXY_UPSTREAM_URL is not set, so there is nothing to proxy to. " +
        "Register an expectation for this request, or set PROXY_UPSTREAM_URL to the real provider.",
      method: req.method,
      path: reqPath,
    });
  }
  const target = UPSTREAM + req.url;
  const reqHeaders = { ...req.headers };
  delete reqHeaders.host;
  delete reqHeaders["content-length"];
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: reqHeaders,
      body: raw && req.method !== "GET" && req.method !== "HEAD" ? raw : undefined,
    });
    // Forward the response as raw bytes with its headers intact, so a proxied provider
    // response reaches the caller the same as talking to the provider directly. Drop only
    // hop-by-hop headers and content-encoding/length (fetch already decoded the body).
    const buf = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    });
    const setCookies =
      typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
    if (setCookies.length) outHeaders["set-cookie"] = setCookies;
    res.writeHead(upstream.status, outHeaders);
    res.end(buf);
  } catch (e) {
    json(res, 502, { error: `proxy to ${UPSTREAM} failed`, detail: String(e) });
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding", // fetch transparently decompresses, so the original encoding no longer applies
  "content-length", // Node recomputes from the body we send
]);

const server = http.createServer(async (req, res) => {
  const method = (req.method ?? "GET").toUpperCase();
  const reqPath = pathOf(req.url ?? "");

  // ---- Control plane -------------------------------------------------------
  if (reqPath.startsWith("/__proxy/")) {
    if (method === "GET" && reqPath === "/__proxy/health") {
      return json(res, 200, { status: "ok", upstream: UPSTREAM || null });
    }
    if (method === "POST" && reqPath === "/__proxy/expectations") {
      const payload = parseJson(await readBody(req)) ?? {};
      const exp = toExpectation(payload);
      expectations.push(exp);
      return json(res, 201, { id: exp.id });
    }
    if (method === "DELETE" && reqPath === "/__proxy/expectations") {
      expectations.length = 0;
      journal.length = 0; // a full reset clears captures too
      return json(res, 200, { cleared: true });
    }
    if (method === "DELETE" && reqPath.startsWith("/__proxy/expectations/")) {
      const id = reqPath.slice("/__proxy/expectations/".length);
      const i = expectations.findIndex((e) => e.id === id);
      if (i >= 0) expectations.splice(i, 1);
      // Prune this expectation's captures so the journal tracks only live expectations.
      pruneJournalBy(id);
      return json(res, 200, { removed: i >= 0 });
    }
    if (method === "GET" && reqPath === "/__proxy/requests") {
      // Scope reads to a single expectation id, and/or a body-field equality, so a caller
      // never sees another scenario's captures. bodyPath/bodyValue is provider-agnostic
      // (e.g. bodyPath=email for mail); the compare is case-insensitive.
      const q = new URLSearchParams(req.url?.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "");
      const byId = q.get("expectationId");
      const bodyPath = q.get("bodyPath");
      const bodyValue = q.get("bodyValue")?.toLowerCase();
      // The two are one filter and are useless apart: bodyPath alone would compare every
      // entry against undefined and quietly return [], which reads as "nothing was captured"
      // and sends the caller into a poll-until-timeout instead of naming the real mistake.
      if ((bodyPath == null) !== (bodyValue == null)) {
        return json(res, 400, {
          error: "bodyPath and bodyValue must be given together",
          got: { bodyPath: bodyPath ?? null, bodyValue: q.get("bodyValue") ?? null },
        });
      }
      const out = journal.filter((r) => {
        if (byId && r.matchedExpectationId !== byId) return false;
        if (bodyPath) {
          const actual = r.body && typeof r.body === "object" ? dig(r.body, bodyPath) : undefined;
          if (String(actual ?? "").toLowerCase() !== bodyValue) return false;
        }
        return true;
      });
      return json(res, 200, out);
    }
    if (method === "DELETE" && reqPath === "/__proxy/requests") {
      journal.length = 0;
      return json(res, 200, { cleared: true });
    }
    return json(res, 404, { error: "unknown control-plane route", path: reqPath });
  }

  // ---- Data plane ----------------------------------------------------------
  const raw = await readBody(req);
  const parsedBody = parseJson(raw);
  // Newest matching expectation wins, so a re-registration supersedes an older one.
  let exp;
  for (let i = expectations.length - 1; i >= 0; i--) {
    if (matches(expectations[i], method, reqPath, parsedBody)) {
      exp = expectations[i];
      break;
    }
  }

  if (exp) {
    // Record only matched (test-scoped) traffic — never real users' proxied mail.
    // push()+trim is synchronous, so concurrent sends can't interleave here.
    journal.push({
      id: `req_${++seq}`,
      method,
      path: reqPath,
      body: parsedBody ?? raw,
      receivedAt: Date.now(),
      matchedExpectationId: exp.id,
    });
    if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
    return res.writeHead(exp.respond.status, exp.respond.headers).end(exp.respond.body);
  }

  return proxyThrough(req, reqPath, raw, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `provider-proxy listening on http://localhost:${PORT}` +
      (UPSTREAM ? ` (unmatched -> ${UPSTREAM})` : " (no upstream; unmatched -> 502)")
  );
});
