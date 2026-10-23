import { MessageType, messageTypeToJSON } from "@farcaster/core";
import { expect, it } from "vitest";
import { scopeGroupsOfNames, scopeNames } from "../../src/protocol/scopes.js";

it("names every message type as @farcaster/core does", () => {
  const types = Object.values(MessageType).filter((v): v is number => typeof v === "number");
  expect(types.length).toBeGreaterThan(10);
  for (const type of types) {
    expect(scopeNames([type])).toEqual([messageTypeToJSON(type).replace(/^MESSAGE_TYPE_/, "")]);
  }
});

it("names a message type newer than the table by its number instead of failing", () => {
  expect(scopeNames([999])).toEqual(["TYPE_999"]);
});

it("groups node scope names as --scopes names them", () => {
  const names = ["CAST_ADD", "CAST_REMOVE", "REACTION_ADD", "REACTION_REMOVE", "LINK_ADD"];
  expect(scopeGroupsOfNames(names)).toEqual(["cast", "reaction"]);
});
