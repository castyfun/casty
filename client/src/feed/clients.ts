import type { Cache } from "../config.js";
import type { Hex, NodeClient, SignerInfo } from "../node/http.js";
import { scopeNames } from "../protocol/scopes.js";
import { CONCURRENCY, mapLimit } from "./fanout.js";

/**
 * The fid of the app that requested a key. Gasless keys carry it as `requestFid`; onchain keys
 * carry the same SignedKeyRequest struct ABI-encoded in their signer event metadata: a tuple
 * (requestFid, requestSigner, signature, deadline) with a dynamic member, so the first word is
 * where the tuple starts and requestFid is its first word. Read by hand, as @farcaster/core's
 * decoder would read it, so neither @farcaster/core (about 300 ms) nor viem loads for a feed.
 */
export function requestFidOf(signer: SignerInfo): number | undefined {
  if (signer.requestFid !== undefined) return signer.requestFid;
  const event = signer.onChainEvent?.signerEventBody;
  if (event?.metadataType !== 1) return undefined;
  const metadata = Buffer.from(event.metadata, "base64");
  if (metadata.length < 32) return undefined;
  const at = Number(BigInt(`0x${metadata.subarray(0, 32).toString("hex")}`));
  if (metadata.length < at + 32) return undefined;
  return Number(BigInt(`0x${metadata.subarray(at, at + 32).toString("hex")}`));
}

export interface SignedBy {
  fid: number;
  signer: Hex;
}

/** The app behind each of `fid`'s keys (0 for none), as the signer cache keeps it. */
export async function signerApps(node: NodeClient, fid: number): Promise<Record<string, number>> {
  const { signers } = await node.signersByFid(fid);
  const requested = signers.map(requestFidOf);
  return Object.fromEntries(signers.map((s, i) => [s.key, requested[i] ?? 0]));
}

/** Fills the signer cache for `fids` not in it yet, so a feed of theirs asks the node nothing. */
export async function warmSigners(
  node: NodeClient,
  fids: number[],
  cache: Cache<Record<string, number>>,
): Promise<void> {
  await mapLimit([...new Set(fids)], CONCURRENCY, async (fid) => {
    if (!cache.get(String(fid))) cache.set(String(fid), await signerApps(node, fid));
  });
  cache.save();
}

/**
 * Returns a function that maps `fid:signer` pairs to the requesting app's fid. Each author's
 * signers are fetched once per call and cached per author (signer key to request fid).
 */
export function appLabeller(node: NodeClient, cache: Cache<Record<string, number>> | undefined) {
  return async (pairs: SignedBy[]): Promise<Map<string, number>> => {
    const authors = [...new Set(pairs.map((p) => p.fid))];
    const byAuthor = new Map<number, Record<string, number>>();
    await mapLimit(authors, CONCURRENCY, async (fid) => {
      const seen = pairs.filter((p) => p.fid === fid).map((p) => p.signer);
      const cached = cache?.get(String(fid));
      let apps = cached ?? {};
      // A key added since the author was cached is not in it: ask the node again.
      if (!cached || seen.some((signer) => !(signer in cached))) {
        apps = await signerApps(node, fid);
        // A key no app requested, or that the node no longer lists, is remembered as 0 (no app)
        // so it is not asked about again.
        for (const signer of seen) apps[signer] ??= 0;
        cache?.set(String(fid), apps);
      }
      byAuthor.set(fid, apps);
    });
    const labels = new Map<string, number>();
    for (const { fid, signer } of pairs) {
      const app = byAuthor.get(fid)?.[signer];
      if (app) labels.set(`${fid}:${signer}`, app);
    }
    return labels;
  };
}

/** USERNAME user data for each fid; fids without one map to undefined. */
export async function usernames(
  node: NodeClient,
  fids: number[],
  cache: Cache<string> | undefined,
): Promise<Map<number, string | undefined>> {
  const names = new Map<number, string | undefined>();
  await mapLimit([...new Set(fids)], CONCURRENCY, async (fid) => {
    const cached = cache?.get(String(fid));
    if (cached !== undefined) {
      names.set(fid, cached || undefined);
      return;
    }
    const [message] = await node.userDataByFid(fid, "USER_DATA_TYPE_USERNAME");
    const name = message?.data.userDataBody?.value;
    cache?.set(String(fid), name ?? "");
    names.set(fid, name);
  });
  return names;
}

/** One row of `casty clients`. Onchain keys predate scopes and may sign anything. */
export interface SignerRow {
  key: Hex;
  type: "onchain" | "gasless";
  requestFid: number | null;
  app: string | null;
  scopes: string[];
  expiresAt: string | null;
  ours: boolean;
}

export async function describeSigners(
  node: NodeClient,
  fid: number,
  ours: string[],
): Promise<SignerRow[]> {
  const { signers } = await node.signersByFid(fid);
  const apps = signers.map(requestFidOf);
  const names = await usernames(
    node,
    apps.filter((app) => app !== undefined),
    undefined,
  );
  return signers.map((signer, i) => {
    const app = apps[i];
    return {
      key: signer.key,
      type: signer.source === "SIGNER_SOURCE_ONCHAIN" ? "onchain" : "gasless",
      requestFid: app ?? null,
      app: app === undefined ? null : (names.get(app) ?? null),
      scopes: scopeNames(signer.scopes),
      expiresAt: signer.expiresAt ? new Date(signer.expiresAt * 1000).toISOString() : null,
      ours: ours.includes(signer.key),
    };
  });
}
