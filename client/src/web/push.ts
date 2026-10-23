import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Cache, writeAtomic } from "../config.js";
import { usernames } from "../feed/clients.js";
import { who } from "../feed/render.js";
import type { NodeClient, NodeMessage } from "../node/http.js";

/**
 * Web Push from casty serve: a mention or a reply reaches the phone as a notification with the
 * sender's name and nothing else. The message is encrypted for the browser's key (RFC 8291,
 * aes128gcm) and signed for the push service (RFC 8292, VAPID), both with node:crypto; the
 * push service, Apple's, Google's or Mozilla's, sees only the ciphertext.
 */
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** The uncompressed P-256 point (65 bytes), base64url: what the page subscribes with. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

export interface Push {
  keys: VapidKeys;
  subscriptions(): Subscription[];
  subscribe(subscription: Subscription): void;
  unsubscribe(endpoint: string): void;
  /** Sends `{ title, url }` to every subscription; one the service says is gone is dropped. */
  notify(title: string, url: string): Promise<void>;
}

const VAPID_FILE = "vapid.json";
const SUBSCRIPTIONS_FILE = "push.json";
/** Who to reach about this sender, as RFC 8292 asks for. */
const VAPID_SUBJECT = "https://github.com/castyfun/casty";
/** How long the push service may hold a notification for a phone that is off. */
const TTL_SECONDS = 86_400;
const RECORD_SIZE = 4096;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** RFC 8291: `plaintext` encrypted for the browser's keys, with the aes128gcm header in front. */
export function encryptForPush(
  plaintext: Uint8Array,
  keys: Subscription["keys"],
  options: { salt?: Buffer; senderPrivate?: Buffer } = {},
): Buffer {
  // One record: the plaintext, the delimiter and the tag must fit the record size.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error(`a push payload must fit one record of ${RECORD_SIZE} bytes`);
  }
  const uaPublic = Buffer.from(keys.p256dh, "base64url");
  const auth = Buffer.from(keys.auth, "base64url");
  const sender = createECDH("prime256v1");
  if (options.senderPrivate) sender.setPrivateKey(options.senderPrivate);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const shared = sender.computeSecret(uaPublic);
  const salt = options.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // One record: the plaintext, then the delimiter of the last record (0x02), then the tag.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292: the JWT for the push service at `endpoint`, and the key it checks it with. */
export function vapidToken(keys: VapidKeys, endpoint: string): { token: string; key: string } {
  const raw = Buffer.from(keys.publicKey, "base64url");
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(raw.subarray(1, 33)),
      y: b64url(raw.subarray(33)),
      d: keys.privateKey,
    },
    format: "jwk",
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: VAPID_SUBJECT,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return { token: `${header}.${claims}.${b64url(signature)}`, key: keys.publicKey };
}

function newVapidKeys(): VapidKeys {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return { publicKey: b64url(point), privateKey: jwk.d };
}

/** A push service's endpoint: https anywhere, http only on this machine, for the tests. */
function isEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** A point on P-256, as the browser's key must be: an off-curve one would fail every send. */
function isPoint(p256dh: string): boolean {
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33)),
      },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

function isSubscription(value: unknown): value is Subscription {
  const s = value as Partial<Subscription> | null;
  if (typeof s !== "object" || s === null || typeof s.endpoint !== "string") return false;
  if (!isEndpoint(s.endpoint)) return false;
  const keys = s.keys as Partial<Subscription["keys"]> | undefined;
  if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") return false;
  return isPoint(keys.p256dh) && Buffer.from(keys.auth, "base64url").length === 16;
}

/** A subscription as the page sent it, or why it is not one. */
export function parseSubscription(value: unknown): Subscription {
  if (!isSubscription(value)) {
    throw new Error(
      "a subscription has an https endpoint, a base64url P-256 point as p256dh and 16 bytes of auth",
    );
  }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

/**
 * The sender's keys from `dir/vapid.json` (made on first use, mode 0600: a change would void
 * every subscription) and the subscriptions in `dir/cache/push.json`.
 */
export function openPush(dir: string, log: (text: string) => void = () => {}): Push {
  const keysPath = join(dir, VAPID_FILE);
  let keys: VapidKeys;
  if (existsSync(keysPath)) {
    keys = JSON.parse(readFileSync(keysPath, "utf8"));
  } else {
    keys = newVapidKeys();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(keysPath, `${JSON.stringify(keys, null, 2)}\n`, 0o600);
  }
  const subscriptionsPath = join(dir, "cache", SUBSCRIPTIONS_FILE);
  let subscriptions: Subscription[] = [];
  if (existsSync(subscriptionsPath)) {
    try {
      subscriptions = (JSON.parse(readFileSync(subscriptionsPath, "utf8")) as unknown[]).filter(
        isSubscription,
      );
    } catch {
      subscriptions = [];
    }
  }
  const save = () => {
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeAtomic(subscriptionsPath, `${JSON.stringify(subscriptions)}\n`, 0o600);
  };

  async function send(subscription: Subscription, body: Buffer): Promise<void> {
    const { token, key } = vapidToken(keys, subscription.endpoint);
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_SECONDS),
        urgency: "normal",
        authorization: `vapid t=${token}, k=${key}`,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) {
      // The browser let the subscription go: the service will never take it again.
      subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
      save();
    } else if (!res.ok) {
      log(`push: ${new URL(subscription.endpoint).host} answered HTTP ${res.status}`);
    }
  }

  return {
    keys,
    subscriptions: () => [...subscriptions],
    subscribe(subscription) {
      subscriptions = [
        ...subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ];
      save();
    },
    unsubscribe(endpoint) {
      subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
      save();
    },
    async notify(title, url) {
      const payload = Buffer.from(JSON.stringify({ title, url }));
      // Each send, its encryption included, settles on its own: one bad key stops no other.
      const results = await Promise.allSettled(
        subscriptions.map(async (s) => send(s, encryptForPush(payload, s.keys))),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          log(`push: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
        }
      }
    },
  };
}

/** What the indexer calls with a cast that speaks to you: a push naming its author. */
export function mentionNotifier(
  node: NodeClient,
  names: Cache<string>,
  push: Push,
  log: (text: string) => void = () => {},
) {
  return (cast: NodeMessage, kind: "mention" | "reply"): void => {
    usernames(node, [cast.data.fid], names)
      .then((found) =>
        push.notify(
          `new ${kind} from ${who(found.get(cast.data.fid) ?? null, cast.data.fid)}`,
          "#/mentions",
        ),
      )
      .catch((error: unknown) => log(`push: ${error instanceof Error ? error.message : error}`));
  };
}
