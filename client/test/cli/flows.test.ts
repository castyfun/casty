import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APPS, FIRST_AUTHOR, ME_FID, NO_STORAGE_FID, TEST_MNEMONIC } from "@casty/mock-node";
import { describe, expect, it } from "vitest";
import { sawMentions, unseenMentions } from "../../src/cli/refs.js";
import { type KeyRecord, loadKeys, writeKeys } from "../../src/keys/store.js";
import { startMock } from "../mock.js";
import { casty, flags, initMe, PASS, tempConfig } from "./harness.js";

const AUTHOR = FIRST_AUTHOR;

async function ready() {
  const node = await startMock();
  const dir = tempConfig();
  const init = await initMe(node.url, dir);
  expect(init.code).toBe(0);
  return { node, dir, key: JSON.parse(init.stdout).key as string, args: flags(node.url, dir) };
}

describe("init", () => {
  it("registers a gasless key on the node and stores it encrypted", async () => {
    const { node, dir, key } = await ready();
    const onNode = node.state.signers.get(ME_FID)?.signers.map((s) => s.key);
    expect(onNode).toContain(key);
    const store = join(dir, "keys.enc.json");
    expect(existsSync(store)).toBe(true);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(readFileSync(store, "utf8")).not.toContain(TEST_MNEMONIC);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("test test");
  });

  it("prints fid, custody address, key, scopes and TTL expiry", async () => {
    const node = await startMock();
    const { stdout } = await initMe(node.url, tempConfig(), ["--ttl", "7d", "--scopes", "cast"]);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ fid: ME_FID, scopes: ["CAST_ADD", "CAST_REMOVE"], ttl: 604800 });
    expect(out.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("says in words what the key may do, when it lapses and what to run next", async () => {
    const node = await startMock();
    const args = ["init", "--mnemonic-stdin", "--ttl", "7d", ...flags(node.url, tempConfig())];
    const { stdout, stderr } = await casty(args, { stdin: `${TEST_MNEMONIC}\n`, env: PASS });
    expect(stdout).toMatch(/^scopes +cast, reaction, link$/m);
    expect(stdout).toMatch(/^expires +\d{4}-\d{2}-\d{2}, after 7 days without use$/m);
    expect(stderr).toContain("next: casty feed");
  });

  it("can have the key requested by an app fid custodied by another index", async () => {
    const node = await startMock();
    const app = APPS[0].fid;
    const extra = ["--app-fid", String(app), "--app-address-index", "1"];
    const { code, stdout } = await initMe(node.url, tempConfig(), extra);
    expect(code).toBe(0);
    const key = JSON.parse(stdout).key;
    expect(node.state.signers.get(ME_FID)?.signers.find((s) => s.key === key)?.requestFid).toBe(
      app,
    );
  });

  it("refuses an fid without storage, with exit code 5", async () => {
    const node = await startMock();
    const { code, stderr } = await initMe(node.url, tempConfig(), ["--address-index", "2"]);
    expect(code).toBe(5);
    expect(stderr).toContain(`fid ${NO_STORAGE_FID} has no storage`);
  });

  it("refuses a seed phrase with a bad checksum, with exit code 5", async () => {
    const node = await startMock();
    const args = ["init", "--mnemonic-stdin", ...flags(node.url, tempConfig())];
    const { code } = await casty(args, { stdin: TEST_MNEMONIC.replace("junk", "test"), env: PASS });
    expect(code).toBe(5);
  });

  it("on a terminal, --mnemonic-stdin asks with the input hidden instead of echoing it", async () => {
    const node = await startMock();
    const questions: string[] = [];
    const prompt = async (question: string) => {
      questions.push(question);
      return new TextEncoder().encode(TEST_MNEMONIC);
    };
    const args = ["init", "--mnemonic-stdin", ...flags(node.url, tempConfig())];
    const run = await casty(args, { tty: true, prompt, env: PASS, stdin: "never read" });
    expect(run.code).toBe(0);
    expect(questions).toEqual(["seed phrase (input hidden): "]);
  });

  it("forgets a key the node rejected", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ rejectNextWith: "scope" });
    expect((await initMe(node.url, dir)).code).toBe(3);
    expect(loadKeys(dir, "x")).toEqual([]);
  });

  it("keeps a key that was accepted but not confirmed, and uses it once it merges", {
    timeout: 15_000,
  }, async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ mergeDelayMs: 900 });
    const init = await initMe(node.url, dir);
    expect(init.code).toBe(3);
    expect(init.stderr).toContain("kept");
    expect(loadKeys(dir, "x")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1000));
    node.control({ mergeDelayMs: 0 });
    expect(
      (await casty(["cast", "late but fine", ...flags(node.url, dir)], { env: PASS })).code,
    ).toBe(0);
  });

  it("run again, resends a key add that never confirmed, without asking for the seed phrase", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ mergeDelayMs: 30_000 });
    expect((await initMe(node.url, dir)).code).toBe(3);
    const [pending] = loadKeys(dir, "x");
    const { keyAdd, ...settled } = pending as KeyRecord;
    expect(keyAdd).toMatch(/^[0-9a-f]+$/);
    node.control({ mergeDelayMs: 0 });

    // No stdin and no terminal: asking for the seed phrase would fail with exit code 5.
    const again = await casty(["init", "--json", ...flags(node.url, dir)], { env: PASS });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).key).toBe(`0x${settled.pubkey}`);
    expect(node.state.signers.get(ME_FID)?.signers.map((s) => s.key)).toContain(
      `0x${settled.pubkey}`,
    );
    expect(loadKeys(dir, "x")).toEqual([settled]);
  });

  it("run again after the node refused the saved key add, adds a new key", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ mergeDelayMs: 30_000 });
    expect((await initMe(node.url, dir)).code).toBe(3);
    const [pending] = loadKeys(dir, "x");
    node.control({ mergeDelayMs: 0, rejectNextWith: "nonce" });

    const again = await initMe(node.url, dir);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("refused the saved key add");
    const records = loadKeys(dir, "x");
    expect(records.map((r) => r.pubkey)).toEqual([JSON.parse(again.stdout).key.slice(2)]);
    expect(records[0]?.pubkey).not.toBe(pending?.pubkey);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(config.keys).toEqual([JSON.parse(again.stdout).key]);
  });

  it("run again while the node is unavailable, keeps the saved key add for later", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ mergeDelayMs: 30_000 });
    expect((await initMe(node.url, dir)).code).toBe(3);
    const before = loadKeys(dir, "x");
    node.control({ mergeDelayMs: 0, rejectNextWith: "unavailable" });

    const again = await casty(["init", ...flags(node.url, dir)], { env: PASS });
    expect(again.code).toBe(3);
    expect(loadKeys(dir, "x")).toEqual(before);
  });

  it("run again asking for a different key, adds it and leaves the saved key add alone", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ mergeDelayMs: 30_000 });
    expect((await initMe(node.url, dir)).code).toBe(3);
    const [pending] = loadKeys(dir, "x");
    node.control({ mergeDelayMs: 0 });

    const again = await initMe(node.url, dir, ["--scopes", "cast"]);
    expect(again.code).toBe(0);
    expect(again.stderr).not.toContain("sending the saved key add");
    expect(loadKeys(dir, "x").map((r) => r.pubkey)).toEqual([
      pending?.pubkey,
      JSON.parse(again.stdout).key.slice(2),
    ]);
  });

  it("a key add that timed out says one thing about running init again", async () => {
    const node = await startMock();
    node.control({ mergeDelayMs: 30_000 });
    const { stderr } = await initMe(node.url, tempConfig());
    expect(stderr).toContain("casty init");
    expect(stderr).not.toContain("sends a new message");
  });

  it("retries once with a fresh nonce", async () => {
    const node = await startMock();
    node.control({ rejectNextWith: "nonce" });
    expect((await initMe(node.url, tempConfig())).code).toBe(0);
  });
});

