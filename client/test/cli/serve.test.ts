import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startMock } from "../mock.js";
import { casty, flags, initMe, PASS, type RunOptions, tempConfig } from "./harness.js";

/** Starts casty serve behind a public host, waits for its link, and hands back a way to stop it. */
async function serve(args: string[], options: RunOptions = {}) {
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
  let local = "";
  const onStdout = (text: string) => {
    local ||= /casty serve on (http:\/\/\S+)/.exec(text)?.[1] ?? "";
    const match = /(https:\/\/\S+\/#token=[\w-]{43})/.exec(text);
    if (match) found(match[1] as string);
  };
  const run = casty(["serve", ...args, ...flags(node.url, dir)], { ...options, until, onStdout });
  const first = await Promise.race([link, run.then((r) => r)]);
  return { link: first, run, stop, dir, node, local: () => local };
}

/** A raw request with any Host, answering the status and the headers. */
function raw(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    request(url, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    })
      .on("error", reject)
      .end();
  });
}

const tokenOf = (link: unknown) => new URL(String(link)).hash.slice("#token=".length);

it("prints an https link through the public host, with a QR code, and no plain-HTTP warning", async () => {
  const { link, run, stop, local } = await serve(
    ["--public-host", "node.example.org", "--listen", "127.0.0.1:0"],
    { env: PASS },
  );
  expect(link).toMatch(/^https:\/\/node\.example\.org\/#token=[\w-]{43}$/);
  expect(local()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  stop();
  const { code, stdout, stderr } = await run;
  expect(code).toBe(0);
  expect(stdout).toMatch(/[▀▄█]{10}/);
  expect(stderr).not.toContain("plain HTTP");
  expect(stderr).toContain("node.example.org");
});

it("takes the public host as Host, sends HSTS, and still refuses any other name", async () => {
  const { link, run, stop, local } = await serve([
    "--public-host",
    "node.example.org",
    "--listen",
    "127.0.0.1:0",
    "--read-only",
  ]);
  const url = local();
  const page = await raw(url, { host: "node.example.org" });
  expect(page.status).toBe(200);
  expect(page.headers["strict-transport-security"]).toBe("max-age=31536000");
  expect((await raw(url, { host: "Node.Example.org:443" })).status).toBe(200);
  expect((await raw(url, { host: "evil.example" })).status).toBe(403);
  const api = await raw(`${url}/api/session`, {
    host: "node.example.org",
    authorization: `Bearer ${tokenOf(link)}`,
  });
  expect(api.status).toBe(200);
  expect(api.headers["strict-transport-security"]).toBe("max-age=31536000");
  stop();
  await run;
});

it("answers 429 to a client address past 120 API requests a minute, and others as before", async () => {
  const { run, stop, local } = await serve([
    "--public-host",
    "node.example.org",
    "--listen",
    "127.0.0.1:0",
    "--read-only",
  ]);
  const url = `${local()}/api/nope`;
  // The address the proxy appends last to X-Forwarded-For is the client's; an earlier one is
  // whatever the client sent.
  const headers = { host: "node.example.org", "x-forwarded-for": "198.51.100.1, 203.0.113.9" };
  // Counted before the token is checked, so an unpaired flood is limited too.
  for (let i = 0; i < 120; i++) expect((await raw(url, headers)).status, `request ${i}`).toBe(401);
  const refused = await raw(url, headers);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  const spoofed = { host: "node.example.org", "x-forwarded-for": "198.51.100.2, 203.0.113.9" };
  expect((await raw(url, spoofed)).status).toBe(429);
  const other = { host: "node.example.org", "x-forwarded-for": "203.0.113.10" };
  expect((await raw(url, other)).status).toBe(401);
  expect((await raw(local(), headers)).status).toBe(200);
  stop();
  await run;
});

it("reads the key store passphrase from the file CASTY_PASSPHRASE_FILE names", async () => {
  const file = join(tempConfig(), "passphrase");
  writeFileSync(file, "x\n");
  const { link, run, stop, local } = await serve(
    ["--public-host", "node.example.org", "--listen", "127.0.0.1:0"],
    { env: { CASTY_PASSPHRASE_FILE: file } },
  );
  const session = await fetch(`${local()}/api/session`, {
    headers: { authorization: `Bearer ${tokenOf(link)}` },
  });
  expect(((await session.json()) as { canWrite: boolean }).canWrite).toBe(true);
  stop();
  await run;
});

it("stops with exit 5 when CASTY_PASSPHRASE_FILE names a file that is not there", async () => {
  const { link } = await serve(["--public-host", "node.example.org", "--listen", "127.0.0.1:0"], {
    env: { CASTY_PASSPHRASE_FILE: "/nonexistent/passphrase" },
  });
  expect(link).toMatchObject({ code: 5 });
});

it("without --public-host serves like casty web, from the index, with the limit and no HSTS", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  let stop = () => {};
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let url = "";
  let link = "";
  const run = casty(["serve", "--listen", "127.0.0.1:0", "--read-only", ...flags(node.url, dir)], {
    until,
    onStdout: (text) => {
      url ||= /casty serve on (http:\/\/\S+)/.exec(text)?.[1] ?? "";
      link ||= /(http:\/\/\S+\/#token=[\w-]{43})/.exec(text)?.[1] ?? "";
    },
  });
  while (!url || !link) await new Promise((r) => setTimeout(r, 10));
  const page = await raw(url, { host: "localhost" });
  expect(page.status).toBe(200);
  expect(page.headers["strict-transport-security"]).toBeUndefined();
  await vi.waitFor(async () => {
    const again = await fetch(`${url}/api/session`, {
      headers: { authorization: `Bearer ${tokenOf(link)}` },
    });
    expect(((await again.json()) as { index: boolean }).index).toBe(true);
  });
  // The pairing link is in the stdout, whatever the index did.
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  stop();
  await run;
});

it("counts 120 requests a minute from one address before the 121st gets 429", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  let stop = () => {};
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let url = "";
  const run = casty(["serve", "--listen", "127.0.0.1:0", "--read-only", ...flags(node.url, dir)], {
    until,
    onStdout: (text) => {
      url ||= /casty serve on (http:\/\/\S+)/.exec(text)?.[1] ?? "";
    },
  });
  while (!url) await new Promise((r) => setTimeout(r, 10));
  // The first request from this address: the window starts here.
  for (let i = 1; i <= 120; i++) {
    expect((await raw(`${url}/api/nope`, { host: "localhost" })).status, `request ${i}`).toBe(401);
  }
  expect((await raw(`${url}/api/nope`, { host: "localhost" })).status).toBe(429);
  stop();
  await run;
});

it("casty web sends no HSTS", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  let stop = () => {};
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let url = "";
  const run = casty(["web", "--listen", "127.0.0.1:0", "--read-only", ...flags(node.url, dir)], {
    until,
    onStdout: (text) => {
      url ||= /casty web on (http:\/\/\S+)/.exec(text)?.[1] ?? "";
    },
  });
  while (!url) await new Promise((r) => setTimeout(r, 10));
  const page = await raw(url, { host: "localhost" });
  expect(page.status).toBe(200);
  expect(page.headers["strict-transport-security"]).toBeUndefined();
  stop();
  await run;
});

