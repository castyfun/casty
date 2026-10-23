import { vi } from "vitest";

// The key store's real scrypt cost (N=2^17) takes about a third of a second per derivation, and
// the CLI and web tests run casty init dozens of times. saveKeys writes at N=2^10 here instead;
// the file records the cost, so loading is unchanged. test/keys/store.test.ts checks the real
// cost, and that nothing in src writes at another one.
vi.mock("../src/keys/store.js", async (importOriginal) => {
  const store = await importOriginal<typeof import("../src/keys/store.js")>();
  return {
    ...store,
    saveKeys: (...[dir, records, passphrase]: Parameters<typeof store.saveKeys>) =>
      store.writeKeys(dir, records, passphrase, { N: 2 ** 10, r: 8, p: 1 }),
  };
});

// Tests reach only this machine: a fetch anywhere else (the fname registry, an RPC) fails inside
// the code that made it, as an unreachable server would, instead of leaving the sandbox.
const realFetch = globalThis.fetch;
const e2eNode = process.env.CASTY_E2E_NODE_URL
  ? new URL(process.env.CASTY_E2E_NODE_URL).hostname
  : "";
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]", e2eNode].includes(url.hostname)) {
    return Promise.reject(new TypeError(`a test tried to reach ${url.origin}`));
  }
  return realFetch(input, init);
};
