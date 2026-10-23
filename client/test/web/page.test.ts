import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_AUTHOR, fixtureKey, ME_FID } from "@casty/mock-node";
import { Message, NobleEd25519Signer } from "@farcaster/core";
import {
  Browser,
  type HTMLElement,
  type HTMLFormElement,
  type HTMLInputElement,
  type HTMLTextAreaElement,
  Window,
} from "happy-dom";
import { hexToBytes } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sawMentions } from "../../src/cli/refs.js";
import { nodeClient } from "../../src/node/http.js";
import { buildCast } from "../../src/protocol/messages.js";
import { startMock } from "../mock.js";
import { setupWeb, TOKEN } from "./setup.js";
import { signAsWallet, wallet } from "./wallet.js";

// The page as a browser loads it: index.html over HTTP, then app.js as a module, against a real
// casty web on a mock node. happy-dom runs the script; it only runs code this repository serves.
const THEME_JS = readFileSync(join(import.meta.dirname, "../../src/web/assets/theme.js"));
const browsers: Browser[] = [];
afterEach(async () => {
  // A reload still on its way would land in a closed page; each page finishes first.
  await Promise.all(
    browsers.splice(0).map(async (browser) => {
      await Promise.all(browser.defaultContext.pages.map((page) => page.waitUntilComplete()));
      await browser.close();
    }),
  );
});

async function open(url: string, hash = `#token=${TOKEN}`) {
  // Answers held back on their way to the page, by path: the server has answered, the page has
  // not seen it yet.
  const gates = new Map<string, { arrived: () => void; released: Promise<void> }>();
  const browser = new Browser({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      // waitUntilComplete waits for every timer, so timers run at once: the toast hides without
      // its few seconds, and the poll for new mentions runs once, before there is a session.
      timer: { maxTimeout: 0, maxIntervalTime: 0, maxIntervalIterations: 0 },
      fetch: {
        interceptor: {
          // happy-dom fetches a classic <script src> synchronously, which would wait forever on
          // a server running in this same process; theme.js comes from disk instead.
          beforeSyncRequest: ({ request, window }) =>
            new URL(request.url).pathname === "/theme.js"
              ? {
                  status: 200,
                  statusText: "OK",
                  ok: true,
                  url: request.url,
                  redirected: false,
                  headers: new window.Headers({ "content-type": "text/javascript" }),
                  body: THEME_JS,
                }
              : undefined,
          afterAsyncResponse: async ({ request }) => {
            const path = new URL(request.url).pathname;
            const gate = gates.get(path);
            if (!gate) return;
            gates.delete(path);
            gate.arrived();
            await gate.released;
          },
        },
      },
    },
  });
  browsers.push(browser);
  const page = browser.newPage();
  await page.goto(`${url}/${hash}`);
  await page.waitUntilComplete();
  const window = page.mainFrame.window;
  const $ = (selector: string) => window.document.querySelector(selector) as HTMLElement;
  const casts = () => [...window.document.querySelectorAll("#feed > li.cast")] as HTMLElement[];
  /** Holds back the next answer to `path`: `arrived` once the server has sent it, then `release`. */
  const hold = (path: string) => {
    let arrived = () => {};
    let release = () => {};
    const sent = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    gates.set(path, { arrived: () => arrived(), released: new Promise((r) => (release = r)) });
    return { arrived: sent, release: () => release() };
  };
  /** Lets every request and timer the page has started finish. */
  const settle = () => page.waitUntilComplete();
  return { window, $, casts, hold, settle };
}

const pressed = (cast: HTMLElement | undefined, button: string) =>
  cast?.querySelector(button)?.getAttribute("aria-pressed");

