// Tiny, dependency-free provider proxy-mock (Node built-in http only).
//
// It sits in front of the outbound providers the VecheMoga API calls (Loops, for both
// transactional email and ESP contact sync; any other HTTP provider later). The API's
// off-prod profiles already point their provider base-urls at it (vechemoga.email.loops
// and vechemoga.esp.loops), and it behaves like WireMock's proxy pattern:
//
//   - Unmatched traffic is STUBBED with 200 {"success":true} and journaled. Nothing
//     reaches the real provider, so off-prod can point the real Loops clients here and
//     run the whole pipeline for real - including a poller that registers no
//     expectation at all, which is simply absorbed.
//   - Set PROXY_UPSTREAM_URL to forward unmatched traffic to the real provider and
//     return its response instead. Deliberately UNSET in the local stack (see
//     ../.env.example): off is what keeps a laptop from mailing a real inbox.
//   - A test registers an EXPECTATION at runtime (keyed on a unique field, the
//     way Sesame keys a WireMock stub on a player id). A request matching that
//     expectation gets that expectation's canned response instead of the stub, and
//     its capture is tagged with the expectation id so a parallel suite can read
//     back exactly its own (e.g. the emailed verification link, whose token is only
//     stored hashed in the DB).
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
//   GET    /__proxy/requests           recorded requests, newest last
//   DELETE /__proxy/requests           clear the journal
//   GET    /__proxy/health             { status, upstream }
//
// Data plane: anything else -> newest matching expectation wins (its canned response
// + journal), else PROXY_UPSTREAM_URL if set, else the stub (+ journal).

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
// Where unmatched traffic is proxied. Unset off-prod, where unmatched is stubbed
// instead: that is the only thing standing between a dev machine and a real inbox.
const UPSTREAM = (process.env.PROXY_UPSTREAM_URL ?? "").replace(/\/$/, "");
// Hard bound on the journal, enforced as a ring buffer (oldest dropped first).
// Disposing an expectation prunes its own captures, but stubbed unmatched entries are
// tagged with no expectation id and so can never be pruned that way - a long-running
// stack's poller appends forever. This cap, and DELETE /__proxy/requests, are their
// only bounds, which is why it is enforced on every append rather than trusted to
// tidy clients.
const JOURNAL_MAX = intEnv("PROXY_JOURNAL_MAX", 5000);

let seq = 0;
/** @type {{ id: string, method?: string, path?: string, bodyMatch?: Record<string, unknown>, respond: { status: number, headers: Record<string,string>, body: string } }[]} */
const expectations = [];
/** matchedExpectationId is null for a stubbed (unmatched) request — nothing claimed it.
 *  @type {{ id: string, method: string, path: string, body: unknown, receivedAt: number, matchedExpectationId: string | null }[]} */
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

/** Append one capture, trimming the oldest past JOURNAL_MAX. push()+splice is synchronous,
 *  so concurrent sends can't interleave and lose an entry. */
function record(method, reqPath, body, matchedExpectationId) {
  journal.push({
    id: `req_${++seq}`,
    method,
    path: reqPath,
    body,
    receivedAt: Date.now(),
    matchedExpectationId,
  });
  if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
}

/** Drop journal entries captured for a given expectation id (called when it's disposed).
 *  Stubbed entries carry a null id and are never pruned here — see JOURNAL_MAX. */
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

/** Forward to the real provider and return its response verbatim. Only called with an
 *  UPSTREAM set; without one, unmatched traffic is stubbed instead. */
async function proxyThrough(req, raw, res) {
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
      // (e.g. bodyPath=email for mail); the compare is case-insensitive. It is also the
      // only way to read a stubbed capture, which has no expectation id to scope by.
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
    record(method, reqPath, parsedBody ?? raw, exp.id);
    return res.writeHead(exp.respond.status, exp.respond.headers).end(exp.respond.body);
  }

  // Passthrough is opt-in and is the only path that reaches a real provider. It is also
  // the only unjournaled one: a proxied request is a real user's, not a test's capture.
  if (UPSTREAM) return proxyThrough(req, raw, res);

  // No expectation, no upstream: stub it and record it. This is what lets off-prod point
  // the real provider clients here — an unregistered send (the ESP poller sweeping every
  // contact every 60s) is absorbed as a success rather than failed and retried into
  // permanent abandonment. A suite that forgot to expect() still fails, but on its own
  // assertion against the journal, which names the mistake.
  record(method, reqPath, parsedBody ?? raw, null);
  return json(res, 200, { success: true });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `provider-proxy listening on http://localhost:${PORT}` +
      (UPSTREAM ? ` (unmatched -> ${UPSTREAM})` : " (no upstream; unmatched -> stubbed 200 + journaled)")
  );
});
