import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeAtomic } from "../config.js";
import { CastyError } from "../errors.js";
import { NotMergedError } from "../node/errors.js";
import { apiRoutes, HttpError, type WebDeps } from "./api.js";
import { API_LIMIT, rateLimiter } from "./limits.js";

export type { WebDeps } from "./api.js";

export interface Web {
  url: string;
  /** Writes still being answered, such as a cast waiting for its message to merge. */
  pending(): number;
  /** Stops taking requests, lets the writes in flight finish, then closes. */
  close(): Promise<void>;
}

const TOKEN_FILE = "web-token";
const ASSETS_DIR = new URL("./assets/", import.meta.url);
const ASSETS: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
};

// The page loads nothing from anywhere else: cast text is written by strangers, and links in it
// open only when you follow them.
const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
    // The page writes no HTML from strings anywhere, so it can refuse every such sink.
    "require-trusted-types-for 'script'; trusted-types 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** The token the page must send: the one in `dir/web-token`, or a new one with `renew`. */
export function chooseToken(dir: string, renew: boolean): string {
  const path = join(dir, TOKEN_FILE);
  if (!renew && existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token;
  }
  return randomBytes(32).toString("base64url");
}

/** Keeps the token (0600) so a paired phone stays paired across restarts. */
export function saveToken(dir: string, token: string): void {
  const path = join(dir, TOKEN_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path, `${token}\n`, 0o600);
}

/**
 * HTTP status for an error a command would exit with: usage 400, refused by the node 422, not
 * merged in time 504, node unreachable 502. A local setup that cannot write (no listed key, a
 * damaged store) answers 403, as a read-only page does.
 */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotMergedError) return 504;
  if (error instanceof CastyError) return { 2: 400, 3: 422, 4: 502, 5: 403 }[error.exitCode] ?? 500;
  return 500;
}

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;
/** Text over a kilobyte goes gzipped to a browser that takes it: a phone on Wi-Fi reads less. */
const worthGzip = (type: string, body: Buffer) => COMPRESSIBLE.test(type) && body.length > 1024;

/** Whether the request takes gzip: listed, and not with q=0. */
function takesGzip(req: IncomingMessage): boolean {
  return (req.headers["accept-encoding"] ?? "").split(",").some((part) => {
    const [name, ...params] = part.split(";").map((p) => p.trim());
    const q = params.find((p) => p.startsWith("q="));
    return name === "gzip" && (q === undefined || Number(q.slice(2)) > 0);
  });
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  let data = typeof body === "string" ? Buffer.from(body) : body;
  const out: Record<string, string> = {
    ...HEADERS,
    "content-type": type,
    "cache-control": "no-store",
  };
  if (worthGzip(type, data)) {
    out.vary = "accept-encoding";
    if (takesGzip(req)) {
      data = gzipSync(data);
      out["content-encoding"] = "gzip";
    }
  }
  out["content-length"] = String(data.length);
  res.writeHead(status, out).end(data);
}

type Asset = ReturnType<typeof assetOf>;

/**
 * One of the page's files: revalidated on every load and answered with 304 while unchanged,
 * gzipped once at startup, and with an ETag of its own for each encoding.
 */
function sendAsset(req: IncomingMessage, res: ServerResponse, asset: Asset): void {
  const gzip = asset.gzip && takesGzip(req) ? asset.gzip : undefined;
  const etag = gzip ? `"${asset.tag}-gz"` : `"${asset.tag}"`;
  const headers: Record<string, string> = {
    ...HEADERS,
    "content-type": asset.type,
    "cache-control": "no-cache",
    etag,
    ...(asset.gzip ? { vary: "accept-encoding" } : {}),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  const data = gzip ?? asset.body;
  if (gzip) headers["content-encoding"] = "gzip";
  headers["content-length"] = String(data.length);
  res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : data);
}

const json = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown) =>
  send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));