describe("the page", () => {
  it("reads the casts afresh on a page load, but takes the follow list from the cache", async () => {
    const { web } = await setupWeb();
    const first = await open(web.url);
    await vi.waitFor(() => expect(first.casts().length).toBeGreaterThan(0));
    const paths: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      paths.push(new URL(String(input)).pathname);
      return real(input, init);
    };
    try {
      const second = await open(web.url);
      await vi.waitFor(() => expect(second.casts().length).toBeGreaterThan(0));
    } finally {
      globalThis.fetch = real;
    }
    expect(paths).toContain("/v1/castsByFid");
    expect(paths).not.toContain("/v1/linksByFid");
  });

  it("takes the token from the link, keeps it, and drops it from the address bar", async () => {
    const { web } = await setupWeb();
    const { window, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    expect(JSON.parse(window.localStorage.getItem("casty.token") ?? "")).toBe(TOKEN);
    expect(window.location.hash).toBe("");
  });

  it("pairs when the link is opened in a tab that already shows the page", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url, "");
    await vi.waitFor(() => expect($("#pair").hidden).toBe(false));
    window.location.hash = `#token=${TOKEN}`;
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    expect($("#pair").hidden).toBe(true);
    expect(window.location.hash).toBe("");
  });

  it("says so when its token is not accepted, and offers nothing it cannot do", async () => {
    const { web } = await setupWeb();
    const { $ } = await open(web.url, `#token=${"x".repeat(43)}`);
    await vi.waitFor(() => expect($("#pair").hidden).toBe(false));
    expect($("#pair-note").hidden).toBe(false);
    expect($("#prompt").hidden).toBe(true);
    expect($("#refresh").hidden).toBe(true);
  });

  it("puts a stranger's markup in as text and links only http(s)", async () => {
    const { web, api } = await setupWeb();
    const text = '<img src=x onerror="pwned()"> javascript:alert(1) https://example.com/a';
    await api("/api/cast", { text });
    const { window, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    expect(casts()[0]?.querySelector(".text")?.textContent).toBe(
      '<img src=x onerror="pwned()"> javascript:alert(1) example.com/a',
    );
    expect(window.document.querySelector("#feed img")).toBeNull();
    const links = [...window.document.querySelectorAll("#feed a[target]")];
    expect(links.length).toBeGreaterThan(1);
    for (const a of links) expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
  });

  it("shows a like made in a thread in the feed too", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const first = casts()[0];
    first?.querySelector<HTMLElement>(".text")?.click();
    await vi.waitFor(() => expect($("#thread-list .cast.focus")).not.toBeNull());
    const like = $("#thread-list .cast.focus .like");
    like.click();
    await vi.waitFor(() => expect(like.classList.contains("busy")).toBe(false));
    expect(pressed(first, ".like")).toBe("true");
  });

  it("starts a reply with an empty box, not the draft of another cast", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(1));
    $("#prompt").click();
    ($("#text") as HTMLTextAreaElement).value = "a new cast, not a reply";
    $("#compose-close").click();
    casts()[1]?.querySelector<HTMLElement>(".reply")?.click();
    expect(($("#text") as HTMLTextAreaElement).value).toBe("");
  });

  it("cycles the theme auto, light, dark, and keeps the choice for the next visit", async () => {
    const { web } = await setupWeb();
    const { window, $ } = await open(web.url);
    const root = window.document.documentElement;
    expect($("#theme").textContent).toBe("auto");
    expect(root.dataset.theme).toBeUndefined();
    $("#theme").click();
    expect([$("#theme").textContent, root.dataset.theme]).toEqual(["light", "light"]);
    $("#theme").click();
    expect([$("#theme").textContent, root.dataset.theme]).toEqual(["dark", "dark"]);
    $("#theme").click();
    expect([$("#theme").textContent, root.dataset.theme]).toEqual(["auto", undefined]);
    expect(window.localStorage.getItem("casty.theme")).toBe('"auto"');
  });

  it("puts a saved theme on the page before it paints", () => {
    for (const [stored, expected] of [
      ['"dark"', "dark"],
      ['"light"', "light"],
      ['"auto"', undefined],
      ["not json", undefined],
    ] as const) {
      const window = new Window({
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
        },
      });
      window.localStorage.setItem("casty.theme", stored);
      window.eval(THEME_JS.toString("utf8"));
      expect(window.document.documentElement.dataset.theme, stored).toBe(expected);
      window.close();
    }
  });

  it("numbers the feed as casty feed does, and saves the order for the terminal", async () => {
    const { web, dir } = await setupWeb();
    const { casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(2));
    expect(
      casts()
        .map((c) => c.querySelector(".num")?.textContent)
        .slice(0, 3),
    ).toEqual(["1", "2", "3"]);
    expect(existsSync(join(dir, "last-feed.json"))).toBe(true);
  });

  it("opens a profile from an author, and unfollows from there", async () => {
    const { web, api } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const other = casts().find(
      (c) => !c.querySelector(".author")?.textContent?.includes("casty-test"),
    );
    const author = other?.querySelector<HTMLElement>(".author");
    author?.click();
    window.location.hash = author?.getAttribute("href") ?? "";
    await vi.waitFor(() => expect($("#profile-follow").textContent).toBe("following"));
    expect($("#profile-name").textContent).toBe(author?.textContent);
    $("#profile-follow").click();
    await vi.waitFor(() => expect($("#profile-follow").classList.contains("busy")).toBe(false));
    const fid = Number(author?.getAttribute("href")?.split("/").pop());
    expect((await api(`/api/profile?fid=${fid}`)).body.following).toBe(false);
  });

  it("heads a profile with its display name, then its @name and bio", async () => {
    const { web, node } = await setupWeb();
    const [username] = node.state.userdata.filter((m) => m.data.fid === FIRST_AUTHOR);
    for (const [type, value] of [
      ["USER_DATA_TYPE_DISPLAY", "First Author"],
      ["USER_DATA_TYPE_BIO", "builds things.\nlikes trains."],
    ] as const) {
      const message = structuredClone(username);
      if (!message) throw new Error("fixture author has no username");
      message.data.userDataBody = { type, value };
      message.hash = `0x${type.length.toString(16)}${"cd".repeat(19)}`;
      node.state.userdata.push(message);
    }
    const { window, $ } = await open(web.url);
    window.location.hash = `#/fid/${FIRST_AUTHOR}`;
    await vi.waitFor(() => expect($("#profile-name").textContent).toBe("First Author"));
    expect($("#profile-fid").textContent).toBe(`@user-${FIRST_AUTHOR} · fid ${FIRST_AUTHOR}`);
    expect($("#profile-bio").textContent).toBe("builds things.\nlikes trains.");
    expect($("#profile-bio").hidden).toBe(false);
  });

  it("shows your account, keys, storage and node under you", async () => {
    const { web } = await setupWeb();
    const { window, $ } = await open(web.url);
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#you-body .here")).not.toBeNull());
    const titles = [...window.document.querySelectorAll("#you-body h2")].map((h) => h.textContent);
    expect(titles).toEqual([
      "account",
      "app keys",
      "verified addresses",
      "storage",
      "node",
      "in a terminal",
      "this browser",
    ]);
    expect($("#you-name").textContent).toBe("@casty-test");
    // The custody address is short, on the explorer of the chain it lives on, with copy.
    const custody = $("#you-body .addr");
    expect(custody.textContent).toMatch(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4} copy$/);
    expect(custody.querySelector("a")?.getAttribute("href")).toMatch(
      /^https:\/\/optimistic\.etherscan\.io\/address\/0x/,
    );
    // This casty's key names casty and what it may sign in words, and when it lapses.
    const term = $("#you-body .here").closest("dt");
    expect(term?.textContent).toMatch(/^0x[0-9a-f]{8}…[0-9a-f]{4}signs here$/);
    const ours = term?.nextElementSibling?.textContent ?? "";
    expect(ours).toMatch(/^casty · casts, reactions, followsgasless, lapses .+ if unused$/);
    // With that key, adding another is one folded line.
    const add = $("#you-body details.add-key") as HTMLElement & { open: boolean };
    expect(add.open).toBe(false);
    expect(add.querySelector("summary")?.textContent).toBe("add another key");
  });

  it("names the wallet before casty init, and revoke --self before the seed phrase", async () => {
    const { web } = await setupWeb();
    const { window, $ } = await open(web.url);
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    const terminal = [...window.document.querySelectorAll("#you-body section")].find(
      (s) => s.querySelector("h2")?.textContent === "in a terminal",
    );
    const terms = [...(terminal?.querySelectorAll("dt") ?? [])].map((t) => t.textContent);
    expect(terms.indexOf("casty key revoke --self")).toBeLessThan(
      terms.indexOf("casty key revoke <key>"),
    );
    const init = terminal?.querySelectorAll("dd")[terms.indexOf("casty init")]?.textContent ?? "";
    expect(init.indexOf("add a key with your wallet")).toBeGreaterThanOrEqual(0);
    expect(init.indexOf("add a key with your wallet")).toBeLessThan(init.indexOf("seed phrase"));
    const title = $("#add-key").getAttribute("title") ?? "";
    expect(title.indexOf("wallet")).toBeLessThan(title.indexOf("casty init"));
  });

  it("finds an account by @name and opens its profile", async () => {
    const { web, api } = await setupWeb();
    const { name, fid } = await (async () => {
      const [cast] = (await api("/api/feed?limit=5")).body.items.filter(
        (c: { author: string }) => c.author !== "casty-test",
      );
      return { name: cast.author as string, fid: cast.fid as number };
    })();
    const { window, $ } = await open(web.url);
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#you").hidden).toBe(false));
    ($("#find-input") as HTMLInputElement).value = `@${name}`;
    ($("#find") as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(window.location.hash).toBe(`#/fid/${fid}`));
  });

  it("casts in a channel with a link from the compose box", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    $("#prompt").click();
    const text = "in a channel, with a link";
    ($("#text") as HTMLTextAreaElement).value = text;
    $("#text").dispatchEvent(new window.Event("input"));
    ($("#channel-input") as HTMLInputElement).value = "https://example.com/~/channel/casty";
    $("#add-link").click();
    ($("#links input") as HTMLInputElement).value = "https://example.com/read";
    ($("#compose-form") as HTMLFormElement).requestSubmit();
    const sent = () => node.state.casts.find((c) => c.data.castAddBody?.text === text);
    await vi.waitFor(() => expect(sent()).toBeDefined());
    expect(sent()?.data.castAddBody?.parentUrl).toBe("https://example.com/~/channel/casty");
    expect(sent()?.data.castAddBody?.embeds.map((e) => e.url)).toEqual([
      "https://example.com/read",
    ]);
    await vi.waitFor(() => expect($("#compose").hasAttribute("open")).toBe(false));
  });

  it("says which @names went out as text, since nobody holds them", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    $("#prompt").click();
    ($("#text") as HTMLTextAreaElement).value = "hello @nobody-here";
    $("#text").dispatchEvent(new window.Event("input"));
    ($("#compose-form") as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("@nobody-here"));
  });

  it("shows one channel when its name is tapped, and all again from the filter", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().some((c) => c.querySelector(".chan"))).toBe(true));
    casts()
      .find((c) => c.querySelector(".chan"))
      ?.querySelector<HTMLElement>(".chan")
      ?.click();
    await vi.waitFor(() => expect($("#channel").hidden).toBe(false));
    await vi.waitFor(() =>
      expect(casts().length > 0 && casts().every((c) => c.querySelector(".chan"))).toBe(true),
    );
    $("#channel").click();
    await vi.waitFor(() => expect($("#channel").hidden).toBe(true));
  });

  it("names a channel /name when its url says so, and by its url otherwise", async () => {
    const { web, api } = await setupWeb();
    const url = "chain://eip155:1/erc721:0x0000000000000000000000000000000000000001";
    expect((await api("/api/cast", { text: "an old channel", channel: url })).status).toBe(200);
    const { casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const labels = casts().flatMap((c) =>
      [...c.querySelectorAll(".chan")].map((b) => b.textContent),
    );
    expect(labels).toContain(url);
    expect(labels).toContain("/casty");
  });

  it("offers the channel the feed shows as the new cast's channel", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().some((c) => c.querySelector(".chan"))).toBe(true));
    casts()
      .find((c) => c.querySelector(".chan"))
      ?.querySelector<HTMLElement>(".chan")
      ?.click();
    await vi.waitFor(() => expect($("#channel").hidden).toBe(false));
    $("#prompt").click();
    expect(($("#channel-input") as HTMLInputElement).value).toBe(
      "https://example.com/~/channel/casty",
    );
  });

  it("leaves Enter on a link inside a cast to the link", async () => {
    const { web } = await setupWeb();
    const { window, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const author = casts()[0]?.querySelector(".author") as HTMLElement;
    author.focus();
    author.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(window.location.hash.startsWith("#/cast/")).toBe(false);
  });

  it("does not like on l when the page is read-only", async () => {
    const { web, node } = await setupWeb({ write: false });
    const { window, $, casts, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const before = node.state.reactions.length;
    const first = casts()[0] as HTMLElement;
    first.focus();
    first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "l", bubbles: true }));
    await settle();
    expect($("#toast").classList.contains("show")).toBe(false);
    expect(node.state.reactions.length).toBe(before);
  });

  it("offers + link again when a new draft starts", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(1));
    $("#prompt").click();
    $("#add-link").click();
    $("#add-link").click();
    expect($("#add-link").hidden).toBe(true);
    $("#compose-close").click();
    casts()[1]?.querySelector<HTMLElement>(".reply")?.click();
    expect($("#add-link").hidden).toBe(false);
  });

  it("says why pairing failed when the token is fine but the node is not", async () => {
    const { web, node } = await setupWeb();
    const { $ } = await open(web.url, "");
    await vi.waitFor(() => expect($("#pair").hidden).toBe(false));
    await node.close();
    ($("#pair-input") as HTMLInputElement).value = TOKEN;
    ($("#pair-form") as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("cannot reach the node"));
  });

  it("shows what others said to you under mentions", async () => {
    const { web } = await setupWeb();
    const { window, $ } = await open(web.url);
    window.location.hash = "#/mentions";
    await vi.waitFor(() => expect($("#mentions-list .num")?.textContent).toBe("1"));
    expect($("#tab-mentions").getAttribute("aria-current")).toBe("page");
  });

  it("marks the mentions tab with how many are new until they are shown", async () => {
    const { web, dir } = await setupWeb();
    sawMentions(dir, ME_FID, []);
    const { window, $ } = await open(web.url);
    await vi.waitFor(() => expect($("#mentions-badge").hidden).toBe(false));
    expect($("#tab-mentions").getAttribute("aria-label")).toMatch(/^mentions, \d+ new$/);
    expect(window.document.title).toMatch(/^\(\d+\+?\) casty$/);
    window.location.hash = "#/mentions";
    await vi.waitFor(() => expect($("#mentions-badge").hidden).toBe(true));
    expect($("#tab-mentions").hasAttribute("aria-label")).toBe(false);
    expect(window.document.title).toBe("casty");
  });

  it("does not bring back a count of mentions that were shown while it was asked for", async () => {
    const { web, dir } = await setupWeb();
    sawMentions(dir, ME_FID, []);
    const { window, $, hold, settle } = await open(web.url);
    await vi.waitFor(() => expect($("#mentions-badge").hidden).toBe(false));
    const unseen = hold("/api/unseen");
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await unseen.arrived;
    window.location.hash = "#/mentions";
    await vi.waitFor(() => expect($("#mentions-badge").hidden).toBe(true));
    window.location.hash = "#/";
    await vi.waitFor(() => expect($("#mentions").hidden).toBe(true));
    unseen.release();
    await settle();
    expect($("#mentions-badge").hidden).toBe(true);
  });

  it("turns the node dot back from down once a request gets through", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const port = Number(new URL(node.url).port);
    await node.close();
    $("#refresh").click();
    await vi.waitFor(() => expect($("#dot").classList.contains("down")).toBe(true));
    await startMock({ port });
    window.location.hash = "#/mentions";
    await vi.waitFor(() => expect($("#dot").classList.contains("ok")).toBe(true));
  });

  it("says casty web cannot be reached when it is gone, not the browser's fetch error", async () => {
    const { web } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    await web.close();
    $("#refresh").click();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("cannot reach casty web"));
  });

  it("does not let an older read of your account that failed replace a newer one", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts, hold, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    node.control({ failReads: 1000 });
    const me = hold("/api/me");
    window.location.hash = "#/you";
    await me.arrived;
    node.control({ failReads: 0 });
    $("#refresh").click();
    await vi.waitFor(() => expect($("#you-body h2")).not.toBeNull());
    me.release();
    await settle();
    expect($("#you-body h2")).not.toBeNull();
  });

  it("puts focus back on the cast it left, after mentions renumbered the feed", async () => {
    const { web } = await setupWeb();
    const { window, casts, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(1));
    const key = casts()[1]?.dataset.cast;
    casts()[1]?.focus();
    window.location.hash = "#/mentions";
    await vi.waitFor(() =>
      expect(window.document.querySelectorAll("#mentions-list > li.cast").length).toBeGreaterThan(
        0,
      ),
    );
    window.location.hash = "#/";
    await settle();
    expect(window.document.activeElement?.getAttribute("data-cast")).toBe(key);
  });

  it("names each cast for a screen reader by its author, age and text", async () => {
    const { web } = await setupWeb();
    const { casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const first = casts()[0] as HTMLElement;
    const text = first.querySelector(".text")?.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(first.getAttribute("aria-label")).toContain(text);
  });

  it("sets the theme from you as well, for a phone without the word in the bar", async () => {
    const { web } = await setupWeb();
    const { window, $ } = await open(web.url);
    window.location.hash = "#/you";
    await vi.waitFor(() =>
      expect(window.document.querySelector("#you-body .themes")).not.toBeNull(),
    );
    const dark = window.document.querySelector(
      '#you-body .themes [data-theme="dark"]',
    ) as HTMLElement;
    dark.click();
    expect(window.document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect($("#theme").textContent).toBe("dark");
  });

  it("refreshes the feed when its tab is tapped again, as phone apps do", async () => {
    const { web, api } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    await api("/api/cast", { text: "posted from somewhere else" });
    $("#tab-feed").click();
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("posted from somewhere else"),
    );
  });

  it("gives the feed its numbers back for the terminal when you return to it", async () => {
    const { web, dir, api } = await setupWeb();
    // Your own cast tops the feed and is never among your mentions.
    await api("/api/cast", { text: "mine, first in the feed" });
    const { window, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const first = casts()[0]?.dataset.cast;
    window.location.hash = "#/mentions";
    await vi.waitFor(() =>
      expect(window.document.querySelectorAll("#mentions-list > li.cast").length).toBeGreaterThan(
        0,
      ),
    );
    window.location.hash = "#/";
    await vi.waitFor(() => {
      const [saved] = JSON.parse(readFileSync(join(dir, "last-feed.json"), "utf8"));
      expect(`${saved.fid}:${saved.hash}`).toBe(first);
    });
  });

  it("shows a reply made elsewhere when the mentions tab is tapped again", async () => {
    const { web, api, node } = await setupWeb();
    const mine = (await api("/api/cast", { text: "anyone?" })).body;
    const { window, $ } = await open(web.url);
    window.location.hash = "#/mentions";
    const texts = () =>
      [...window.document.querySelectorAll("#mentions-list .text")].map((t) => t.textContent);
    await vi.waitFor(() => expect(texts().length).toBeGreaterThan(0));
    const reply = await buildCast(
      FIRST_AUTHOR,
      { text: "a reply from elsewhere", parent: { fid: mine.fid, hash: hexToBytes(mine.hash) } },
      new NobleEd25519Signer(fixtureKey(42, FIRST_AUTHOR)),
    );
    await nodeClient(node.url).submitMessage(Message.encode(reply).finish());
    $("#tab-mentions").click();
    await vi.waitFor(() => expect(texts()).toContain("a reply from elsewhere"));
  });

  it("takes a cast deleted in a thread out of the feed too", async () => {
    const { web, api } = await setupWeb();
    await api("/api/cast", { text: "short-lived" });
    const { window, $, casts } = await open(web.url);
    (window as unknown as { confirm: () => boolean }).confirm = () => true;
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("short-lived"),
    );
    casts()[0]?.querySelector<HTMLElement>(".text")?.click();
    await vi.waitFor(() => expect($("#thread-list .cast.focus")).not.toBeNull());
    $("#thread-list .cast.focus .delete").click();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    await vi.waitFor(() =>
      expect(casts().map((c) => c.querySelector(".text")?.textContent)).not.toContain(
        "short-lived",
      ),
    );
  });

  it("keeps the feed on screen when a refresh fails, and says why", async () => {
    const { web, node } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const shown = casts().length;
    await node.close();
    $("#refresh").click();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("cannot reach the node"));
    expect(casts().length).toBe(shown);
  });

  it("keeps a like that is on its way when the feed is drawn again", async () => {
    const { web, node } = await setupWeb();
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    node.control({ mergeDelayMs: 600 });
    const first = casts()[0] as HTMLElement;
    const key = first.dataset.cast;
    (first.querySelector(".like") as HTMLElement).click();
    $("#replies").click();
    $("#replies").click();
    await vi.waitFor(() => expect(casts()[0]?.dataset.cast).toBe(key));
    const like = () =>
      casts()
        .find((c) => c.dataset.cast === key)
        ?.querySelector(".like");
    expect(like()?.getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() => expect(like()?.classList.contains("busy")).toBe(false), {
      timeout: 3000,
    });
    expect(like()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps a like that landed while an older feed was on its way", async () => {
    const { web } = await setupWeb();
    const { $, casts, hold, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const key = casts()[0]?.dataset.cast;
    const like = () =>
      casts()
        .find((c) => c.dataset.cast === key)
        ?.querySelector(".like");
    const feed = hold("/api/feed");
    $("#refresh").click();
    await feed.arrived;
    (like() as HTMLElement).click();
    await vi.waitFor(() => expect(like()?.classList.contains("busy")).toBe(false));
    feed.release();
    await settle();
    expect(like()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not bring back a cast deleted while an older feed was on its way", async () => {
    const { web, api } = await setupWeb();
    await api("/api/cast", { text: "short-lived" });
    const { window, $, casts, hold, settle } = await open(web.url);
    (window as unknown as { confirm: () => boolean }).confirm = () => true;
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("short-lived"),
    );
    const feed = hold("/api/feed");
    $("#refresh").click();
    await feed.arrived;
    casts()[0]?.querySelector<HTMLElement>(".delete")?.click();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("cast deleted"));
    feed.release();
    await settle();
    const shown = casts().filter((c) => !c.hidden);
    expect(shown.map((c) => c.querySelector(".text")?.textContent)).not.toContain("short-lived");
  });

  it("keeps a follow that landed while an older profile was on its way", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts, hold, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const other = casts().find(
      (c) => !c.querySelector(".author")?.textContent?.includes("casty-test"),
    );
    window.location.hash = other?.querySelector(".author")?.getAttribute("href") ?? "";
    await vi.waitFor(() => expect($("#profile-follow").textContent).toBe("following"));
    node.control({ mergeDelayMs: 300 });
    $("#profile-follow").click();
    const profile = hold("/api/profile");
    $("#refresh").click();
    await profile.arrived;
    await vi.waitFor(() => expect($("#toast").textContent).toContain("no longer following"));
    profile.release();
    await settle();
    expect($("#profile-follow").textContent).toBe("follow");
  });

  it("leaves the terminal's numbers to the list numbered last when two answers cross", async () => {
    const { web, dir, api } = await setupWeb();
    // Your own cast tops the feed and is never among your mentions, so the two lists differ at 1.
    await api("/api/cast", { text: "on top" });
    const { window, $, casts, hold, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const feed = hold("/api/feed");
    $("#refresh").click();
    await feed.arrived;
    window.location.hash = "#/mentions";
    await vi.waitFor(() =>
      expect(window.document.querySelectorAll("#mentions-list > li.cast").length).toBeGreaterThan(
        0,
      ),
    );
    feed.release();
    await settle();
    window.location.hash = "#/";
    const first = () => {
      const [ref] = JSON.parse(readFileSync(join(dir, "last-feed.json"), "utf8"));
      return `${ref.fid}:${ref.hash}`;
    };
    await vi.waitFor(() => expect(first()).toBe(casts()[0]?.dataset.cast));
  });

  it("keeps the compose box open while a cast is being sent", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    node.control({ mergeDelayMs: 400 });
    $("#prompt").click();
    ($("#text") as HTMLTextAreaElement).value = "on its way";
    $("#text").dispatchEvent(new window.Event("input"));
    ($("#compose-form") as HTMLFormElement).requestSubmit();
    const cancel = new window.Event("cancel", { cancelable: true });
    $("#compose").dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect($("#compose").hasAttribute("open")).toBe(false), {
      timeout: 3000,
    });
    // The page reloads the feed after a cast; let it land before the browser closes.
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("on its way"),
    );
  });

  it("moves focus to the cast it opens, and back to the one you left", async () => {
    const { web } = await setupWeb();
    const { window, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(1));
    const second = casts()[1] as HTMLElement;
    second.focus();
    second.dispatchEvent(new window.KeyboardEvent("keydown", { key: "o", bubbles: true }));
    await vi.waitFor(() =>
      expect(window.document.activeElement?.classList.contains("focus")).toBe(true),
    );
    window.location.hash = "#/";
    await vi.waitFor(() =>
      expect((window.document.activeElement as HTMLElement | null)?.dataset?.cast).toBe(
        second.dataset.cast,
      ),
    );
  });

  it("ignores a held key, and closes an open menu on Esc", async () => {
    const { web, node } = await setupWeb();
    const { window, casts, settle } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const first = casts()[0] as HTMLElement;
    first.focus();
    const before = node.state.reactions.length;
    first.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "l", bubbles: true, repeat: true }),
    );
    await settle();
    expect(node.state.reactions.length).toBe(before);
    const menu = first.querySelector("details.menu") as HTMLElement & { open: boolean };
    menu.open = true;
    first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.open).toBe(false);
  });
});

