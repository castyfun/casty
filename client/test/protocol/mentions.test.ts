import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/errors.js";
import { NodeUnreachableError } from "../../src/node/errors.js";
import { encodeMentions, mentionedNames, mentionFids } from "../../src/protocol/mentions.js";
import { segments } from "../../src/web/view.js";

describe("mentionedNames", () => {
  it("finds @names at the start or after a space, lowercased, each once", () => {
    expect(mentionedNames("@Alice gm, (@bob) and @alice.eth, @Alice again")).toEqual([
      "alice",
      "bob",
      "alice.eth",
    ]);
  });

  it("leaves addresses and handles inside words alone", () => {
    expect(mentionedNames("write to me@alice.com or x@bob")).toEqual([]);
  });

  it("never takes part of a longer name, which would tag someone else", () => {
    expect(mentionedNames("@jesse.base.eth @josé @alice_bob @alice.ethereum")).toEqual([]);
  });

  it("ends a name at punctuation after it", () => {
    expect(mentionedNames("@alice. @bob.eth! @carol’s (@dave) @erin—ok")).toEqual([
      "alice",
      "bob.eth",
      "carol",
      "dave",
      "erin",
    ]);
  });
});

describe("encodeMentions", () => {
  const fids = new Map([
    ["alice", 5],
    ["bob", 6],
  ]);

  it("takes each known @name out of the text and keeps it as a mention at its byte offset", () => {
    expect(encodeMentions("gm @alice and @carol!", fids)).toEqual({
      text: "gm  and @carol!",
      mentions: [5],
      mentionsPositions: [3],
    });
  });

  it("counts offsets in UTF-8 bytes", () => {
    const encoded = encodeMentions("привет @bob", fids);
    expect(encoded.text).toBe("привет ");
    expect(encoded.mentionsPositions).toEqual([Buffer.byteLength("привет ")]);
  });

  it("puts the name back where it was when the cast is shown", () => {
    const encoded = encodeMentions("@Alice, @bob: hello", fids);
    const shown = segments(
      encoded.text,
      encoded.mentions.map((fid, i) => ({
        fid,
        name: fid === 5 ? "alice" : "bob",
        position: encoded.mentionsPositions[i] ?? 0,
      })),
    );
    const said = shown
      .map((s) => ("mention" in s ? s.mention : "text" in s ? s.text : ""))
      .join("");
    expect(said).toBe("@alice, @bob: hello");
  });

  it("encodes at most 10 mentions, as the protocol allows, and leaves the rest as text", () => {
    const text = Array.from({ length: 12 }, () => "@alice").join(" ");
    const encoded = encodeMentions(text, fids);
    expect(encoded.mentions).toHaveLength(10);
    expect(encoded.text).toContain("@alice @alice");
  });
});

describe("mentionFids", () => {
  it("looks each name up once and lists the ones nobody holds", async () => {
    const asked: string[] = [];
    const lookup = async (name: string) => {
      asked.push(name);
      if (name === "alice") return 5;
      throw new UsageError(`no fid found for @${name}`);
    };
    const { fids, plain } = await mentionFids("@alice @nobody @alice", lookup);
    expect(fids).toEqual(new Map([["alice", 5]]));
    expect(plain).toEqual(["nobody"]);
    expect(asked).toEqual(["alice", "nobody"]);
  });

  it("stops on a lookup that failed for another reason, rather than send the name as text", async () => {
    const lookup = async () => {
      throw new NodeUnreachableError("http://127.0.0.1:3381");
    };
    await expect(mentionFids("hi @alice", lookup)).rejects.toThrow(NodeUnreachableError);
  });
});
