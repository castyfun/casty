import { UsageError } from "../errors.js";

/**
 * Message types by number, as @farcaster/core's MessageType numbers them; test/protocol/scopes.test.ts
 * checks the table against it. Kept here so listing keys does not load the whole library.
 */
const MESSAGE_TYPES: Record<number, string> = {
  0: "NONE",
  1: "CAST_ADD",
  2: "CAST_REMOVE",
  3: "REACTION_ADD",
  4: "REACTION_REMOVE",
  5: "LINK_ADD",
  6: "LINK_REMOVE",
  7: "VERIFICATION_ADD_ETH_ADDRESS",
  8: "VERIFICATION_REMOVE",
  11: "USER_DATA_ADD",
  12: "USERNAME_PROOF",
  13: "FRAME_ACTION",
  14: "LINK_COMPACT_STATE",
  15: "LEND_STORAGE",
  16: "KEY_ADD",
  17: "KEY_REMOVE",
};

const typeOf = (name: string) =>
  Number(Object.entries(MESSAGE_TYPES).find(([, n]) => n === name)?.[0]);

/** What each `--scopes` name grants, as message type numbers. */
const SCOPE_GROUPS: Record<string, number[]> = {
  cast: [typeOf("CAST_ADD"), typeOf("CAST_REMOVE")],
  reaction: [typeOf("REACTION_ADD"), typeOf("REACTION_REMOVE")],
  link: [typeOf("LINK_ADD"), typeOf("LINK_REMOVE")],
  "user-data": [typeOf("USER_DATA_ADD")],
};

/**
 * "CAST_ADD" for 1 or for "MESSAGE_TYPE_CAST_ADD" (the node prints names), for display; a type
 * newer than this table shows as its number.
 */
export function scopeNames(types: (number | string)[] = []): string[] {
  return types.map((type) =>
    typeof type === "string"
      ? type.replace(/^MESSAGE_TYPE_/, "")
      : (MESSAGE_TYPES[type] ?? `TYPE_${type}`),
  );
}

/** The `--scopes` names whose message types are all in `types`, for people to read. */
export function scopeGroups(types: number[]): string[] {
  return Object.entries(SCOPE_GROUPS)
    .filter(([, group]) => group.every((type) => types.includes(type)))
    .map(([name]) => name);
}

/** scopeGroups for scopes named as the node names them, such as "CAST_ADD". */
export function scopeGroupsOfNames(names: string[]): string[] {
  return scopeGroups(names.map(typeOf));
}

/** Parses "cast,reaction,link,user-data" into the message types a new key may sign. */
export function parseScopes(names: string): number[] {
  const types = names.split(",").flatMap((name) => {
    const group = SCOPE_GROUPS[name.trim()];
    if (!group) {
      const known = Object.keys(SCOPE_GROUPS).join(", ");
      throw new UsageError(`unknown scope "${name}"`, `choose from ${known}`);
    }
    return group;
  });
  return [...new Set(types)];
}
