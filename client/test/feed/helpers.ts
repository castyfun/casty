import type { NodeMessage } from "../../src/node/http.js";

/** A minimal cast as the node would print it, for pure feed tests. */
export function cast(
  fid: number,
  timestamp: number,
  hash: string,
  extra: Partial<NodeMessage["data"]> = {},
): NodeMessage {
  return {
    data: {
      type: "MESSAGE_TYPE_CAST_ADD",
      fid,
      timestamp,
      network: "FARCASTER_NETWORK_MAINNET",
      castAddBody: { text: `cast ${hash}`, mentions: [], mentionsPositions: [], embeds: [] },
      ...extra,
    },
    hash: `0x${hash.padStart(40, "0")}`,
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: "",
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: `0x${"11".repeat(32)}`,
  };
}
