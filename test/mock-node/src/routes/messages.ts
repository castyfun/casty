import {
  BadRequest,
  intParam,
  notFound,
  ok,
  page,
  type Reply,
  shardedPage,
  stringParam,
} from "../reply.js";
import { custodyOf, type State } from "../state.js";
import type { WireMessage } from "../wire.js";

type Handler = (state: State, params: URLSearchParams) => Reply;

/** Oldest first, ties broken by hash, as `reverse=false` pages come from the node. */
const sorted = (messages: WireMessage[]) =>
  messages.toSorted((a, b) => a.data.timestamp - b.data.timestamp || a.hash.localeCompare(b.hash));

const REACTION_TYPES: Record<string, string> = {
  Like: "REACTION_TYPE_LIKE",
  Recast: "REACTION_TYPE_RECAST",
  REACTION_TYPE_LIKE: "REACTION_TYPE_LIKE",
  REACTION_TYPE_RECAST: "REACTION_TYPE_RECAST",
};

function reactionType(params: URLSearchParams): string | undefined {
  const raw = params.get("reaction_type");
  if (!raw) return undefined;
  const type = REACTION_TYPES[raw];
  if (!type) throw new BadRequest(`unknown reaction_type ${raw}`);
  return type;
}

const _USER_DATA_NUMBERS: Record<string, string> = {
  "1": "USER_DATA_TYPE_PFP",
  "2": "USER_DATA_TYPE_DISPLAY",
  "3": "USER_DATA_TYPE_BIO",
  "5": "USER_DATA_TYPE_URL",
  "6": "USER_DATA_TYPE_USERNAME",
};

function usernameProofs(state: State, fid?: number) {
  return state.userdata
    .filter((m) => m.data.userDataBody?.type === "USER_DATA_TYPE_USERNAME")
    .filter((m) => fid === undefined || m.data.fid === fid)
    .map((m) => ({
      timestamp: m.data.timestamp,
      name: m.data.userDataBody?.value ?? "",
      owner: custodyOf(state, m.data.fid) ?? "0x",
      signature: "",
      fid: m.data.fid,
      type: "USERNAME_TYPE_FNAME",
    }));
}

export const messageRoutes: Record<string, Handler> = {
  "/v1/castById": (state, p) => {
    const fid = intParam(p, "fid");
    const hash = stringParam(p, "hash").toLowerCase();
    const cast = state.casts.find((c) => c.data.fid === fid && c.hash === hash);
    return cast ? ok(cast) : notFound(`no cast ${hash} by fid ${fid}`);
  },
  "/v1/castsByFid": (state, p) => {
    const fid = intParam(p, "fid");
    return page(sorted(state.casts.filter((c) => c.data.fid === fid)), p);
  },
  "/v1/castsByParent": (state, p) => {
    const url = p.get("url");
    if (url)
      return shardedPage(
        sorted(state.casts.filter((c) => c.data.castAddBody?.parentUrl === url)),
        p,
      );
    const fid = intParam(p, "fid");
    const hash = stringParam(p, "hash").toLowerCase();
    const replies = state.casts.filter((c) => {
      const parent = c.data.castAddBody?.parentCastId;
      return parent?.fid === fid && parent.hash === hash;
    });
    return shardedPage(sorted(replies), p);
  },
  "/v1/castsByMention": (state, p) => {
    const fid = intParam(p, "fid");
    return shardedPage(
      sorted(state.casts.filter((c) => c.data.castAddBody?.mentions.includes(fid))),
      p,
    );
  },
  "/v1/reactionsByFid": (state, p) => {
    const fid = intParam(p, "fid");
    const type = reactionType(p);
    const mine = state.reactions.filter(
      (r) => r.data.fid === fid && (!type || r.data.reactionBody?.type === type),
    );
    return page(sorted(mine), p);
  },
  "/v1/reactionById": (state, p) => {
    const fid = intParam(p, "fid");
    const targetFid = intParam(p, "target_fid");
    const hash = stringParam(p, "target_hash").toLowerCase();
    const type = reactionType(p);
    const one = state.reactions.find((r) => {
      const target = r.data.reactionBody?.targetCastId;
      return (
        r.data.fid === fid &&
        r.data.reactionBody?.type === type &&
        target?.fid === targetFid &&
        target.hash === hash
      );
    });
    return one ? ok(one) : notFound(`no ${type} by fid ${fid} on ${hash}`);
  },
  "/v1/linkById": (state, p) => {
    const fid = intParam(p, "fid");
    const target = intParam(p, "target_fid");
    const type = stringParam(p, "link_type");
    const one = state.links.find(
      (l) =>
        l.data.fid === fid &&
        l.data.linkBody?.targetFid === target &&
        l.data.linkBody.type === type,
    );
    return one ? ok(one) : notFound(`no ${type} link from fid ${fid} to fid ${target}`);
  },
  "/v1/linksByFid": (state, p) => {
    const fid = intParam(p, "fid");
    const type = p.get("link_type");
    const links = state.links.filter(
      (l) => l.data.fid === fid && (!type || l.data.linkBody?.type === type),
    );
    return page(sorted(links), p);
  },
  "/v1/linksByTargetFid": (state, p) => {
    const fid = intParam(p, "target_fid");
    const type = p.get("link_type");
    const links = state.links.filter(
      (l) => l.data.linkBody?.targetFid === fid && (!type || l.data.linkBody?.type === type),
    );
    return page(sorted(links), p);
  },
  // Snapchain 0.14 parses user_data_type and then ignores it: every type comes back, as a page.
  "/v1/userDataByFid": (state, p) =>
    page(sorted(state.userdata.filter((m) => m.data.fid === intParam(p, "fid"))), p),
  "/v1/verificationsByFid": (state, p) => {
    const fid = intParam(p, "fid");
    return page(sorted(state.verifications.filter((v) => v.data.fid === fid)), p);
  },
  "/v1/userNameProofsByFid": (state, p) =>
    ok({ proofs: usernameProofs(state, intParam(p, "fid")) }),
  "/v1/userNameProofByName": (state, p) => {
    const name = stringParam(p, "name");
    const proof = usernameProofs(state).find((proof) => proof.name === name);
    return proof ? ok(proof) : notFound(`no proof for ${name}`);
  },
  "/v1/events": (state, p) => {
    const from = Number(p.get("from_event_id") ?? 0);
    const shard = p.get("shard_index");
    return page(
      state.events.filter(
        (e) => e.id >= from && (shard === null || e.shardIndex === Number(shard)),
      ),
      p,
      "events",
    );
  },
};
