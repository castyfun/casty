export interface Reply {
  status: number;
  body: unknown;
}

/** Thrown by handlers for a bad request; the server answers 400 with the node's error shape. */
export class BadRequest extends Error {}

export const ok = (body: unknown): Reply => ({ status: 200, body });

/** The real node's error body, as shown in the HTTP API reference. */
export function nodeError(status: number, errCode: string, details: string): Reply {
  const body = {
    errCode,
    presentable: false,
    name: "HubError",
    code: 3,
    details,
    metadata: { errcode: [errCode] },
  };
  return { status, body };
}

/**
 * A lookup that finds nothing, as Snapchain 0.14 answers it (seen on a mainnet node): HTTP 400,
 * no errCode, the gRPC status inside `error_detail`.
 */
export const notFound = (details: string): Reply => ({
  status: 400,
  body: {
    error: "Failed to get",
    error_detail: `status: NotFound, message: "${details}", details: [], metadata: MetadataMap { headers: {} }`,
  },
});
export const rejected = (details: string) =>
  nodeError(400, "bad_request.validation_failure", details);

export function intParam(params: URLSearchParams, name: string): number {
  const value = Number(params.get(name));
  if (!params.has(name) || !Number.isInteger(value))
    throw new BadRequest(`${name} must be an integer`);
  return value;
}

export function stringParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw new BadRequest(`${name} is required`);
  return value;
}

/** pageSize/pageToken/reverse over an already sorted list; tokens are base64 indexes. */
export function page<T>(items: T[], params: URLSearchParams, key = "messages"): Reply {
  const reverse = params.get("reverse") === "true" || params.get("reverse") === "1";
  const ordered = reverse ? items.toReversed() : items;
  const size = Math.max(1, Number(params.get("pageSize") ?? 1000) || 1000);
  const token = params.get("pageToken");
  const start = token ? Number(Buffer.from(token, "base64").toString()) : 0;
  const end = start + size;
  const nextPageToken = end < ordered.length ? Buffer.from(String(end)).toString("base64") : "";
  return ok({ [key]: ordered.slice(start, end), nextPageToken });
}

/**
 * A page as Snapchain 0.14 answers a query that spans accounts (castsByMention, castsByParent;
 * seen on a mainnet node): each shard contributes up to pageSize items, one run after the
 * other, each run in its own order, and the token is a JSON array of the shards' own tokens.
 * Here an account's shard is its fid's parity.
 */
export function shardedPage<T extends { data: { fid: number } }>(
  items: T[],
  params: URLSearchParams,
): Reply {
  const reverse = params.get("reverse") === "true" || params.get("reverse") === "1";
  const size = Math.max(1, Number(params.get("pageSize") ?? 1000) || 1000);
  const token = params.get("pageToken");
  const starts: (number | null)[] = token
    ? JSON.parse(Buffer.from(token, "base64").toString())
    : [0, 0];
  const messages: T[] = [];
  const next = [0, 1].map((shard, i) => {
    const start = starts[i] ?? null;
    if (start === null) return null;
    const own = items.filter((m) => m.data.fid % 2 === shard);
    const run = reverse ? own.toReversed() : own;
    messages.push(...run.slice(start, start + size));
    return start + size < run.length ? start + size : null;
  });
  const nextPageToken = next.every((n) => n === null)
    ? ""
    : Buffer.from(JSON.stringify(next)).toString("base64");
  return ok({ messages, nextPageToken });
}
