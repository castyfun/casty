import { ME_FID, type MockNode } from "@casty/mock-node";
import { afterEach, expect } from "vitest";
import { readConfig, writeConfig } from "../../src/config.js";
import { feedCaches } from "../../src/feed/feed.js";
import { privateKeyBytes, withSigner } from "../../src/keys/signer.js";
import { type KeyRecord, loadKeys, saveKeys } from "../../src/keys/store.js";
import { type Indexer, startIndexer } from "../../src/local/indexer.js";
import { openIndex } from "../../src/local/store.js";
import { nodeClient } from "../../src/node/http.js";
import { mentionNotifier, openPush, type Push } from "../../src/web/push.js";
import { startWeb, type Web, type WebDeps } from "../../src/web/server.js";
import { initMe, tempConfig } from "../cli/harness.js";
import { startMock } from "../mock.js";

export const TOKEN = "t".repeat(43);
const running: Web[] = [];
const indexers: Indexer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((web) => web.close()));
  for (const indexer of indexers.splice(0)) {
    indexer.close();
    indexer.index.close();
  }
});

/**
 * casty web on a free port over a mock node with an initialised fid, closed after the test.
 * `index: true` serves it over the index after its first pass, as casty serve does; "cold" over
 * one whose first pass never ends. A `node` and `dir` from another setup are reused as given.
 */
export async function setupWeb({
  write = true,
  sign,
  fnameServer,
  index,
  push: withPush,
  node: given,
  dir: givenDir,
}: {
  write?: boolean;
  sign?: WebDeps["sign"];
  fnameServer?: string;
  index?: boolean | "cold";
  /** Web Push from the indexer's events, with keys made in the config directory. */
  push?: boolean;
  node?: MockNode;
  dir?: string;
} = {}) {
  const node = given ?? (await startMock());
  const dir = givenDir ?? tempConfig();
  if (!givenDir) expect((await initMe(node.url, dir)).code).toBe(0);
  let local: Indexer | undefined;
  let push: Push | undefined;
  if (withPush) push = openPush(dir);
  if (index === true) {
    const api = nodeClient(node.url);
    local = startIndexer(api, openIndex(":memory:"), {
      fid: ME_FID,
      pollMs: 50,
      onNotable: push ? mentionNotifier(api, feedCaches(dir).names, push) : undefined,
    });
    indexers.push(local);
    await local.started;
  } else if (index === "cold") {
    const store = openIndex(":memory:");
    // A first pass that never ends: what a write must not wait for.
    local = {
      index: store,
      started: new Promise(() => {}),
      ready: () => false,
      catchUp: () => new Promise(() => {}),
      close: () => {},
    };
    indexers.push(local);
  }
  const records = loadKeys(dir, "x");
  if (!records[0]) throw new Error("init stored no key");
  const config = readConfig(dir) ?? { fid: ME_FID, custodyAddress: "0x" as const, keys: [] };
  // The newest key, as casty web signs with: one added from the page is used at once.
  const unlocked = <T>(fn: (signer: never) => Promise<T>) =>
    withSigner(privateKeyBytes((records.at(-1) as KeyRecord).privkey), fn as never) as Promise<T>;
  const addKey = (record: KeyRecord) => {
    const at = records.findIndex((r) => r.pubkey === record.pubkey);
    if (at >= 0) records[at] = record;
    else records.push(record);
    saveKeys(dir, records, "x");
    if (!config.keys.includes(`0x${record.pubkey}`)) config.keys.push(`0x${record.pubkey}`);
    writeConfig(dir, config);
  };
  const web = await startWeb(
    {
      node: nodeClient(node.url),
      dir,
      config,
      confirm: { timeoutMs: 1000, pollMs: 10 },
      token: TOKEN,
      fnameServer,
      local,
      push,
      ...(write ? { sign: sign ?? unlocked, addKey } : {}),
    },
    { host: "127.0.0.1", port: 0 },
  );
  running.push(web);
  const api = async (path: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(`${web.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { node, dir, web, api };
}
