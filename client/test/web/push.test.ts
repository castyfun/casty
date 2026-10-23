import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { FIRST_AUTHOR, FIXTURE_TIME, ME_FID } from "@casty/mock-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptForPush, openPush, vapidToken } from "../../src/web/push.js";
import { tempConfig } from "../cli/harness.js";
import { cast } from "../feed/helpers.js";
import { setupWeb as setup } from "./setup.js";

const b64 = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// RFC 8291, Appendix A: the example the whole encryption is checked against.
const RFC = {
  plaintext: b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
  asPublic: b64(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ),
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  uaPublic: b64(
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ),
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  auth: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  header: b64(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ),
  ciphertext: b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"),
};

/** The receiving side of RFC 8291, as a browser does it, for the tests to read what was sent. */
function decrypt(message: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const idlen = message[20] as number;
  const asPublic = message.subarray(21, 21 + idlen);
  const body = message.subarray(21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const padded = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  return padded.subarray(0, end);
}

describe("the encryption", () => {
  it("produces RFC 8291's example message from its keys and salt", () => {
    const message = encryptForPush(
      RFC.plaintext,
      { p256dh: b64url(RFC.uaPublic), auth: b64url(RFC.auth) },
      { salt: RFC.salt, senderPrivate: RFC.asPrivate },
    );
    expect(message.subarray(0, 86)).toEqual(RFC.header);
    expect(message.subarray(86)).toEqual(RFC.ciphertext);
  });

  it("is read back by the receiver's key, with a fresh salt and sender key each time", () => {
    const keys = { p256dh: b64url(RFC.uaPublic), auth: b64url(RFC.auth) };
    const one = encryptForPush(Buffer.from("hello"), keys);
    const two = encryptForPush(Buffer.from("hello"), keys);
    expect(one.equals(two)).toBe(false);
    expect(decrypt(one, RFC.uaPrivate, RFC.auth).toString()).toBe("hello");
    expect(decrypt(two, RFC.uaPrivate, RFC.auth).toString()).toBe("hello");
  });
});

describe("the VAPID token", () => {
  it("is an ES256 JWT for the push service's origin, expiring within a day, that its public key checks", () => {
    const push = openPush(tempConfig());
    const { token, key } = vapidToken(push.keys, "https://push.example.net/send/abc");
    const [header, claims, signature] = token.split(".") as [string, string, string];
    expect(JSON.parse(b64(header).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const body = JSON.parse(b64(claims).toString());
    expect(body.aud).toBe("https://push.example.net");
    expect(body.exp).toBeGreaterThan(Date.now() / 1000);
    expect(body.exp).toBeLessThanOrEqual(Date.now() / 1000 + 86_400);
    expect(body.sub).toMatch(/^(mailto:|https:)/);
    expect(b64(signature)).toHaveLength(64);
    const raw = b64(key);
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(4);
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
      format: "jwk",
    });
    const data = Buffer.from(`${header}.${claims}`);
    expect(
      verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, b64(signature)),
    ).toBe(true);
  });

  it("keeps its key pair in vapid.json, mode 0600, so a restart keeps the subscriptions valid", () => {
    const dir = tempConfig();
    const first = openPush(dir);
    const file = join(dir, "vapid.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(openPush(dir).keys.publicKey).toBe(first.keys.publicKey);
  });
});

/** A push service of our own: a browser's endpoint, answering what the test says. */
function pushService(answer = 201) {
  const received: { headers: IncomingMessage["headers"]; body: Buffer; at: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks), at: performance.now() });
      res.writeHead(answer).end();
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/send`, received, close: () => server.close() });
    });
  });
}

/** A browser's subscription to a push service: its keys, and how to read what it gets. */
function browser(endpoint: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) } },
    read: (message: Buffer) => JSON.parse(decrypt(message, ua.getPrivateKey(), auth).toString()),
  };
}

describe("the page", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  // Two whole setups, a key store each: past 5 s when make check runs its five targets at once.
  it("names the push key in the session only when casty serve can notify", {
    timeout: 15_000,
  }, async () => {
    const { api } = await setup({ index: true, push: true });
    expect((await api("/api/session")).body.push).toMatch(/^B[\w-]{86}$/);
    const { api: plain } = await setup();
    expect((await plain("/api/session")).body.push).toBeNull();
  });

  it("sends a push within 5 s of a mention or a reply, saying who and no more, and drops a gone endpoint", async () => {
    const service = await pushService();
    const gone = await pushService(410);
    closers.push(service.close, gone.close);
    const { api, node, dir } = await setup({ index: true, push: true });
    const phone = browser(service.url);
    const lost = browser(gone.url);
    expect((await api("/api/push/subscribe", phone.subscription)).status).toBe(200);
    expect((await api("/api/push/subscribe", lost.subscription)).status).toBe(200);
    const mine = (await api("/api/cast", { text: "anyone?" })).body;
    const t = FIXTURE_TIME + 100_000;
    const mention = cast(FIRST_AUTHOR, t, "a1", {
      castAddBody: { text: " secret text", mentions: [ME_FID], mentionsPositions: [0], embeds: [] },
    });
    const reply = cast(FIRST_AUTHOR, t + 1, "a2", {
      castAddBody: {
        text: "r",
        mentions: [],
        mentionsPositions: [],
        embeds: [],
        parentCastId: { fid: mine.fid, hash: mine.hash },
      },
    });
    const started = performance.now();
    node.control({ emitEvents: [mention, reply] });
    await vi.waitFor(() => expect(service.received).toHaveLength(2), {
      timeout: 5000,
      interval: 50,
    });
    expect((service.received[0]?.at as number) - started).toBeLessThan(5000);
    const [first, second] = service.received as [
      (typeof service.received)[0],
      (typeof service.received)[0],
    ];
    expect(first.headers["content-encoding"]).toBe("aes128gcm");
    expect(first.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(first.headers.ttl).toBeDefined();
    const titles = [phone.read(first.body), phone.read(second.body)].map((p) => p.title).sort();
    expect(titles).toEqual([
      `new mention from @user-${FIRST_AUTHOR}`,
      `new reply from @user-${FIRST_AUTHOR}`,
    ]);
    expect(JSON.stringify([phone.read(first.body), phone.read(second.body)])).not.toContain(
      "secret",
    );
    expect(phone.read(first.body).url).toBe("#/mentions");
    await vi.waitFor(() => expect(gone.received.length).toBeGreaterThan(0));
    await vi.waitFor(() => {
      const kept = JSON.parse(readFileSync(join(dir, "cache", "push.json"), "utf8"));
      expect(kept.map((s: { endpoint: string }) => s.endpoint)).toEqual([service.url]);
    });
    expect((await api("/api/push/unsubscribe", { endpoint: service.url })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "cache", "push.json"), "utf8"))).toEqual([]);
  });

  it("does not notify about your own casts, or a cast that neither mentions nor answers you", async () => {
    const service = await pushService();
    closers.push(service.close);
    const { api, node } = await setup({ index: true, push: true });
    await api("/api/push/subscribe", browser(service.url).subscription);
    await api("/api/cast", { text: "by me, mentioning myself?" });
    node.control({ emitEvents: [cast(FIRST_AUTHOR, FIXTURE_TIME + 100_000, "b1")] });
    await new Promise((r) => setTimeout(r, 300));
    expect(service.received).toHaveLength(0);
  });

  it("refuses a subscription that is not an https endpoint with P-256 keys", async () => {
    const { api } = await setup({ index: true, push: true });
    const good = browser("https://push.example.net/send/1").subscription;
    expect((await api("/api/push/subscribe", { ...good, endpoint: "ftp://x" })).status).toBe(400);
    expect(
      (
        await api("/api/push/subscribe", {
          ...good,
          keys: { p256dh: "short", auth: good.keys.auth },
        })
      ).status,
    ).toBe(400);
    expect((await api("/api/push/subscribe", good)).status).toBe(200);
  });

  it("is refused on a page without push", async () => {
    const { api } = await setup();
    expect(
      (await api("/api/push/subscribe", browser("https://push.example.net/s").subscription)).status,
    ).toBe(404);
  });

  it("serves the service worker, which registers handlers for a push and a tap", async () => {
    const { web } = await setup();
    const res = await fetch(`${web.url}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/javascript/);
    const source = await res.text();
    const handlers = new Map<string, (event: unknown) => unknown>();
    const self = {
      addEventListener: (name: string, fn: (event: unknown) => unknown) => handlers.set(name, fn),
    };
    new Function("self", source)(self);
    expect([...handlers.keys()].sort()).toEqual(["notificationclick", "push"]);
    expect(existsSync(join(import.meta.dirname, "../../src/web/assets/sw.js"))).toBe(true);
  });
});