describe("the page over casty serve", () => {
  it("offers new casts in a pill as the index brings them, and draws them on a tap, not under the reader", async () => {
    const { web, api } = await setupWeb({ index: true });
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const first = casts()[0]?.dataset.cast;
    expect($("#new-casts").hidden).toBe(true);
    await api("/api/cast", { text: "landed while you were reading" });
    // The check for new casts runs when the page comes back into view, and every half minute.
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await vi.waitFor(() => expect($("#new-casts").hidden).toBe(false));
    expect($("#new-casts").textContent).toBe("1 new cast");
    expect(casts()[0]?.dataset.cast).toBe(first);
    $("#new-casts").click();
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("landed while you were reading"),
    );
    expect($("#new-casts").hidden).toBe(true);
  });

  it("shows no pill without the index, where a check would cost a fan-out", async () => {
    const { web, api } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    await api("/api/cast", { text: "unseen until a refresh" });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 100));
    expect($("#new-casts").hidden).toBe(true);
  });

  it("warns under the notice when this casty's app key lapses within a week", async () => {
    const { web, node } = await setupWeb();
    const mine = node.state.signers.get(ME_FID)?.signers.find((s) => s.ttl);
    if (!mine) throw new Error("init added no key");
    mine.expiresAt = Math.floor(Date.now() / 1000) + 2 * 86_400;
    const { $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect($("#notice").hidden).toBe(false));
    expect($("#notice").textContent).toContain("app key lapses in 2 days");
  });
});

