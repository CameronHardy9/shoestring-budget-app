// e2e edge: the one trusted proxy hop in front of the make e2e stack (F-08,
// F-21). It plays the platform's front end (Cloud Run's, ADR-0007), which is
// the only thing that tells the backend who the client is:
//   - it APPENDS the client address it sees to X-Forwarded-For, after anything
//     the client sent (so a forged leftmost entry stays leftmost);
//   - with TRUST_PROXY_HOPS=1 the backend trusts exactly its socket peer and
//     takes the RIGHTMOST X-Forwarded-For entry as the client IP.
// "The client address it sees" is the TCP peer, normalised from ::ffff:a.b.c.d
// to a.b.c.d. Through Docker's port publishing that is one fixed gateway or
// host address for every request (it differs between OrbStack and Linux CI, so
// tests must not hard-code it). To act as different clients, a test sends
// `X-E2E-Client-IP: <ip>`: the edge uses that value instead of the TCP peer and
// removes the header, so the backend never sees it. A value that is not one
// IPv4 or IPv6 address gets 400 from the edge itself.
// Nothing else is changed: Host, Origin, cookies and any X-Forwarded-* the
// client sent pass through as they are.
//
// Routes come from EDGE_ROUTES, "<listen port>=<host>:<port>" separated by
// commas (docker-compose.test.yml). GET /__edge/healthz is answered here.
// Plain JavaScript, no dependencies, only in docker-compose.test.yml. Never in
// an image or in production.
import http from "node:http";
import net from "node:net";

const OVERRIDE = "x-e2e-client-ip";
const HEALTH = "/__edge/healthz";
// Hop-by-hop headers (RFC 9110 7.6.1): each connection sets its own.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const routes = (process.env.EDGE_ROUTES ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const m = /^(\d+)=([A-Za-z0-9.-]+):(\d+)$/.exec(r);
    if (!m)
      throw new Error(
        `edge: bad route "${r}", want <listen port>=<host>:<port>`,
      );
    return {
      listen: Number(m[1]),
      host: m[2],
      port: Number(m[3]),
    };
  });
if (routes.length === 0) throw new Error("edge: EDGE_ROUTES is empty");

/** The client IP this edge vouches for, or null when the override is invalid. */
function clientIp(req) {
  const sent = req.headers[OVERRIDE];
  if (sent !== undefined) {
    const v = String(sent).trim();
    return net.isIP(v) === 0 ? null : v;
  }
  const peer = req.socket.remoteAddress ?? "";
  return peer.startsWith("::ffff:") && net.isIP(peer.slice(7)) === 4
    ? peer.slice(7)
    : peer;
}

// Header names are copied only when they are an RFC 9110 token (5.1, 5.6.2)
// and not one of the prototype property names, and values only when they hold
// no control characters other than tab (5.5). Headers travel as flat
// [name, value, ...] arrays, never as object keys, so a name such as
// `__proto__` can never reach an object's prototype.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const PROTO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** The name, lowercased, if it may be forwarded; otherwise null. */
function safeName(name) {
  if (typeof name !== "string" || !TOKEN.test(name)) return null;
  const lower = name.toLowerCase();
  return PROTO_NAMES.has(lower) ? null : lower;
}

/**
 * Copies raw [name, value, ...] pairs that pass safeName and FIELD_VALUE,
 * except those whose lowercased name `skip` returns true for. Original name
 * casing, order and repeats (Set-Cookie) are kept.
 */
function copyRaw(raw, skip) {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = safeName(raw[i]);
    const value = raw[i + 1];
    if (lower === null || skip(lower)) continue;
    if (typeof value !== "string" || !FIELD_VALUE.test(value)) continue;
    out.push(raw[i], value);
  }
  return out;
}

/** The request headers to send upstream, as a flat raw array. */
function forwardedHeaders(req, ip, keepUpgrade) {
  const out = copyRaw(
    req.rawHeaders,
    (k) =>
      k === OVERRIDE ||
      k === "x-forwarded-for" ||
      (HOP.has(k) && !(keepUpgrade && (k === "connection" || k === "upgrade"))),
  );
  // Exactly one entry appended: the client's own X-Forwarded-For lines, joined
  // with ", " in order as Node does for req.headers, then this edge's entry.
  const prior = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === "x-forwarded-for")
      prior.push(req.rawHeaders[i + 1]);
  }
  const joined = prior.join(", ");
  const xff = joined ? `${joined}, ${ip}` : ip;
  if (FIELD_VALUE.test(xff)) out.push("X-Forwarded-For", xff);
  return out;
}

/** A valid HTTP status code from upstream, or 502. */
function safeStatus(code) {
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : 502;
}

function plain(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function serve(route) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === HEALTH)
      return plain(res, 200, "ok\n");
    const ip = clientIp(req);
    if (ip === null)
      return plain(
        res,
        400,
        `edge: ${OVERRIDE} must be one IPv4 or IPv6 address\n`,
      );
    const up = http.request({
      host: route.host,
      port: route.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, ip, false),
      setHost: false,
      // A fresh upstream connection per request, on purpose. A keep-alive
      // agent was tried (2026-11-16): it saved ~0.3 ms per request but made no
      // measurable difference to the API suites (168 s either way), and it
      // broke tests that send an oversized body. The backend answers 413 to a
      // body over 64 KiB and closes the socket without reading the rest; on a
      // reused socket the edge then hits EPIPE while still writing the body,
      // before it has read the 413, and answers 502 (4 failures in two runs,
      // none without it).
      agent: false,
    });
    up.on("response", (ures) => {
      // Response headers pass the same name and value checks; hop-by-hop ones
      // are dropped (this connection sets its own). Set-Cookie and the
      // security headers pass unchanged, repeats included. Status and headers
      // are sent with the first body chunk (or at the end of an empty body).
      const raw = copyRaw(ures.rawHeaders, (k) => HOP.has(k));
      res.statusCode = safeStatus(ures.statusCode);
      for (let i = 0; i + 1 < raw.length; i += 2)
        res.appendHeader(raw[i], raw[i + 1]);
      ures.pipe(res);
    });
    up.on("error", (err) => {
      process.stderr.write(
        `edge: ${route.host}:${route.port} ${err.code ?? err.message}\n`,
      );
      if (!res.headersSent) plain(res, 502, "edge: upstream unavailable\n");
      else res.destroy();
    });
    // Client gone before the response finished: drop that upstream socket
    // rather than return a half-read one to the pool.
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  });

  // WebSocket upgrades (Vite's HMR client), piped through after the same
  // X-Forwarded-For handling.
  server.on("upgrade", (req, socket, head) => {
    const ip = clientIp(req);
    if (ip === null)
      return socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
      );
    const up = net.connect(route.port, route.host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      const fwd = forwardedHeaders(req, ip, true);
      for (let i = 0; i + 1 < fwd.length; i += 2)
        raw += `${fwd[i]}: ${fwd[i + 1]}\r\n`;
      up.write(`${raw}\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  server.listen(route.listen, "0.0.0.0", () => {
    process.stdout.write(
      `edge: :${route.listen} -> ${route.host}:${route.port}\n`,
    );
  });
}

for (const r of routes) serve(r);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
