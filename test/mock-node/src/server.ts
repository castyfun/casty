import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Control, parseControl } from "./control.js";
import { type Fixtures, loadFixtures } from "./fixtures.js";
import { BadRequest, nodeError, ok, type Reply } from "./reply.js";
import { accountRoutes } from "./routes/accounts.js";
import { info } from "./routes/info.js";
import { messageRoutes } from "./routes/messages.js";
import { submit } from "./routes/submit.js";
import { applyControl, createState, type State } from "./state.js";

export interface MockNodeOptions {
  /** A fixture set name under fixtures/, a directory, or fixtures already in memory. */
  fixtures?: string | Fixtures;
  port?: number;
  host?: string;
}

export interface MockNode {
  url: string;
  state: State;
  control(patch: Partial<Control>): void;
  close(): Promise<void>;
}

const GET_ROUTES: Record<string, (state: State, params: URLSearchParams) => Reply> = {
  "/v1/info": info,
  ...messageRoutes,
  ...accountRoutes,
  "/__mock/state": (state) =>
    ok({
      fids: state.fids.size,
      casts: state.casts.length,
      links: state.links.length,
      reactions: state.reactions.length,
      userdata: state.userdata.length,
      verifications: state.verifications.length,
      signers: [...state.signers.values()].reduce((n, s) => n + s.signers.length, 0),
      events: state.events.length,
      ...state.stats,
    }),
};

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function route(state: State, req: IncomingMessage): Promise<Reply> {
  const url = new URL(req.url ?? "/", "http://mock");
  if (req.method === "GET") {
    if (state.control.failReads > 0 && url.pathname.startsWith("/v1/")) {
      state.control.failReads--;
      return nodeError(503, "unavailable", "the node is too busy to answer");
    }
    const handler = GET_ROUTES[url.pathname];
    if (handler) return handler(state, url.searchParams);
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    if (url.pathname === "/v1/submitMessage") return submit(state, body, true);
    if (url.pathname === "/v1/validateMessage") return submit(state, body, false);
    if (url.pathname === "/__mock/control") {
      applyControl(state, parseControl(JSON.parse(Buffer.from(body).toString() || "{}")));
      return ok(state.control);
    }
  }
  return nodeError(404, "not_found", `no route for ${req.method} ${url.pathname}`);
}

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.stats.inFlight++;
  state.stats.maxInFlight = Math.max(state.stats.maxInFlight, state.stats.inFlight);
  let reply: Reply;
  try {
    if (state.control.latencyMs > 0)
      await new Promise((r) => setTimeout(r, state.control.latencyMs));
    reply = await route(state, req);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const status = error instanceof BadRequest || error instanceof SyntaxError ? 400 : 500;
    reply = nodeError(
      status,
      status === 400 ? "bad_request.validation_failure" : "unavailable",
      details,
    );
  } finally {
    state.stats.inFlight--;
  }
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
}

/** Starts an in-memory Snapchain HTTP API on 127.0.0.1 (port 0 picks a free one). */
export async function createMockNode(options: MockNodeOptions = {}): Promise<MockNode> {
  const fixtures = options.fixtures ?? "basic";
  const state = createState(typeof fixtures === "string" ? loadFixtures(fixtures) : fixtures);
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => void handle(state, req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    state,
    control: (patch) => applyControl(state, parseControl(patch)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