describe("the compose box", () => {
  it("keeps a draft across a reload, and drops it once the cast is sent", async () => {
    const { web, node } = await setupWeb();
    const first = await open(web.url);
    await vi.waitFor(() => expect(first.casts().length).toBeGreaterThan(0));
    first.$("#prompt").click();
    (first.$("#text") as HTMLTextAreaElement).value = "half a thought";
    first.$("#text").dispatchEvent(new first.window.Event("input"));
    first.$("#compose-close").click();
    const kept = first.window.localStorage.getItem("casty.drafts");
    expect(kept).toContain("half a thought");
    // Another visit: happy-dom gives each browser its own storage, so the draft is carried over
    // by hand, as the browser would carry it.
    const again = await open(web.url);
    await vi.waitFor(() => expect(again.casts().length).toBeGreaterThan(0));
    again.window.localStorage.setItem("casty.drafts", kept as string);
    again.$("#prompt").click();
    expect((again.$("#text") as HTMLTextAreaElement).value).toBe("half a thought");
    (again.$("#compose-form") as HTMLFormElement).requestSubmit();
    await vi.waitFor(() =>
      expect(node.state.casts.some((c) => c.data.castAddBody?.text === "half a thought")).toBe(
        true,
      ),
    );
    await vi.waitFor(() => expect(again.$("#compose").hasAttribute("open")).toBe(false));
    expect(again.window.localStorage.getItem("casty.drafts")).not.toContain("half a thought");
  });

  it("keeps a reply's draft apart from a new cast's", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(1));
    casts()[1]?.querySelector<HTMLElement>(".reply")?.click();
    ($("#text") as HTMLTextAreaElement).value = "a reply in progress";
    $("#text").dispatchEvent(new window.Event("input"));
    $("#compose-close").click();
    $("#prompt").click();
    expect(($("#text") as HTMLTextAreaElement).value).toBe("");
    $("#compose-close").click();
    casts()[1]?.querySelector<HTMLElement>(".reply")?.click();
    expect(($("#text") as HTMLTextAreaElement).value).toBe("a reply in progress");
  });
});