describe("writing", () => {
  it("cast is readable with castById and prints a farcaster.xyz link", async () => {
    const { node, args } = await ready();
    const { code, stdout } = await casty(["cast", "hello from casty", "--json", ...args], {
      env: PASS,
    });
    expect(code).toBe(0);
    const { hash, url } = JSON.parse(stdout);
    expect(url).toBe(`https://farcaster.xyz/casty-test/${hash.slice(0, 10)}`);
    const merged = node.state.casts.find((c) => c.hash === hash);
    expect(merged?.data.castAddBody?.text).toBe("hello from casty");
  });

  it("reply sets the parent cast", async () => {
    const { node, args } = await ready();
    const parent = node.state.casts.find((c) => c.data.fid === AUTHOR);
    const ref = `${AUTHOR}:${parent?.hash}`;
    const { stdout } = await casty(["reply", ref, "agreed", "--json", ...args], { env: PASS });
    const merged = node.state.casts.find((c) => c.hash === JSON.parse(stdout).hash);
    expect(merged?.data.castAddBody?.parentCastId).toEqual({ fid: AUTHOR, hash: parent?.hash });
  });

  it("delete removes the cast", async () => {
    const { node, args } = await ready();
    const { stdout } = await casty(["cast", "short-lived", "--json", ...args], { env: PASS });
    const { hash } = JSON.parse(stdout);
    expect((await casty(["delete", hash, ...args], { env: PASS })).code).toBe(0);
    expect(node.state.casts.some((c) => c.hash === hash)).toBe(false);
  });

  it("like then unlike, recast then unrecast", async () => {
    const { node, args } = await ready();
    const target = node.state.casts.find((c) => c.data.fid === AUTHOR);
    const ref = `${AUTHOR}:${target?.hash}`;
    const mine = (type: string) =>
      node.state.reactions.filter(
        (r) =>
          r.data.fid === ME_FID &&
          r.data.reactionBody?.type === type &&
          r.data.reactionBody.targetCastId?.hash === target?.hash,
      );
    expect((await casty(["like", ref, ...args], { env: PASS })).code).toBe(0);
    expect(mine("REACTION_TYPE_LIKE")).toHaveLength(1);
    expect((await casty(["unlike", ref, ...args], { env: PASS })).code).toBe(0);
    expect(mine("REACTION_TYPE_LIKE")).toHaveLength(0);
    expect((await casty(["recast", ref, ...args], { env: PASS })).code).toBe(0);
    expect(mine("REACTION_TYPE_RECAST")).toHaveLength(1);
    expect((await casty(["unrecast", ref, ...args], { env: PASS })).code).toBe(0);
    expect(mine("REACTION_TYPE_RECAST")).toHaveLength(0);
  });

  it("like, reply and recast take the number a cast has in the last casty feed", async () => {
    const { node, args } = await ready();
    const listed = JSON.parse((await casty(["feed", "--limit", "3", "--json", ...args])).stdout);
    const second = listed[1];
    expect((await casty(["like", "2", ...args], { env: PASS })).code).toBe(0);
    const liked = node.state.reactions.find(
      (r) => r.data.fid === ME_FID && r.data.reactionBody?.targetCastId?.hash === second.hash,
    );
    expect(liked).toBeDefined();
    const { stdout } = await casty(["reply", "2", "agreed", "--json", ...args], { env: PASS });
    const reply = node.state.casts.find((c) => c.hash === JSON.parse(stdout).hash);
    expect(reply?.data.castAddBody?.parentCastId).toEqual({ fid: second.fid, hash: second.hash });
  });

  it("a number with no casty feed behind it exits 2 and says what to run", async () => {
    const { args } = await ready();
    const { code, stderr } = await casty(["like", "2", ...args], { env: PASS });
    expect(code).toBe(2);
    expect(stderr).toContain("casty feed");
  });

  it("like and delete take the farcaster.xyz link casty cast prints", async () => {
    const { node, args } = await ready();
    const { stdout } = await casty(["cast", "link me", "--json", ...args], { env: PASS });
    const { hash, url } = JSON.parse(stdout);
    expect((await casty(["like", url, ...args], { env: PASS })).code).toBe(0);
    expect(node.state.reactions.some((r) => r.data.reactionBody?.targetCastId?.hash === hash)).toBe(
      true,
    );
    expect((await casty(["delete", url, ...args], { env: PASS })).code).toBe(0);
    expect(node.state.casts.some((c) => c.hash === hash)).toBe(false);
  });

  it("delete refuses a cast by someone else", async () => {
    const { node, args } = await ready();
    const theirs = node.state.casts.find((c) => c.data.fid === AUTHOR);
    const { code, stderr } = await casty(["delete", `${AUTHOR}:${theirs?.hash}`, ...args], {
      env: PASS,
    });
    expect(code).toBe(2);
    expect(stderr).toContain("not yours");
  });

  it("unfollow then follow by @name", async () => {
    const { node, args } = await ready();
    const follows = () =>
      node.state.links.some((l) => l.data.fid === ME_FID && l.data.linkBody?.targetFid === AUTHOR);
    expect(follows()).toBe(true);
    expect((await casty(["unfollow", String(AUTHOR), ...args], { env: PASS })).code).toBe(0);
    expect(follows()).toBe(false);
    expect(
      (
        await casty(["follow", `@user-${AUTHOR}`, "--no-allow-fname-server", ...args], {
          env: PASS,
        })
      ).code,
    ).toBe(0);
    expect(follows()).toBe(true);
  });

  it("key revoke --self removes the key from the node and the store", async () => {
    const { node, dir, key, args } = await ready();
    const { code } = await casty(["key", "revoke", "--self", ...args], { env: PASS });
    expect(code).toBe(0);
    expect(node.state.signers.get(ME_FID)?.signers.map((s) => s.key)).not.toContain(key);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).keys).not.toContain(key);
    expect(loadKeys(dir, "x").map((r) => `0x${r.pubkey}`)).not.toContain(key);
  });

  it("key revoke with the seed phrase uses the custody signature", async () => {
    const { node, key, args } = await ready();
    const run = await casty(["key", "revoke", key, "--mnemonic-stdin", ...args], {
      stdin: `${TEST_MNEMONIC}\n`,
      env: PASS,
    });
    expect(run.code).toBe(0);
    expect(node.state.signers.get(ME_FID)?.signers.map((s) => s.key)).not.toContain(key);
  });
});

