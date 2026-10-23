import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

export const DEFAULT_NODE_URL = "http://127.0.0.1:3381";

/**
 * Writes `text` to `path` whole: to a temporary file of this process's own, then renamed over
 * it. A terminal and casty web may write the same file at once; each sees the old file or the
 * new one, never half of one.
 */
export function writeAtomic(path: string, text: string, mode = 0o644): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/** What a new app key may sign unless `casty init --scopes` says otherwise. */
export const DEFAULT_SCOPE_NAMES = "cast,reaction,link";

/** Test-only way to supply the key store passphrase without a prompt. */
export const PASSPHRASE_ENV = "CASTY_PASSPHRASE";
/** A file holding the passphrase: a docker secret or a systemd credential, for casty serve. */
export const PASSPHRASE_FILE_ENV = "CASTY_PASSPHRASE_FILE";

/** Public fname registry; asked only when the node does not know a name. No key needed. */
export const FNAME_SERVER = "https://fnames.farcaster.xyz";

/** Web link printed after a cast: farcaster.xyz links a cast by name and the hash's first 10. */
export function castUrl(username: string, hash: string): string {
  return `https://farcaster.xyz/${username}/${hash.slice(0, 10)}`;
}

export function configDir(override: string | undefined, env: NodeJS.ProcessEnv): string {
  if (override) return override;
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(base, "casty");
}

/** Public facts written by `casty init`. Secrets live only in keys.enc.json. */
export interface Config {
  fid: number;
  custodyAddress: `0x${string}`;
  /** Public keys of the app keys in the store, oldest first. */
  keys: string[];
}

const CONFIG_FILE = "config.json";

function isConfig(value: unknown): value is Config {
  const c = value as Partial<Config> | null;
  return (
    typeof c === "object" &&
    c !== null &&
    Number.isInteger(c.fid) &&
    typeof c.custodyAddress === "string" &&
    c.custodyAddress.startsWith("0x") &&
    Array.isArray(c.keys) &&
    c.keys.every((k) => typeof k === "string")
  );
}

export function readConfig(dir: string): Config | undefined {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`, "fix or delete it, then run casty init");
  }
  if (!isConfig(value))
    throw new ConfigError(`${path} is not a casty config`, "fix or delete it, then run casty init");
  return value;
}

export function writeConfig(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export interface Cache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Writes the cache to `dir/cache/<name>.json`; a no-op for memory-only caches. */
  save(): void;
}

/** An LRU of at most `max` entries that expire after `ttlMs`, optionally kept on disk. */
export function diskCache<T>(
  dir: string | undefined,
  name: string,
  ttlMs: number,
  max = 2000,
): Cache<T> {
  const path = dir ? join(dir, "cache", `${name}.json`) : undefined;
  const entries = new Map<string, { at: number; value: T }>();
  // Set since the file was read or written: a feed that only read from the cache leaves it be.
  let changed = false;
  if (path && existsSync(path)) {
    try {
      // Saved as [key, entry] pairs, least recently used first; an object (from before) would
      // put fid keys in numeric order instead.
      const saved = JSON.parse(readFileSync(path, "utf8"));
      for (const [key, entry] of Array.isArray(saved) ? saved : Object.entries(saved)) {
        entries.set(key, entry as { at: number; value: T });
      }
    } catch {
      entries.clear();
    }
  }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry || Date.now() - entry.at >= ttlMs) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      changed = true;
      entries.delete(key);
      entries.set(key, { at: Date.now(), value });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    save() {
      if (!path || !dir || !changed) return;
      try {
        // A read before `casty init` may be the first thing to create the config directory.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        mkdirSync(join(dir, "cache"), { recursive: true });
        writeAtomic(path, JSON.stringify([...entries]));
        changed = false;
      } catch {
        // A cache that cannot be written only makes the next run slower.
      }
    },
  };
}

/** fnames and the fids they resolved to (fidForName), kept a day. */
export const namesCache = (dir: string | undefined) => diskCache<number>(dir, "names", 86_400_000);
