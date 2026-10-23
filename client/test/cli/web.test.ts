import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startMock } from "../mock.js";
import { casty, flags, initMe, PASS, type RunOptions, tempConfig } from "./harness.js";

/** Starts casty web, waits for its pairing link, and hands back a way to stop it. */
async function web(args: string[], options: RunOptions = {}) {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  let stop = () => {};
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let found: (link: string) => void = () => {};
  const link = new Promise<string>((resolve) => {
    found = resolve;
  });
  const onStdout = (text: string) => {
    const match = /(http:\/\/\S+\/#token=[\w-]{43})/.exec(text);
    if (match) found(match[1] as string);
  };
  const run = casty(["web", ...args, ...flags(node.url, dir)], { ...options, until, onStdout });
  const first = await Promise.race([link, run.then((r) => r)]);
  return { link: first, run, stop, dir, node };
}

async function session(link: unknown) {
  const url = new URL(String(link));
  const token = url.hash.slice("#token=".length);
  const res = await fetch(new URL("/api/session", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { canWrite: boolean };
}

it("unlocks the key, prints a link that pairs a browser, and stops cleanly", async () => {
  const { link, run, stop, node } = await web(["--listen", "127.0.0.1:0"], { env: PASS });
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  expect((await session(link)).canWrite).toBe(true);
  const url = new URL(String(link));
  const res = await fetch(new URL("/api/cast", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${url.hash.slice("#token=".length)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "signed by the key casty web unlocked" }),
  });
  const { hash } = (await res.json()) as { hash: string };
  expect(node.state.casts.some((c) => c.hash === hash)).toBe(true);
  stop();
  const { code, stderr } = await run;
  expect(code).toBe(0);
  expect(stderr).toContain("Ctrl-C");
});

it("with --read-only asks for no passphrase and the page cannot write", async () => {
  const { link, run, stop } = await web(["--listen", "127.0.0.1:0", "--read-only"]);
  expect((await session(link)).canWrite).toBe(false);
  stop();
  expect((await run).code).toBe(0);
});

it("refuses a wrong passphrase before serving anything", async () => {
  const { link } = await web(["--listen", "127.0.0.1:0"], { env: { CASTY_PASSPHRASE: "nope" } });
  expect(link).toMatchObject({ code: 5 });
});

it("on an address other phones can reach, prints a QR code and says the link is plain HTTP", async () => {
  const { run, stop } = await web(["--listen", "0.0.0.0:0", "--read-only"]);
  stop();
  const { stdout, stderr } = await run;
  expect(stdout).toMatch(/[▀▄█]{10}/);
  expect(stderr).toContain("plain HTTP");
});

it("on Ctrl-C lets a write in flight be confirmed first, and says so", async () => {
  const { link, run, stop, node } = await web(["--listen", "127.0.0.1:0"], { env: PASS });
  node.control({ mergeDelayMs: 300 });
  const url = new URL(String(link));
  const submits = node.state.stats.submits;
  const write = fetch(new URL("/api/cast", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${url.hash.slice("#token=".length)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "sent just before Ctrl-C" }),
  });
  // The node has the cast and casty web is waiting for it to merge: Ctrl-C now.
  await vi.waitFor(() => expect(node.state.stats.submits).toBe(submits + 1));
  stop();
  expect((await write).status).toBe(200);
  const { code, stderr } = await run;
  expect(code).toBe(0);
  expect(stderr).toContain("waiting for 1 write(s) to be confirmed");
});

it("leaves the token alone when --new-token cannot start, so the running page keeps working", async () => {
  const first = await web(["--listen", "127.0.0.1:0", "--read-only"]);
  const port = new URL(String(first.link)).port;
  const token = readFileSync(join(first.dir, "web-token"), "utf8");
  const again = ["web", "--listen", `127.0.0.1:${port}`, "--read-only", "--new-token"];
  const { code, stderr } = await casty([...again, "--config", first.dir]);
  expect(code).toBe(2);
  expect(stderr).toContain("is in use");
  expect(readFileSync(join(first.dir, "web-token"), "utf8")).toBe(token);
  expect((await session(first.link)).canWrite).toBe(false);
  first.stop();
  await first.run;
});

it("names an address this machine does not have as a usage error", async () => {
  const dir = tempConfig();
  const node = await startMock();
  expect((await initMe(node.url, dir)).code).toBe(0);
  const args = ["web", "--listen", "192.0.2.1:3390", "--read-only", ...flags(node.url, dir)];
  const { code, stderr } = await casty(args);
  expect(code).toBe(2);
  expect(stderr).toContain("cannot listen on 192.0.2.1:3390");
});

it("refuses a --listen that is not host:port, with exit code 2", async () => {
  const { code, stderr } = await casty(["web", "--listen", "3390", "--read-only"]);
  expect(code).toBe(2);
  expect(stderr).toContain("host:port");
});

it("with --no-allow-fname-server, looks names up on the node only", async () => {
  const { link, run, stop } = await web([
    "--listen",
    "127.0.0.1:0",
    "--read-only",
    "--no-allow-fname-server",
  ]);
  const url = new URL(String(link));
  const res = await fetch(new URL("/api/resolve?name=nobody-here", url), {
    headers: { authorization: `Bearer ${url.hash.slice("#token=".length)}` },
  });
  stop();
  await run;
  expect(((await res.json()) as { hint: string }).hint).toContain("the node does not know it");
});