/**
 * An IP literal, localhost, the --listen host or casty serve's public host: any other DNS name
 * pointed at this machine (rebinding) is refused.
 */
function hostAllowed(header: string | undefined, listenHost: string, publicHost?: string) {
  if (!header) return false;
  const host = header.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (publicHost && host.toLowerCase() === publicHost.toLowerCase()) return true;
  return host === "localhost" || host === listenHost || isIP(host) !== 0;
}

/**
 * Who is asking, for the request limit: behind the proxy a public host stands for, the address
 * it appended last to X-Forwarded-For (an earlier one is whatever the client sent); without a
 * proxy the socket's, since a client may send any header it likes.
 */
function clientOf(req: IncomingMessage, proxied: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  return (proxied ? last : undefined) ?? req.socket.remoteAddress ?? "";
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const assetOf = (type: string, body: Buffer) => ({
  type,
  body,
  gzip: worthGzip(type, body) ? gzipSync(body) : undefined,
  tag: createHash("sha256").update(body).digest("base64url").slice(0, 16),
});

export interface Listen {
  host: string;
  port: number;
  /**
   * casty serve: the domain a proxy that ends HTTPS reaches the page at, accepted as Host and
   * sent as HSTS.
   */
  publicHost?: string | undefined;
  /** casty serve: the API is limited per client address, since more than one network may reach it. */
  limit?: boolean | undefined;
}

/** Serves the page and its JSON API on `host:port` (0 picks a free port). */
export async function startWeb(deps: WebDeps, listen: Listen): Promise<Web> {
  const routes = apiRoutes(deps);
  const limiter = listen.limit ? rateLimiter(API_LIMIT, 60_000) : undefined;
  const assets = new Map(
    Object.entries(ASSETS).map(([path, [file, type]]) => [
      path,
      assetOf(type, readFileSync(new URL(file, ASSETS_DIR))),
    ]),
  );
  let writes = 0;
  let settled = () => {};

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (listen.publicHost) res.setHeader("strict-transport-security", "max-age=31536000");
    if (!hostAllowed(req.headers.host, listen.host, listen.publicHost)) {
      return send(req, res, 403, "text/plain; charset=utf-8", "unexpected Host header\n");
    }
    const url = new URL(req.url ?? "/", "http://casty");
    const reading = req.method === "GET" || req.method === "HEAD";
    const asset = reading ? assets.get(url.pathname) : undefined;
    if (asset) return sendAsset(req, res, asset);
    if (!url.pathname.startsWith("/api/")) {
      return send(req, res, 404, "text/plain; charset=utf-8", "not found\n");
    }
    const taken = limiter?.take(clientOf(req, Boolean(listen.publicHost)));
    if (taken && !taken.allowed) {
      res.setHeader("retry-after", String(taken.retryAfter));
      return json(req, res, 429, {
        error: `more than ${API_LIMIT} requests a minute from this address`,
        hint: `try again in ${taken.retryAfter} s`,
      });
    }
    if (!authorized(req, deps.token)) {
      return json(req, res, 401, {
        error: "this page is not paired",
        hint: "open the link casty web printed",
      });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return json(req, res, 404, { error: `no ${req.method} ${url.pathname}` });
    json(req, res, 200, await route(url, req));
  }

  const server = createServer(async (req, res) => {
    const write = req.method === "POST";
    if (write) writes++;
    try {
      await answer(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error instanceof CastyError ? error.hint : undefined;
      json(req, res, statusOf(error), { error: message, ...(hint ? { hint } : {}) });
    } finally {
      if (write && --writes === 0) settled();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : listen.port;
  const shown = isIP(listen.host) === 6 ? `[${listen.host}]` : listen.host;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${shown}:${port}`,
    pending: () => writes,
    close: () => {
      closing ??= (async () => {
        server.close();
        server.closeIdleConnections();
        if (writes > 0) await new Promise<void>((resolve) => (settled = resolve));
        server.closeAllConnections();
      })();
      return closing;
    },
  };
}
