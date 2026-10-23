import { nodeError, ok, type Reply } from "../reply.js";
import { nextBlockDelay, type State } from "../state.js";

const NOT_REPORTED = 4294967295;

/** GET /v1/info, with blockDelay taken from the control sequence; 503 while `infoUnavailable`. */
export function info(state: State): Reply {
  if (state.control.infoUnavailable > 0) {
    state.control.infoUnavailable--;
    return nodeError(503, "unavailable", "the node is starting");
  }
  state.stats.infoCalls++;
  const blockDelay = nextBlockDelay(state);
  const calls = state.stats.infoCalls;
  const shardInfos = [0, 1, 2].map((shardId) => ({
    shardId,
    maxHeight: 1_000_000 + calls * 100 + shardId,
    numMessages: shardId === 0 ? 0 : state.casts.length,
    numFidRegistrations: state.fids.size,
    approxSize: 1_000_000_000 * calls,
    blockDelay,
    mempoolSize: shardId === 0 ? 0 : NOT_REPORTED,
  }));
  return ok({
    dbStats: {
      numMessages: state.casts.length,
      numFidRegistrations: state.fids.size,
      approxSize: 2_000_000_000 * calls,
    },
    numShards: 2,
    shardInfos,
    version: "0.0.0-mock",
    peer_id: "mock",
    nextEngineVersionTimestamp: 0,
  });
}