describe("the seed phrase warning", () => {
  const WARNING = "A seed phrase controls the whole account";
  /** Runs `args` on a terminal and returns what stderr held when the seed phrase was asked for. */
  async function beforePrompt(args: string[]) {
    let stderr = "";
    let seen: string | undefined;
    const prompt = async (question: string) => {
      if (question.startsWith("seed phrase")) seen = stderr;
      return new TextEncoder().encode(question.startsWith("seed phrase") ? TEST_MNEMONIC : "x");
    };
    const run = await casty(args, { tty: true, prompt, onStderr: (s) => (stderr += s) });
    expect(run.code).toBe(0);
    return seen;
  }

  it("is on stderr before init asks for the seed phrase", async () => {
    const node = await startMock();
    expect(await beforePrompt(["init", ...flags(node.url, tempConfig())])).toContain(WARNING);
  });

  it("is on stderr before key revoke asks for the seed phrase", async () => {
    const { key, args } = await ready();
    expect(await beforePrompt(["key", "revoke", key, ...args])).toContain(WARNING);
  });

  it("is on stderr before a piped seed phrase is read, and names the wallet path", async () => {
    const node = await startMock();
    const args = ["init", "--mnemonic-stdin", ...flags(node.url, tempConfig())];
    const { code, stdout, stderr } = await casty(args, { stdin: `${TEST_MNEMONIC}\n`, env: PASS });
    expect(code).toBe(0);
    expect(stderr).toContain(WARNING);
    expect(stderr).toContain("casty init --fid <fid>");
    expect(stdout).not.toContain(WARNING);
  });

  it("is not printed by init --fid, which takes no seed phrase", async () => {
    const node = await startMock();
    const { code, stderr } = await casty([
      "init",
      "--fid",
      String(ME_FID),
      ...flags(node.url, tempConfig()),
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain(WARNING);
  });
});

describe("init --fid", () => {
  // Mainnet: an fid whose recovery address changed lists ChangeRecovery events after its
  // Register, with "to": "0x"; the custody address is the newest Register's or Transfer's.
  it("takes the custody address from the newest Register or Transfer, not a recovery change", async () => {
    const node = await startMock();
    const events = node.state.onchain.filter((e) => e.fid === ME_FID && e.idRegisterEventBody);
    const register = events.at(-1);
    if (!register?.idRegisterEventBody) throw new Error("fixture fid has no register event");
    node.state.onchain.push({
      ...register,
      idRegisterEventBody: {
        ...register.idRegisterEventBody,
        eventType: "ChangeRecovery",
        to: "0x",
      },
    });
    const dir = tempConfig();
    const { code, stderr } = await casty([
      "init",
      "--fid",
      String(ME_FID),
      ...flags(node.url, dir),
    ]);
    expect(stderr).not.toMatch(/invalid/i);
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(config.custodyAddress.toLowerCase()).toBe(register.idRegisterEventBody.to.toLowerCase());
  });

  it("remembers the node it was given, so later commands need no --node", async () => {
    const node = await startMock();
    const dir = tempConfig();
    expect((await casty(["init", "--fid", String(ME_FID), ...flags(node.url, dir)])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).node).toBe(node.url);
    const doctor = await casty(["doctor", "--json", "--config", dir]);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout).node).toBe(node.url);
    // A --node given still wins over the remembered one.
    const other = await casty(["doctor", "--node", "http://127.0.0.1:9", "--config", dir]);
    expect(other.code).toBe(4);
  });

  it("a write with no key yet points at the wallet, not only at the seed phrase", async () => {
    const node = await startMock();
    const dir = tempConfig();
    expect((await casty(["init", "--fid", String(ME_FID), ...flags(node.url, dir)])).code).toBe(0);
    const { code, stderr } = await casty(["cast", "no key", ...flags(node.url, dir)], {
      env: PASS,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("casty web");
  });
});

describe("a key the node does not list", () => {
  it("says a key added a moment ago counts once the node has it", async () => {
    const { node, dir, args } = await ready();
    const listed = node.state.signers.get(ME_FID);
    if (listed) listed.signers = [];
    const { code, stderr } = await casty(["cast", "not yet", ...args], { env: PASS });
    expect(code).not.toBe(0);
    expect(stderr).toContain(`none of the app keys in ${dir} is registered to fid ${ME_FID}`);
    expect(stderr).toContain("once your node has it");
  });
});

describe("init's checks before the seed phrase", () => {
  it("refuses a TTL of nothing before asking for the seed phrase", async () => {
    const node = await startMock();
    const args = ["init", "--ttl", "0d", ...flags(node.url, tempConfig())];
    const { code, stderr } = await casty(args, { env: PASS });
    expect(code).toBe(2);
    expect(stderr).toContain("--ttl");
  });

  it("zeroes the passphrase it was given", async () => {
    const { node, dir } = await ready();
    const typed = new TextEncoder().encode("x");
    const prompt = async () => typed;
    await casty(["cast", "zeroed after", ...flags(node.url, dir)], { prompt });
    expect([...typed].every((b) => b === 0)).toBe(true);
  });
});

describe("a node too busy to answer right after taking a message", () => {
  it("init keeps the key it added and reports it", async () => {
    const node = await startMock();
    const dir = tempConfig();
    node.control({ failReadsAfterSubmit: 1 });
    const init = await initMe(node.url, dir);
    expect(init.code).toBe(0);
    const key = JSON.parse(init.stdout).key;
    expect(node.state.signers.get(ME_FID)?.signers.map((s) => s.key)).toContain(key);
    expect(loadKeys(dir, "x").map((r) => `0x${r.pubkey}`)).toContain(key);
  });

  it("cast reports the cast once, so it is not posted twice", async () => {
    const { node, args } = await ready();
    node.control({ failReadsAfterSubmit: 1 });
    const before = node.state.casts.length;
    const sent = await casty(["cast", "only once", ...args], { env: PASS });
    expect(sent.code).toBe(0);
    expect(node.state.casts.length).toBe(before + 1);
  });
});

describe("reading", () => {
  it("leaves an account out of the next feed as soon as you unfollow it", async () => {
    const { args } = await ready();
    const authors = async () =>
      JSON.parse((await casty(["feed", "--json", "--limit", "100", ...args])).stdout).map(
        (c: { fid: number }) => c.fid,
      );
    expect(await authors()).toContain(AUTHOR);
    expect((await casty(["unfollow", String(AUTHOR), ...args], { env: PASS })).code).toBe(0);
    expect(await authors()).not.toContain(AUTHOR);
  });

  it("reads each account once when --fids names it twice", async () => {
    const { args } = await ready();
    const out = await casty(["feed", "--json", "--fids", `${AUTHOR},${AUTHOR}`, ...args]);
    const hashes = JSON.parse(out.stdout).map((c: { hash: string }) => c.hash);
    expect(hashes.length).toBeGreaterThan(0);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("--fids takes @names too, and an account named both ways is read once", async () => {
    const { args } = await ready();
    const out = await casty(["feed", "--json", "--fids", `@user-${AUTHOR},${AUTHOR}`, ...args]);
    const casts = JSON.parse(out.stdout) as { fid: number; hash: string }[];
    expect(casts.length).toBeGreaterThan(0);
    expect(casts.every((c) => c.fid === AUTHOR)).toBe(true);
    expect(new Set(casts.map((c) => c.hash)).size).toBe(casts.length);
  });

  it("cast sends a known @name as a mention and says which names it sent as text", async () => {
    const { node, args } = await ready();
    const text = `gm @user-${AUTHOR} and @nobody-here`;
    const { code, stderr } = await casty(["cast", text, ...args], { env: PASS });
    expect(code).toBe(0);
    const sent = node.state.casts.at(-1)?.data.castAddBody;
    expect(sent).toMatchObject({
      text: "gm  and @nobody-here",
      mentions: [AUTHOR],
      mentionsPositions: [3],
    });
    expect(stderr).toContain("@nobody-here");
  });

  it("cast --no-mentions and reply --no-mentions send @names as text", async () => {
    const { node, args } = await ready();
    const text = `gm @user-${AUTHOR}`;
    expect((await casty(["cast", text, "--no-mentions", ...args], { env: PASS })).code).toBe(0);
    expect(node.state.casts.at(-1)?.data.castAddBody).toMatchObject({ text, mentions: [] });
    const parent = node.state.casts.at(-1);
    const reply = await casty(
      ["reply", `${parent?.data.fid}:${parent?.hash}`, text, "--no-mentions", ...args],
      { env: PASS },
    );
    expect(reply.code).toBe(0);
    expect(node.state.casts.at(-1)?.data.castAddBody).toMatchObject({ text, mentions: [] });
  });

  it("mentions lists what others said to you, numbered so reply 1 answers the first", async () => {
    const { args, node } = await ready();
    const { code, stdout } = await casty(["mentions", "--limit", "3", ...args]);
    expect(code).toBe(0);
    const headers = stdout.split("\n").filter((line) => /^ ?\d+ {2}/.test(line));
    expect(headers).toHaveLength(3);
    expect(stdout).toContain("@casty-test");
    const reply = await casty(["reply", "1", "thanks", "--json", ...args], { env: PASS });
    expect(reply.code).toBe(0);
    const sent = node.state.casts.find((c) => c.hash === JSON.parse(reply.stdout).hash);
    expect(sent?.data.castAddBody?.mentions ?? []).toEqual([]);
    expect(sent?.data.castAddBody?.parentCastId).toBeDefined();
  });

  it("mentions shown in the terminal no longer count as new in casty web", async () => {
    const { args, dir } = await ready();
    sawMentions(dir, ME_FID, []);
    const { code, stdout } = await casty(["mentions", "--json", ...args]);
    expect(code).toBe(0);
    const [newest] = JSON.parse(stdout) as { timestamp: number }[];
    expect(unseenMentions(dir, ME_FID, [newest?.timestamp ?? 0])).toBe(0);
  });

  it("feed numbers each cast, with author, age and app above its text", async () => {
    const { args } = await ready();
    const { code, stdout } = await casty(["feed", "--limit", "20", ...args]);
    expect(code).toBe(0);
    const headers = stdout.split("\n").filter((line) => /^ ?\d+ {2}/.test(line));
    expect(headers).toHaveLength(20);
    expect(headers[0]).toMatch(/^ 1 {2}@user-\d+ · \d+[smhd] · via app-(alpha|beta)/);
    expect(stdout).not.toContain("\u001b");
  });

  it("feed on a terminal is coloured and says how to act on a cast, unless NO_COLOR", async () => {
    const { args } = await ready();
    const shown = await casty(["feed", "--limit", "2", ...args], { tty: true });
    expect(shown.stdout).toContain("\u001b[1m");
    expect(shown.stderr).toContain("casty like 1");
    const plain = await casty(["feed", "--limit", "2", ...args], {
      tty: true,
      env: { NO_COLOR: "1" },
    });
    expect(plain.stdout).not.toContain("\u001b");
  });

  it("an empty feed says how to fill it", async () => {
    const { args } = await ready();
    const { stdout, stderr } = await casty([
      "feed",
      "--channel",
      "https://example.com/none",
      ...args,
    ]);
    expect(stdout.trim()).toBe("no casts");
    expect(stderr).toContain("casty follow");
  });

  it("a channel can be named /name once a list has shown it, in cast and in feed", async () => {
    const { node, args } = await ready();
    const url = "https://example.com/~/channel/casty";
    const before = await casty(["cast", "too early", "--channel", "/casty", ...args], {
      env: PASS,
    });
    expect(before.code).toBe(2);
    expect(before.stderr).toContain("no channel /casty shown yet");
    await casty(["feed", ...args]);
    const posted = await casty(["cast", "in the channel", "--channel", "/casty", ...args], {
      env: PASS,
    });
    expect(posted.code).toBe(0);
    const cast = node.state.casts.find((c) => c.data.castAddBody?.text === "in the channel");
    expect(cast?.data.castAddBody?.parentUrl).toBe(url);
    const { stdout } = await casty(["feed", "--channel", "casty", "--json", ...args]);
    const shown = JSON.parse(stdout) as { channel: string }[];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((c) => c.channel === url)).toBe(true);
  });

  it("thread numbers what a cast answers, the cast and its replies, for like and reply", async () => {
    const { node, args } = await ready();
    const post = async (argv: string[]) =>
      JSON.parse((await casty([...argv, "--json", ...args], { env: PASS })).stdout);
    const root = await post(["cast", "the question"]);
    const middle = await post(["reply", `${root.fid}:${root.hash}`, "an answer"]);
    await post(["reply", `${middle.fid}:${middle.hash}`, "a follow-up"]);
    const json = JSON.parse(
      (await casty(["thread", `${middle.fid}:${middle.hash}`, "--json", ...args])).stdout,
    );
    expect(json.parent.text).toBe("the question");
    expect(json.cast.text).toBe("an answer");
    expect(json.replies.map((r: { text: string }) => r.text)).toEqual(["a follow-up"]);
    const { stdout } = await casty(["thread", `${middle.fid}:${middle.hash}`, ...args]);
    expect(stdout).toMatch(/^1 .*\n {3}the question\n\n2 .*\n {3}an answer\n\n3 /m);
    expect((await casty(["like", "3", ...args], { env: PASS })).code).toBe(0);
    const liked = node.state.reactions.at(-1)?.data.reactionBody?.targetCastId?.hash;
    expect(liked).toBe(json.replies[0].hash);
  });

  it("feed shows your own casts next to those of the accounts you follow", async () => {
    const { args } = await ready();
    expect((await casty(["cast", "my own words", ...args], { env: PASS })).code).toBe(0);
    const { stdout } = await casty(["feed", "--json", ...args]);
    expect(JSON.parse(stdout)[0]).toMatchObject({ fid: ME_FID, text: "my own words" });
  });

  it("clients names scopes the way --scopes does, so the table stays narrow", async () => {
    const { args } = await ready();
    const { stdout } = await casty(["clients", ...args]);
    expect(stdout).toMatch(/ cast, reaction, link /);
    expect(Math.max(...stdout.split("\n").map((line) => line.length))).toBeLessThanOrEqual(100);
  });

  it("clients marks our key", async () => {
    const { key, args } = await ready();
    const { stdout } = await casty(["clients", "--json", ...args]);
    const rows = JSON.parse(stdout);
    expect(rows.find((r: { key: string }) => r.key === key)).toMatchObject({
      ours: true,
      type: "gasless",
    });
    expect(rows.find((r: { key: string }) => r.key !== key)).toMatchObject({
      ours: false,
      type: "onchain",
      app: "app-beta",
    });
  });

  it("storage prints a table that counts what was just published", async () => {
    const { args } = await ready();
    await casty(["cast", "one more", ...args], { env: PASS });
    const { code, stdout } = await casty(["storage", ...args]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/CASTS\s+1\s+\d+/);
  });

  it("storage and whoami count storage units in words", async () => {
    const { args } = await ready();
    expect((await casty(["storage", ...args])).stdout).toMatch(/^fid \d+: 1 unit$/m);
    expect((await casty(["whoami", ...args])).stdout).toMatch(/^storage +1 unit: CASTS/m);
  });

  it("storage warns when a store is at least 90% full", async () => {
    const { node, args } = await ready();
    const limits = node.state.storage.get(ME_FID)?.limits ?? [];
    // fid 1 follows 12 accounts; a limit of 13 puts LINKS at 92%.
    for (const l of limits) if (l.name === "LINKS") l.limit = 13;
    const { stdout } = await casty(["storage", ...args]);
    expect(stdout).toContain("warning: LINKS is 92% full");
  });

  it("node status reports sync only, and exits 1 until the node is synced", async () => {
    const { node, args } = await ready();
    expect((await casty(["node", "status", ...args])).code).toBe(0);
    node.control({ blockDelay: [400] });
    const { stdout, code } = await casty(["node", "status", "--json", ...args]);
    expect(JSON.parse(stdout)).toMatchObject({ synced: false });
    expect(code).toBe(1);
  });
});

describe("choosing the app key", () => {
  it("skips stored keys the node no longer lists", async () => {
    const { dir, args } = await ready();
    const records = loadKeys(dir, "x");
    const stale = {
      ...(records[0] as KeyRecord),
      pubkey: "ab".repeat(32),
      privkey: "cd".repeat(32),
    };
    writeKeys(dir, [...records, stale], "x", { N: 2 ** 10, r: 8, p: 1 });
    expect((await casty(["cast", "still works", ...args], { env: PASS })).code).toBe(0);
  });

  it("skips a key the node still lists but whose TTL has run out, with the same hint", async () => {
    const { node, key, args } = await ready();
    const listed = node.state.signers.get(ME_FID)?.signers.find((s) => s.key === key);
    if (!listed) throw new Error("init's key is not listed");
    listed.expiresAt = Math.floor(Date.now() / 1000) - 60;
    const { code, stderr } = await casty(["cast", "too late", ...args], { env: PASS });
    expect(code).toBe(5);
    expect(stderr).toContain("expire");
    expect(node.state.casts.some((c) => c.data.castAddBody?.text === "too late")).toBe(false);
  });

  it("takes an expiresAt of 0 for no expiry, as casty clients shows it", async () => {
    const { node, key, args } = await ready();
    const listed = node.state.signers.get(ME_FID)?.signers.find((s) => s.key === key);
    if (!listed) throw new Error("init's key is not listed");
    listed.expiresAt = 0;
    listed.ttl = 0;
    expect((await casty(["cast", "no expiry", ...args], { env: PASS })).code).toBe(0);
  });

  it("exits 5 with a hint when none of the stored keys is registered", async () => {
    const { node, args } = await ready();
    node.state.signers.get(ME_FID)?.signers.splice(0);
    const { code, stderr } = await casty(["cast", "nope", ...args], { env: PASS });
    expect(code).toBe(5);
    expect(stderr).toContain("casty init");
  });
});

describe("exit codes", () => {
  it("2 for a usage error", async () => {
    expect((await casty(["cast"])).code).toBe(2);
    expect((await casty(["like", "not-a-cast-ref", "--config", tempConfig()])).code).toBe(2);
  });

  it("2 for a count or fid of 0", async () => {
    const { args } = await ready();
    for (const argv of [
      ["feed", "--limit", "0"],
      ["mentions", "--limit", "0"],
      ["clients", "--fid", "0"],
      ["storage", "--fid", "0"],
    ]) {
      const { code, stderr } = await casty([...argv, ...args]);
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(stderr).toContain("above 0");
    }
  });

  it("2 for a cast delete cannot name, before asking for the passphrase", async () => {
    const { args } = await ready();
    const { code, stderr } = await casty(["delete", "not-a-cast", ...args]);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot tell which cast "not-a-cast" is');
  });

  it("3 when the node rejects a message", async () => {
    const { node, args } = await ready();
    node.control({ rejectNextWith: "scope" });
    const { code, stderr } = await casty(["cast", "nope", ...args], { env: PASS });
    expect(code).toBe(3);
    expect(stderr).toContain("invalid scope");
    expect(stderr).toContain("hint:");
  });

  it("4 when the node is unreachable", async () => {
    expect((await casty(["doctor", "--node", "http://127.0.0.1:9"])).code).toBe(4);
  });

  it("5 when casty is not set up", async () => {
    const node = await startMock();
    const { code, stderr } = await casty(["cast", "hi", ...flags(node.url, tempConfig())], {
      env: PASS,
    });
    expect(code).toBe(5);
    expect(stderr).toContain("casty init");
  });

  it("5 when a passphrase is needed and there is no terminal to ask on", async () => {
    const { args } = await ready();
    expect((await casty(["cast", "hi", ...args])).code).toBe(5);
  });
});

describe("init without a seed phrase", () => {
  it("--fid writes the config from the node, with no key: the page adds one with a wallet", async () => {
    const node = await startMock();
    const dir = tempConfig();
    const { code, stdout, stderr } = await casty([
      "init",
      "--fid",
      String(ME_FID),
      "--json",
      ...flags(node.url, dir),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      fid: ME_FID,
      custodyAddress: expect.stringMatching(/^0xf39F/),
      keys: [],
    });
    expect(existsSync(join(dir, "keys.enc.json"))).toBe(false);
    expect(stderr).toContain("casty web");
    const { stdout: who } = await casty(["whoami", "--json", ...flags(node.url, dir)]);
    expect(JSON.parse(who)).toMatchObject({ fid: ME_FID, activeKey: null });
  });

  it("--fid refuses a fid the node has no custody for, with exit code 5", async () => {
    const node = await startMock();
    const { code, stderr } = await casty([
      "init",
      "--fid",
      "4000000000",
      ...flags(node.url, tempConfig()),
    ]);
    expect(code).toBe(5);
    expect(stderr).toContain("4000000000");
  });
});

describe("the key store with two writers", () => {
  // Another casty (casty web, a second terminal) stores a key while this command waits on the
  // seed phrase prompt, after it loaded the store and before it saves it.
  async function storingAnotherKeyAtThePrompt(dir: string) {
    const other = {
      ...(loadKeys(dir, "x")[0] as KeyRecord),
      pubkey: "ab".repeat(32),
      privkey: "cd".repeat(32),
    };
    const prompt = async (question: string) => {
      if (!question.startsWith("seed phrase")) return new TextEncoder().encode("x");
      writeKeys(dir, [...loadKeys(dir, "x"), other], "x", { N: 2 ** 10, r: 8, p: 1 });
      return new TextEncoder().encode(TEST_MNEMONIC);
    };
    return { other, prompt };
  }

  it("init keeps a key stored while it ran", async () => {
    const { dir, args } = await ready();
    const { other, prompt } = await storingAnotherKeyAtThePrompt(dir);
    expect((await casty(["init", ...args], { tty: true, prompt })).code).toBe(0);
    expect(loadKeys(dir, "x").map((r) => r.pubkey)).toContain(other.pubkey);
  });

  it("key revoke keeps a key stored while it ran", async () => {
    const { dir, key, args } = await ready();
    const { other, prompt } = await storingAnotherKeyAtThePrompt(dir);
    expect((await casty(["key", "revoke", key, ...args], { tty: true, prompt })).code).toBe(0);
    const left = loadKeys(dir, "x").map((r) => r.pubkey);
    expect(left).toContain(other.pubkey);
    expect(left).not.toContain(key.slice(2));
  });
});
