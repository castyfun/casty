import { MAX_GASLESS_KEYS_PER_FID, MessageType } from "@farcaster/core";
import { BadRequest, intParam, notFound, ok, type Reply, stringParam } from "../reply.js";
import { type State, signersOf } from "../state.js";
import type { WireMessage, WireSigner, WireStorageLimits } from "../wire.js";

/** A signer as Snapchain 0.14 prints it: scopes as message type names, left out when empty. */
const wireSigner = ({ scopes, ...signer }: WireSigner) =>
  scopes.length
    ? { ...signer, scopes: scopes.map((t) => `MESSAGE_TYPE_${MessageType[t] ?? t}`) }
    : signer;

type Handler = (state: State, params: URLSearchParams) => Reply;

/**
 * `requesterFids` as serde_qs reads it, which a mainnet node does: `requesterFids[]=1` or
 * `requesterFids[0]=1`, once per fid. The bare key, alone or comma separated, is refused.
 */
function requesterFids(params: URLSearchParams): number[] {
  const bare = params.get("requesterFids");
  if (bare !== null) {
    throw new BadRequest(
      `Invalid query parameters: invalid type: string "${bare}", expected a sequence`,
    );
  }
  return [...params]
    .filter(([key]) => /^requesterFids\[\d*\]$/.test(key))
    .map(([, v]) => Number(v));
}

const NO_STORAGE: WireStorageLimits = { limits: [], units: 0, unit_details: [] };

export const accountRoutes: Record<string, Handler> = {
  "/v1/signersByFid": (state, p) => {
    const entry = signersOf(state, intParam(p, "fid"));
    const nonces = Object.fromEntries(
      requesterFids(p).map((fid) => [String(fid), entry.requesterFidNonces[String(fid)] ?? 0]),
    );
    return ok({
      signers: entry.signers.map(wireSigner),
      nextPageToken: "",
      gaslessSignerCount: entry.signers.filter((s) => s.source === "SIGNER_SOURCE_OFFCHAIN").length,
      gaslessSignerLimit: MAX_GASLESS_KEYS_PER_FID,
      currentUserNonce: entry.currentUserNonce,
      requesterFidNonces: nonces,
    });
  },
  "/v1/onChainSignersByFid": (state, p) => {
    const fid = intParam(p, "fid");
    return ok({
      events: state.onchain.filter((e) => e.fid === fid && e.type === "EVENT_TYPE_SIGNER"),
    });
  },
  "/v1/onChainEventsByFid": (state, p) => {
    const fid = intParam(p, "fid");
    const type = stringParam(p, "event_type");
    return ok({ events: state.onchain.filter((e) => e.fid === fid && e.type === type) });
  },
  "/v1/onChainIdRegistryEventByAddress": (state, p) => {
    const address = stringParam(p, "address").toLowerCase();
    const event = state.onchain.findLast(
      (e) => e.idRegisterEventBody?.to.toLowerCase() === address,
    );
    return event ? ok(event) : notFound(`no id registry event for ${address}`);
  },
  "/v1/storageLimitsByFid": (state, p) => {
    const fid = intParam(p, "fid");
    const stored = state.storage.get(fid) ?? NO_STORAGE;
    const live: Record<string, WireMessage[]> = {
      CASTS: state.casts,
      LINKS: state.links,
      REACTIONS: state.reactions,
      USER_DATA: state.userdata,
      VERIFICATIONS: state.verifications,
    };
    const limits = stored.limits.map((l) => {
      const store = live[l.name];
      return store ? { ...l, used: store.filter((m) => m.data.fid === fid).length } : l;
    });
    return ok({ ...stored, limits });
  },
};