describe("on a phone", () => {
  it("refreshes the feed when it is pulled down from the top", async () => {
    const { web, api } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    await api("/api/cast", { text: "pulled in" });
    const touch = (type: string, y: number) =>
      window.document.dispatchEvent(
        Object.assign(new window.Event(type, { bubbles: true }), { touches: [{ clientY: y }] }),
      );
    touch("touchstart", 10);
    touch("touchmove", 150);
    expect($("#pull").hidden).toBe(false);
    touch("touchend", 150);
    await vi.waitFor(() =>
      expect(casts()[0]?.querySelector(".text")?.textContent).toBe("pulled in"),
    );
    expect($("#pull").hidden).toBe(true);
  });
});

describe("keys and wallets", () => {
  it("adds an app key with the wallet in the browser, from you", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const asked: string[] = [];
    // A wallet in the browser, as an extension or a wallet's own browser injects it.
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        asked.push(method);
        if (method === "eth_requestAccounts") return [wallet.address];
        if (method === "eth_signTypedData_v4")
          return signAsWallet(JSON.parse(params?.[1] as string));
        throw new Error(`unexpected ${method}`);
      },
    };
    const before = node.state.signers.get(ME_FID)?.signers.length ?? 0;
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    $("#add-key").click();
    await vi.waitFor(() => expect(node.state.signers.get(ME_FID)?.signers.length).toBe(before + 1));
    await vi.waitFor(() => expect($("#toast").textContent).toContain("app key added"));
    expect(asked).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "eth_signTypedData_v4",
      "eth_signTypedData_v4",
    ]);
  });

  it("says where a wallet comes from when the browser has none", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    $("#add-key").click();
    await vi.waitFor(() => expect($("#toast").textContent).toContain("no wallet in this browser"));
  });

  it("shows an account's verified addresses on its profile, with copy", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    window.location.hash = `#/fid/${FIRST_AUTHOR}`;
    await vi.waitFor(() => expect($("#profile-verified").hidden).toBe(false));
    expect($("#profile-verified").textContent).toMatch(/verified: 0x[0-9a-f]{4}…[0-9a-f]{4}/);
    expect($("#profile-verified button")).not.toBeNull();
    window.location.hash = `#/fid/${FIRST_AUTHOR + 1}`;
    await vi.waitFor(() =>
      expect($("#profile-name").textContent).toContain(String(FIRST_AUTHOR + 1)),
    );
    expect($("#profile-verified").hidden).toBe(true);
  });
});