describe("what the review found", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  it("refuses a p256dh that is not a point on the curve, which would break every push", async () => {
    const { api } = await setup({ index: true, push: true });
    const good = browser("https://push.example.net/send/1").subscription;
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 1)]);
    const bad = { ...good, keys: { ...good.keys, p256dh: b64url(offCurve) } };
    expect((await api("/api/push/subscribe", bad)).status).toBe(400);
  });

  it("keeps sending to the others when one subscription's key cannot be used", async () => {
    const service = await pushService();
    closers.push(service.close);
    const push = openPush(tempConfig());
    const fine = browser(service.url).subscription;
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 1)]);
    push.subscribe(fine);
    push.subscribe({
      endpoint: "http://127.0.0.1:1/nowhere",
      keys: { ...fine.keys, p256dh: b64url(offCurve) },
    });
    await push.notify("hi", "#/mentions");
    expect(service.received).toHaveLength(1);
  });

  it("takes only https endpoints, and http on this machine for tests, so the service posts nowhere else", async () => {
    const { api } = await setup({ index: true, push: true });
    const good = browser("https://push.example.net/send/1").subscription;
    for (const endpoint of [
      "http://169.254.169.254/latest/api/token",
      "http://snapchain:3381/v1/submitMessage",
      "http://example.com/x",
    ]) {
      expect((await api("/api/push/subscribe", { ...good, endpoint })).status, endpoint).toBe(400);
    }
    expect(
      (await api("/api/push/subscribe", { ...good, endpoint: "http://127.0.0.1:1/x" })).status,
    ).toBe(200);
  });

  it("answers 415 to a subscription that is not JSON", async () => {
    const { web } = await setup({ index: true, push: true });
    const res = await fetch(`${web.url}/api/push/subscribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${"t".repeat(43)}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("refuses a payload that does not fit one record", () => {
    const keys = { p256dh: b64url(RFC.uaPublic), auth: b64url(RFC.auth) };
    expect(() => encryptForPush(Buffer.alloc(5000), keys)).toThrow(/record/);
  });

  it("opens mentions on a tap even in the page that subscribed, which the worker does not control yet", async () => {
    const { web } = await setup();
    const source = await (await fetch(`${web.url}/sw.js`)).text();
    const handlers = new Map<string, (event: any) => unknown>();
    const opened: string[] = [];
    const focused: string[] = [];
    const uncontrolled = {
      url: "https://node.example.org/",
      focus: async () => uncontrolled,
      // The spec: navigate() rejects for a client this worker does not control.
      navigate: async () => {
        throw new TypeError("not controlled");
      },
    };
    const self = {
      location: { origin: "https://node.example.org" },
      addEventListener: (name: string, fn: (event: any) => unknown) => handlers.set(name, fn),
      clients: {
        matchAll: async () => [uncontrolled],
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    };
    new Function("self", source)(self);
    let done: Promise<unknown> = Promise.resolve();
    handlers.get("notificationclick")?.({
      notification: { close: () => {}, data: { url: "#/mentions" } },
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
    expect(opened).toEqual(["https://node.example.org/#/mentions"]);
    expect(focused).toEqual([]);
  });
});

describe("a push service that answers an error", () => {
  it("is named in the log, and the subscription is kept for the next time", async () => {
    const service = await pushService(503);
    const logged: string[] = [];
    const push = openPush(tempConfig(), (text) => logged.push(text));
    push.subscribe(browser(service.url).subscription);
    await push.notify("hi", "#/mentions");
    service.close();
    expect(logged).toEqual([`push: ${new URL(service.url).host} answered HTTP 503`]);
    expect(push.subscriptions()).toHaveLength(1);
  });
});
