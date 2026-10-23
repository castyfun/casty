import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configDir, diskCache, readConfig, writeConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { tempDir } from "./tmp.js";

const tmp = () => tempDir("casty-config-");
afterEach(() => vi.useRealTimers());

describe("configDir", () => {
  it("prefers --config, then $XDG_CONFIG_HOME/casty, then ~/.config/casty", () => {
    expect(configDir("/x", { XDG_CONFIG_HOME: "/y" })).toBe("/x");
    expect(configDir(undefined, { XDG_CONFIG_HOME: "/y" })).toBe("/y/casty");
    expect(configDir(undefined, { HOME: "/home/u" })).toBe("/home/u/.config/casty");
  });
});

describe("config file", () => {
  it("is absent before init", () => {
    expect(readConfig(tmp())).toBeUndefined();
  });

  it("round-trips", () => {
    const dir = tmp();
    const config = { fid: 2_000_000_001, custodyAddress: "0xabc" as const, keys: ["0x01"] };
    writeConfig(dir, config);
    expect(readConfig(dir)).toEqual(config);
  });

  it("rejects a file with the wrong shape", () => {
    const dir = tmp();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ fid: "one" }));
    expect(() => readConfig(dir)).toThrow(ConfigError);
  });

  it("rejects a file that is not JSON", () => {
    const dir = tmp();
    writeFileSync(join(dir, "config.json"), "{");
    expect(() => readConfig(dir)).toThrow(ConfigError);
  });
});

describe("diskCache", () => {
  it("survives a reload from disk", () => {
    const dir = tmp();
    const a = diskCache<number>(dir, "n", 60_000);
    a.set("k", 7);
    a.save();
    expect(diskCache<number>(dir, "n", 60_000).get("k")).toBe(7);
  });

  it("forgets entries older than the ttl", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = diskCache<number>(undefined, "n", 1000);
    cache.set("k", 1);
    vi.setSystemTime(Date.now() + 1001);
    expect(cache.get("k")).toBeUndefined();
  });

  it("keeps which entries were used last across a reload, with fids for keys too", () => {
    const dir = tmp();
    const a = diskCache<number>(dir, "n", 60_000, 2);
    a.set("2", 2);
    a.set("900", 900);
    a.get("2");
    a.save();
    const b = diskCache<number>(dir, "n", 60_000, 2);
    b.set("5", 5);
    expect(b.get("900")).toBeUndefined();
    expect(b.get("2")).toBe(2);
  });

  it("makes the config directory private when a cache is the first thing written there", () => {
    const dir = join(tmp(), "casty");
    const cache = diskCache<number>(dir, "n", 60_000);
    cache.set("k", 1);
    cache.save();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("does not write the file again when nothing was added since it was read", () => {
    const dir = tmp();
    const a = diskCache<number>(dir, "n", 60_000);
    a.set("k", 1);
    a.save();
    const file = join(dir, "cache", "n.json");
    const written = statSync(file).ino;
    const b = diskCache<number>(dir, "n", 60_000);
    b.get("k");
    b.save();
    expect(statSync(file).ino).toBe(written);
  });

  it("evicts the least recently used entry past its size cap", () => {
    const cache = diskCache<number>(undefined, "n", 60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("starts empty when the cache file is damaged", () => {
    const dir = tmp();
    mkdirSync(join(dir, "cache"));
    writeFileSync(join(dir, "cache", "n.json"), "not json");
    expect(diskCache<number>(dir, "n", 60_000).get("k")).toBeUndefined();
  });
});