describe("the wallet in the browser, whichever way it is there", () => {
  const stubWallet = (accounts: string[]) => {
    const asked: string[] = [];
    let granted = false;
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        asked.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          return granted ? [wallet.address] : accounts;
        }
        if (method === "wallet_requestPermissions") {
          granted = true;
          return [{ parentCapability: "eth_accounts" }];
        }
        if (method === "eth_signTypedData_v4")
          return signAsWallet(JSON.parse(params?.[1] as string));
        throw new Error(`unexpected ${method}`);
      },
    };
    return { provider, asked };
  };

  it("finds a wallet announced over EIP-6963 when window.ethereum is not set", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const { provider, asked } = stubWallet([wallet.address]);
    window.dispatchEvent(
      Object.assign(new window.Event("eip6963:announceProvider"), {
        detail: { info: { name: "Stub Wallet", uuid: "1", rdns: "io.stub" }, provider },
      }),
    );
    const before = node.state.signers.get(ME_FID)?.signers.length ?? 0;
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    $("#add-key").click();
    await vi.waitFor(() => expect(node.state.signers.get(ME_FID)?.signers.length).toBe(before + 1));
    expect(asked[0]).toBe("eth_requestAccounts");
  });

  it("asks the wallet for the right account when the one it offers is not the custody", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    const { provider, asked } = stubWallet([`0x${"11".repeat(20)}`]);
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    const before = node.state.signers.get(ME_FID)?.signers.length ?? 0;
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    $("#add-key").click();
    await vi.waitFor(() => expect(node.state.signers.get(ME_FID)?.signers.length).toBe(before + 1));
    expect(asked).toContain("wallet_requestPermissions");
  });

  it("a link with a token casty web does not know leaves the saved one, and the page, as they were", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    window.location.hash = `#token=${"A".repeat(43)}`;
    await vi.waitFor(() => expect(window.location.hash).toBe(""));
    await vi.waitFor(() => expect($("#pair").hidden).toBe(true));
    expect(JSON.parse(window.localStorage.getItem("casty.token") ?? "null")).toBe(TOKEN);
  });

  it("offers to open the page in a phone wallet's own browser when none is here", async () => {
    const { web } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#wallet-links")).not.toBeNull());
    const links = [...window.document.querySelectorAll("#wallet-links a")] as HTMLElement[];
    const hrefs = links.map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("https://metamask.app.link/dapp/"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://go.cb-w.com/dapp?cb_url="))).toBe(true);
    // The token never goes into a link to a wallet maker's server, which would log it; the
    // wallet's browser is paired by pasting the link this button copies.
    expect(hrefs.some((h) => h.includes(TOKEN))).toBe(false);
    let copied = "";
    Object.defineProperty(window.navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
      configurable: true,
    });
    $("#copy-pairing").click();
    await vi.waitFor(() => expect(copied).toBe(`${window.location.origin}/#token=${TOKEN}`));
  });

  it("links a verified address to its explorer, and lists your own under you", async () => {
    const { web, node } = await setupWeb();
    // Your own fid verified an address too: one of the fixture's, as the mock reads it back.
    const verified = structuredClone(node.state.verifications[0]);
    if (!verified) throw new Error("fixture has no verification");
    verified.data.fid = ME_FID;
    node.state.verifications.push(verified);
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    window.location.hash = `#/fid/${FIRST_AUTHOR}`;
    await vi.waitFor(() => expect($("#profile-verified").hidden).toBe(false));
    const explorer = $("#profile-verified a");
    expect(explorer.getAttribute("href")).toMatch(
      /^https:\/\/etherscan\.io\/address\/0x[0-9a-f]{40}$/,
    );
    expect(explorer.getAttribute("rel")).toContain("noopener");
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#you-body").textContent).toContain("verified addresses"));
    const yours = [...$("#you-body").querySelectorAll("h2")].find(
      (h) => h.textContent === "verified addresses",
    )?.parentElement;
    expect(yours?.querySelector("dd")?.textContent).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4} copy/);
    expect(yours?.querySelector("dd a")?.getAttribute("href")).toMatch(/^https:\/\/etherscan\.io/);
  });
});