it("indexes the feed into index.sqlite in the config directory and says so", async () => {
  const { run, stop, dir } = await serve([
    "--public-host",
    "node.example.org",
    "--listen",
    "127.0.0.1:0",
    "--read-only",
  ]);
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  await vi.waitFor(() => expect(existsSync(join(dir, "index.sqlite"))).toBe(true));
  stop();
  const { code, stderr } = await run;
  expect(code).toBe(0);
  expect(stderr).toContain("index");
});

it("without --public-host, counts by the socket's address and ignores X-Forwarded-For", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  let stop = () => {};
  const until = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let url = "";
  const run = casty(["serve", "--listen", "127.0.0.1:0", "--read-only", ...flags(node.url, dir)], {
    until,
    onStdout: (text) => {
      url ||= /casty serve on (http:\/\/\S+)/.exec(text)?.[1] ?? "";
    },
  });
  while (!url) await new Promise((r) => setTimeout(r, 10));
  // A new forwarded address on every request would be a new window, were the header trusted.
  for (let i = 0; i < 120; i++) {
    await raw(`${url}/api/nope`, { host: "localhost", "x-forwarded-for": `203.0.113.${i % 250}` });
  }
  expect(
    (await raw(`${url}/api/nope`, { host: "localhost", "x-forwarded-for": "198.51.100.7" })).status,
  ).toBe(429);
  stop();
  await run;
});

it("takes the first line of CASTY_PASSPHRASE_FILE, so an editor's trailing newlines do no harm", async () => {
  const file = join(tempConfig(), "passphrase");
  writeFileSync(file, "x\n\n");
  const { link, run, stop, local } = await serve(
    ["--public-host", "node.example.org", "--listen", "127.0.0.1:0"],
    { env: { CASTY_PASSPHRASE_FILE: file } },
  );
  const session = await fetch(`${local()}/api/session`, {
    headers: { authorization: `Bearer ${tokenOf(link)}` },
  });
  expect(((await session.json()) as { canWrite: boolean }).canWrite).toBe(true);
  stop();
  await run;
});