describe("the wallet on another chain", () => {
  it("is asked to switch to Ethereum mainnet, which the key domain names, before it signs", async () => {
    const { web, node } = await setupWeb();
    const { window, $, casts } = await open(web.url);
    await vi.waitFor(() => expect(casts().length).toBeGreaterThan(0));
    // MetaMask refuses typed data whose domain.chainId is not the active chain.
    let chain = "0x2105"; // Base
    const asked: string[] = [];
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        asked.push(method);
        if (method === "eth_requestAccounts") return [wallet.address];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = (params as [{ chainId: string }])[0].chainId;
          return null;
        }
        if (method === "eth_signTypedData_v4") {
          const data = JSON.parse(params?.[1] as string);
          if (BigInt(data.domain.chainId) !== BigInt(chain)) {
            throw new Error(
              `Provided chainId "${data.domain.chainId}" must match the active chainId "${Number(chain)}"`,
            );
          }
          return signAsWallet(data);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const before = node.state.signers.get(ME_FID)?.signers.length ?? 0;
    window.location.hash = "#/you";
    await vi.waitFor(() => expect($("#add-key")).not.toBeNull());
    $("#add-key").click();
    await vi.waitFor(() => expect(node.state.signers.get(ME_FID)?.signers.length).toBe(before + 1));
    expect(asked).toContain("wallet_switchEthereumChain");
  });
});
