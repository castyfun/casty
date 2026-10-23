// casty web: the feed, a cast with its replies, profiles, your account and node, and a compose
// box, over the JSON API in src/web/api.ts. Cast text comes from strangers, so it only ever
// enters the page as text nodes, and only http(s) links the server checked become hrefs.

const $ = (id) => document.getElementById(id);
const PAGE = 30;
const THEMES = ["auto", "light", "dark"];
const VIEWS = ["home", "mentions", "thread", "profile", "you"];
/** How often the mentions tab asks how many are new; the server remembers reads for 30 s. */
const UNSEEN_MS = 120_000;
/** How often the feed asks the index for casts newer than the one on top; nothing without it. */
const NEW_MS = 30_000;
/** How far a finger pulls the feed down from the top before letting go refreshes it. */
const PULL_PX = 70;

const saved = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`casty.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`casty.${key}`, JSON.stringify(value));
    } catch {
      // Private windows may refuse storage; the page then forgets settings on reload.
    }
  },
};

const state = {
  token: saved.get("token", ""),
  session: null,
  limit: PAGE,
  replies: saved.get("replies", true),
  hidden: new Set(saved.get("hiddenApps", [])),
  apps: new Set(),
  channel: null,
  channels: new Set(),
  replyTo: null,
  draftFor: "new",
  loadedAt: 0,
  feedScroll: 0,
  profileFid: null,
  /** Which list last saved its numbers for the terminal: "feed" or "mentions", and its turn. */
  numbered: null,
  turn: 0,
  /** Likes and recasts on their way to the node, by "Like:fid:hash", so a redraw keeps them. */
  pending: new Map(),
  /** Likes, recasts and follows that landed, with when, by key ("follow:fid" for a follow). */
  settled: new Map(),
  /** Casts deleted here, by "fid:hash". */
  deleted: new Set(),
  /** The cast that had focus in the feed, focused again on the way back. */
  feedFocus: null,
  sending: false,
};

// --- API -------------------------------------------------------------------------------------

async function api(path, body) {
  const headers = { authorization: `Bearer ${state.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Not the node: casty web itself did not answer (stopped, or this phone left its network).
    throw Object.assign(new Error("cannot reach casty web"), {
      hint: "is it still running, and is this device on its network? Start it again with casty web",
    });
  }
  const data = await res.json().catch(() => ({ error: `the server answered HTTP ${res.status}` }));
  if (res.status === 401) showPairing();
  if (res.status === 502) setDot("down");
  // The node answers again: the session's own read sets the dot from its sync.
  else if (res.ok && path !== "/api/session" && $("dot").classList.contains("down")) checkNode();
  if (!res.ok) throw Object.assign(new Error(data.error), { hint: data.hint, status: res.status });
  return data;
}

// --- small helpers ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(text, hint) {
  const box = $("toast");
  box.replaceChildren(el("span", "", text), ...(hint ? [el("small", "", `hint: ${hint}`)] : []));
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), hint ? 9000 : 3500);
}

const fail = (error) => toast(error.message, error.hint);
const nameOf = (cast) => (cast.author ? `@${cast.author}` : `!${cast.fid}`);
const appKey = (app) => app.name ?? String(app.fid);
const threadHref = (id) => `#/cast/${id.fid}/${id.hash}`;
const profileHref = (fid) => `#/fid/${fid}`;
const shortKey = (key) => `${key.slice(0, 10)}…${key.slice(-4)}`;
/** `/name` for a channel url ending in `/~/channel/name`, the url itself otherwise. */
const channelLabel = (url) => {
  const name = /\/~\/channel\/([^/?#]+)$/.exec(url)?.[1];
  return name ? `/${name}` : url;
};
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** example.com/path..., short enough for a phone. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`.replace(/^\/$/, "");
    const host = u.host.replace(/^www\./, "");
    return rest.length > 28 ? `${host}${rest.slice(0, 27)}...` : `${host}${rest}`;
  } catch {
    return url;
  }
}

function link(url, text) {
  if (!/^https?:\/\//i.test(url)) return document.createTextNode(text);
  const a = el("a", "", text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  return a;
}

// --- theme -----------------------------------------------------------------------------------

function applyTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const button = $("theme");
  button.textContent = theme;
  button.title = theme === "auto" ? "Theme: auto follows the system" : `Theme: ${theme}`;
  button.setAttribute("aria-label", `Theme: ${theme}. Change`);
  for (const choice of document.querySelectorAll(".themes button")) {
    choice.setAttribute("aria-pressed", String(choice.dataset.theme === theme));
  }
  // Both metas follow the page once a theme is chosen; until then they follow the system.
  const color = getComputedStyle(document.body).backgroundColor;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = color;
}

function setTheme(theme) {
  saved.set("theme", theme);
  applyTheme(theme);
}

/** auto, light and dark side by side: the same choice as the word in the bar. */
function themeChoices() {
  const current = saved.get("theme", "auto");
  const group = el("span", "themes");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Theme");
  for (const theme of THEMES) {
    const choice = el("button", "toggle", theme);
    choice.type = "button";
    choice.dataset.theme = theme;
    choice.setAttribute("aria-pressed", String(theme === current));
    choice.addEventListener("click", () => setTheme(theme));
    group.append(choice);
  }
  return group;
}

/** The key casty serve signs pushes with, as pushManager.subscribe takes it. */
function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/**
 * Push notifications for mentions and replies, from casty serve: a toggle, or why this browser
 * cannot. The subscription lives in the browser; the server keeps a copy to send to.
 */
function notifyControl() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "not in this browser; on an iPhone, add the page to the home screen first";
  }
  const button = el("button", "toggle", "...");
  button.type = "button";
  const draw = (subscription) => {
    button.textContent = subscription ? "on" : "off";
    button.setAttribute("aria-pressed", String(Boolean(subscription)));
  };
  const registration = navigator.serviceWorker.register("/sw.js");
  registration
    .then((reg) => reg.pushManager.getSubscription())
    .then(draw)
    .catch(() => draw(null));
  button.addEventListener("click", async () => {
    try {
      const reg = await registration;
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await api("/api/push/unsubscribe", { endpoint: current.endpoint });
        await current.unsubscribe();
        draw(null);
        toast("notifications off");
        return;
      }
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(state.session.push),
      });
      try {
        await api("/api/push/subscribe", subscription.toJSON());
      } catch (error) {
        // The browser would stay subscribed to a service that never sends: undone.
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }
      draw(subscription);
      toast("notifications on: a mention or a reply reaches this device, with the name only");
    } catch (error) {
      toast(error.message, error.hint);
    }
  });
  return button;
}

/**
 * An app key added with the wallet in this browser: the custody address signs the key request
 * and the key add (EIP-712), as casty init has the seed phrase sign them; here the phrase stays
 * in the wallet.
 */
/** Wallets that announce themselves (EIP-6963), so a page with several extensions sees each. */
const wallets = [];
window.addEventListener("eip6963:announceProvider", (event) => {
  if (event.detail?.provider && !wallets.some((w) => w.provider === event.detail.provider)) {
    wallets.push(event.detail);
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
const walletProvider = () => wallets[0]?.provider ?? window.ethereum;

/**
 * Where a phone opens this page inside a wallet's own browser. The links carry the page only:
 * the token would reach the wallet maker's server, which a link to it is, and sit in its logs.
 * The wallet's browser is a fresh one, so it is paired with the link the copy button gives.
 */
function walletLinks() {
  const here = `${location.origin}/`;
  const bare = here.replace(/^https?:\/\//, "");
  const list = el("p", "");
  list.id = "wallet-links";
  const apps = [
    ["MetaMask", `https://metamask.app.link/dapp/${bare}`],
    ["Coinbase Wallet", `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`],
    [
      "Trust Wallet",
      `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}`,
    ],
  ];
  list.append("No wallet in this browser. Open this page in ");
  apps.forEach(([name, href], i) => {
    const a = el("a", "", name);
    a.href = href;
    a.rel = "noopener noreferrer";
    list.append(i ? (i === apps.length - 1 ? " or " : ", ") : "", a);
  });
  list.append(" and pair it there with this link, or add a wallet extension.");
  const copy = el("button", "outline", "copy pairing link");
  copy.id = "copy-pairing";
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/#token=${state.token}`);
      toast("pairing link copied: paste it on the wallet's page");
    } catch {
      toast("could not copy", "use the link casty web printed when it started");
    }
  });
  const wrap = el("div", "");
  wrap.append(list, copy);
  return wrap;
}

/**
 * Adding a key with the wallet. With a key of this casty's on the node it folds away under one
 * line: the page can write already, and the wallet steps would only crowd the keys above.
 */
function addKeyControl(custody, haveKey) {
  const panel = el(haveKey ? "details" : "div", "add-key");
  if (haveKey) panel.append(el("summary", "", "add another key"));
  const button = el("button", "outline", "add a key with your wallet");
  button.id = "add-key";
  button.type = "button";
  button.title = `A wallet holding ${custody} signs two requests; no seed phrase is typed. Without a wallet: casty init in a terminal`;
  button.addEventListener("click", () => addKeyWithWallet(button));
  const how = el("p", "");
  how.append(
    "Your wallet signs two requests as ",
    el("span", "addr", shortAddress(custody)),
    ". No seed phrase, no gas.",
  );
  panel.append(button, how);
  if (!walletProvider()) panel.append(walletLinks());
  return panel;
}

const SCOPE_WORDS = { cast: "casts", reaction: "reactions", link: "follows", all: "everything" };
const dayDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** One app key: what signs with it and what it may sign, then whether and when it lapses. */
function keyRow(k, fid) {
  const app = k.ours
    ? "casty"
    : k.requestFid === fid
      ? "own key"
      : (k.app ?? `fid ${k.requestFid}`);
  const scopes = k.scopes
    .split(", ")
    .map((s) => SCOPE_WORDS[s] ?? s.replaceAll("_", " "))
    .join(", ");
  const what = el("span", "", `${app} · ${scopes}`);
  const life = el(
    "span",
    "sub",
    k.expiresAt
      ? `gasless, lapses ${dayDate.format(new Date(k.expiresAt))} if unused`
      : "onchain, does not lapse",
  );
  const key = el("span", "", shortKey(k.key));
  key.title = k.key;
  if (!k.ours) return [key, what, life];
  const term = el("span");
  term.append(key, el("span", "here", "signs here"));
  return [term, what, life];
}

/** 4h 25m, as far as a shard is behind. */
function span(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** The custody account from the wallet: the one it offers, or the one the user picks. */
async function custodyAccount(wallet, custody) {
  const same = (account) => account?.toLowerCase() === custody.toLowerCase();
  const [first] = await wallet.request({ method: "eth_requestAccounts" });
  if (same(first)) return first;
  // The wallet offered another account: let the user pick the right one, where the wallet
  // allows it (MetaMask and the like take wallet_requestPermissions; others throw).
  toast(
    `the wallet offers ${shortAddress(first ?? "0x")}; pick the account ${shortAddress(custody)}`,
  );
  try {
    await wallet.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch {}
  const picked = (await wallet.request({ method: "eth_accounts" })).find(same);
  if (picked) return picked;
  throw Object.assign(new Error(`the wallet's account is not the custody address ${custody}`), {
    hint: "switch the wallet to the account that holds your fid",
  });
}

/**
 * MetaMask and its kind refuse typed data whose domain names another chain than the active
 * one, so the wallet is asked to switch first; a wallet that cannot is left as it is.
 */
async function onChain(wallet, chainId) {
  const want = `0x${chainId.toString(16)}`;
  try {
    if (BigInt(await wallet.request({ method: "eth_chainId" })) === BigInt(want)) return;
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch {}
}

async function addKeyWithWallet(button) {
  const wallet = walletProvider();
  if (!wallet) {
    return toast(
      "no wallet in this browser",
      "open this page in your wallet's browser, or add a wallet extension; or run casty init in a terminal",
    );
  }
  button.disabled = true;
  try {
    const { id, custody, typedData } = await api("/api/key/start", {});
    const account = await custodyAccount(wallet, custody);
    await onChain(wallet, typedData.request.domain.chainId);
    toast("sign the key request in your wallet, then the key add");
    const sign = (data) =>
      wallet.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(data)] });
    const request = await sign(typedData.request);
    const add = await sign(typedData.add);
    toast("sending the key to your node");
    await api("/api/key/finish", { id, signatures: { request, add } });
    toast("app key added; this page can write with it now");
    await checkNode();
    showYou(true);
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
}

// --- one cast --------------------------------------------------------------------------------

/** A cast's text as it reads, from its segments. */
const textOf = (cast) => cast.segments.map((s) => s.text ?? s.mention ?? s.link).join("");

function castNode(cast, kind = "feed", number) {
  const node = $("cast-tpl").content.firstElementChild.cloneNode(true);
  const q = (selector) => node.querySelector(selector);
  node.classList.add(kind);
  node.dataset.cast = `${cast.fid}:${cast.hash}`;
  // Hidden, not left out, so the numbers stay those the terminal has.
  node.hidden = state.deleted.has(node.dataset.cast);
  // The whole name a screen reader gives the cast as j and k move to it, so it has the text too.
  node.setAttribute("aria-label", `${nameOf(cast)}, ${cast.age} ago: ${textOf(cast)}`);

  const num = q(".num");
  if (number) {
    num.textContent = String(number);
    num.title = `casty like ${number} in a terminal acts on this cast`;
  }

  const author = q(".author");
  author.textContent = nameOf(cast);
  author.href = profileHref(cast.fid);
  const age = q(".age");
  age.href = threadHref(cast);
  const time = q("time");
  time.dateTime = cast.time;
  time.textContent = cast.age;
  time.title = fullDate.format(new Date(cast.time));
  // A key the account asked for itself names no app: "via" its own name would read as a typo.
  const via = cast.ours
    ? "casty"
    : cast.app
      ? cast.app.fid === cast.fid
        ? "own key"
        : appKey(cast.app)
      : null;
  q(".via").textContent = via ? ` \u00b7 via ${via}` : "";

  const context = q(".context");
  if (cast.parent) {
    const parent = el("a", "", cast.parentAuthor ? `@${cast.parentAuthor}` : `!${cast.parent.fid}`);
    parent.href = threadHref(cast.parent);
    context.append("reply to ", parent);
  }
  if (cast.channel) {
    const chan = el("button", "chan", channelLabel(cast.channel));
    chan.type = "button";
    chan.title = `Show only this channel: ${cast.channel}`;
    chan.addEventListener("click", () => setChannel(cast.channel));
    context.append(cast.parent ? " in " : "", chan);
  }
  if (!context.childNodes.length) context.remove();

  const text = q(".text");
  for (const segment of cast.segments) {
    if ("link" in segment) text.append(link(segment.link, shortUrl(segment.link)));
    else if ("mention" in segment) {
      const mention = el("a", "mention", segment.mention);
      mention.href = profileHref(segment.fid);
      text.append(mention);
    } else text.append(segment.text);
  }
  if (!cast.segments.length) text.remove();

  const embeds = q(".embeds");
  for (const url of cast.embeds) {
    const item = el("li");
    item.append(link(url, shortUrl(url)));
    embeds.append(item);
  }
  if (!cast.embeds.length) embeds.remove();

  wireActions(node, cast);
  node.addEventListener("click", (event) => {
    if (kind === "focus" || event.target.closest("a, button, details, summary")) return;
    if (String(getSelection())) return;
    location.hash = threadHref(cast);
  });
  return node;
}

function wireActions(node, cast) {
  const q = (selector) => node.querySelector(selector);
  q(".reply").addEventListener("click", () => openCompose(cast));
  pressable(q(".like"), cast, "Like", "liked", "like");
  pressable(q(".recast"), cast, "Recast", "recast", "recast");

  const open = q(".open-link");
  const copy = q(".copy");
  if (cast.url) {
    open.href = cast.url;
    copy.addEventListener("click", () => copyLink(cast.url));
  } else {
    open.remove();
    copy.remove();
  }

  const hide = q(".hide-app");
  if (cast.app && !cast.ours) {
    hide.textContent = `hide casts via ${appKey(cast.app)}`;
    hide.addEventListener("click", () => setAppShown(appKey(cast.app), false));
  } else {
    hide.remove();
  }

  const remove = q(".delete");
  if (cast.fid === state.session?.fid && state.session?.canWrite) {
    remove.addEventListener("click", () => deleteCast(node, cast));
  } else {
    remove.remove();
  }
}

/**
 * Like and recast: shown pressed at once, sent, and put back if the node does not take it. The
 * same cast can be on screen twice, in the feed and in a thread, and can be drawn again while
 * its like is on its way: every copy shows the state on its way, and is busy until it lands.
 */
/**
 * What a like, recast or follow that landed in the last 30 s left, if any: a list that was on
 * its way when it landed was read before it, and would show the state before it.
 */
function settled(key) {
  const entry = state.settled.get(key);
  return entry && Date.now() - entry.at < 30_000 ? entry.on : undefined;
}

function pressable(button, cast, reaction, field, name) {
  const key = `${reaction}:${cast.fid}:${cast.hash}`;
  const copies = () =>
    document.querySelectorAll(`li[data-cast="${cast.fid}:${cast.hash}"] .${name}`);
  const show = (on, busy) => {
    for (const copy of copies()) {
      copy.setAttribute("aria-pressed", String(on));
      copy.classList.toggle("busy", busy);
    }
  };
  const pending = state.pending.get(key);
  button.setAttribute("aria-pressed", String(pending ?? settled(key) ?? cast[field]));
  button.classList.toggle("busy", pending !== undefined);
  button.addEventListener("click", async () => {
    if (state.pending.has(key)) return;
    const was = button.getAttribute("aria-pressed") === "true";
    state.pending.set(key, !was);
    show(!was, true);
    try {
      await api("/api/react", { reaction, undo: was, target: { fid: cast.fid, hash: cast.hash } });
      state.settled.set(key, { on: !was, at: Date.now() });
      state.pending.delete(key);
      show(!was, false);
    } catch (error) {
      state.pending.delete(key);
      show(was, false);
      fail(error);
    }
  });
}

async function copyText(text, what = "link") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    // The clipboard needs https or localhost; over a LAN address the text is shown instead.
    window.prompt(`Copy the ${what}`, text);
  }
}
const copyLink = (url) => copyText(url, "link");

/** 0x1234…abcd, as an address is shown where there is no room for all of it. */
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const EXPLORERS = {
  ethereum: (address) => `https://etherscan.io/address/${address}`,
  solana: (address) => `https://solscan.io/account/${address}`,
};

/** An address, short, linked to its explorer (opened only when tapped), and copy. */
function addressNode(address, kind, explorer) {
  const text = link(explorer ?? address, shortAddress(address));
  if (text instanceof Element) text.title = `${kind}: ${address}`;
  const copy = el("button", "word", "copy");
  copy.type = "button";
  copy.title = `Copy the ${kind} address ${address}`;
  copy.addEventListener("click", () => copyText(address, `${kind} address`));
  // One unit, so a narrow screen breaks between addresses and not between one and its copy.
  const pair = el("span", "addr");
  pair.append(text, " ", copy);
  return pair;
}

const verifiedNode = (v) => addressNode(v.address, v.protocol, EXPLORERS[v.protocol]?.(v.address));

function verifiedNodes(verifications) {
  return verifications.flatMap((v, i) => [...(i ? [" · "] : []), verifiedNode(v)]);
}

async function deleteCast(node, cast) {
  if (!window.confirm("Delete this cast? Everyone stops seeing it once your node relays this.")) {
    return;
  }
  node.classList.add("pending");
  try {
    await api("/api/delete", { target: { fid: cast.fid, hash: cast.hash } });
    state.deleted.add(`${cast.fid}:${cast.hash}`);
    for (const copy of document.querySelectorAll(`li[data-cast="${cast.fid}:${cast.hash}"]`)) {
      copy.remove();
    }
    state.loadedAt = 0;
    toast("cast deleted");
    if (location.hash.includes(cast.hash)) location.hash = "#/";
  } catch (error) {
    node.classList.remove("pending");
    fail(error);
  }
}

// --- lists -----------------------------------------------------------------------------------

/** Each view's newest request: an older answer that arrives late is dropped, not drawn. */
const tickets = {};
function ticket(view) {
  const n = (tickets[view] ?? 0) + 1;
  tickets[view] = n;
  return () => tickets[view] === n;
}

function skeleton(list, count = 4) {
  list.setAttribute("aria-busy", "true");
  list.replaceChildren(
    ...Array.from({ length: count }, () => {
      const item = el("li", "cast skeleton");
      item.append(el("span", "num"), el("div", "line short"), el("div", "line"), el("div", "line"));
      return item;
    }),
  );
}

/** An empty or failed list, worded as the CLI words it: the message, then a hint. */
function message(list, title, hint, retry) {
  const item = el("li", "empty");
  item.append(el("strong", "", title));
  if (hint) item.append(`hint: ${hint}`);
  if (retry) {
    const button = el("button", "outline", "try again");
    button.type = "button";
    button.addEventListener("click", retry);
    item.append(el("br"), button);
  }
  list.replaceChildren(item);
  list.removeAttribute("aria-busy");
}

function renderFilters() {
  const names = [...new Set([...state.apps, ...state.hidden])].sort();
  $("apps").replaceChildren(
    ...names.map((name) => {
      const chip = el("button", "toggle", name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(!state.hidden.has(name)));
      chip.title = state.hidden.has(name) ? `Show casts via ${name}` : `Hide casts via ${name}`;
      chip.addEventListener("click", () => setAppShown(name, state.hidden.has(name)));
      return chip;
    }),
  );
  $("replies").setAttribute("aria-pressed", String(state.replies));
  const channel = $("channel");
  channel.hidden = !state.channel;
  if (state.channel) {
    // The filter row scrolls on one line: a long url keeps its ends, the title has all of it.
    const label = channelLabel(state.channel);
    const short = label.length > 24 ? `${label.slice(0, 14)}…${label.slice(-8)}` : label;
    channel.textContent = `${short} ×`;
    channel.title = `${state.channel}: tap to show every channel again`;
  }
  $("channels").replaceChildren(
    ...[...state.channels].map((url) => Object.assign(el("option"), { value: url })),
  );
}

function setAppShown(name, shown) {
  if (shown) state.hidden.delete(name);
  else state.hidden.add(name);
  saved.set("hiddenApps", [...state.hidden]);
  if (!shown)
    toast(`casts via ${name} are hidden`, "tap its name above the feed to bring them back");
  showFeedAgain();
}

function setChannel(url) {
  state.channel = url;
  showFeedAgain();
}

/** The feed with the filters just set: drawn now if it is open, else when routing opens it. */
function showFeedAgain() {
  if (!$("home").hidden && ["", "#/"].includes(location.hash)) return loadFeed();
  state.loadedAt = 0;
  location.hash = "#/";
}

/**
 * The feed's request; numbered, so `casty like 3` in a terminal acts on the third cast shown,
 * unless `peek`, a look for new casts that must not renumber the terminal's.
 */
function feedRequest(fresh, { peek = false } = {}) {
  const params = new URLSearchParams({
    limit: peek ? PAGE : state.limit,
    replies: state.replies ? "1" : "0",
  });
  if (state.hidden.size) params.set("exclude", [...state.hidden].join(","));
  if (state.channel) params.set("channel", state.channel);
  if (fresh) params.set(freshness(fresh), "1");
  if (!peek) params.set("number", "1");
  return api(`/api/feed?${params}`);
}

/**
 * Asks the index whether casts newer than the one on top have come, and offers them in a pill:
 * what is being read never moves under the reader. Only with the index, where a look costs
 * nothing; without it the feed is read again when the page comes back after a while.
 */
async function checkNew() {
  const list = $("feed");
  const top = list.querySelector("li.cast")?.dataset.cast;
  if (!state.session?.index || $("home").hidden || !top || document.hidden) return;
  try {
    const { items } = await feedRequest("reload", { peek: true });
    if (!$("home").hidden && list.querySelector("li.cast")?.dataset.cast !== top) return;
    const known = new Set([...list.querySelectorAll("li.cast")].map((li) => li.dataset.cast));
    const at = items.findIndex((cast) => known.has(`${cast.fid}:${cast.hash}`));
    offerNew(at < 0 ? items.length : at);
  } catch {
    // A look that fails is tried again on the next tick.
  }
}

function offerNew(count) {
  const pill = $("new-casts");
  pill.hidden = count === 0;
  if (count) pill.textContent = `${count} new cast${count === 1 ? "" : "s"}`;
}

/**
 * Draws the feed. `quiet` keeps the list on screen while it loads, and when the load fails,
 * which then only shows a toast. `early` is a request already on its way.
 */
async function loadFeed({ quiet = false, fresh = false, early = null } = {}) {
  const current = ticket("feed");
  const list = $("feed");
  if (!quiet) skeleton(list);
  try {
    const { items, turn } = await (early ?? feedRequest(fresh));
    numberedBy("feed", turn);
    if (!current()) return;
    state.loadedAt = Date.now();
    for (const cast of items) {
      if (cast.app && !cast.ours) state.apps.add(appKey(cast.app));
      if (cast.channel) state.channels.add(cast.channel);
    }
    renderFilters();
    offerNew(0);
    if (items.length) {
      // A reload keeps focus on the cast that had it, which replacing the list would drop.
      const focused = list.contains(document.activeElement) && document.activeElement.dataset.cast;
      list.replaceChildren(...items.map((cast, i) => castNode(cast, "feed", i + 1)));
      if (focused) list.querySelector(`li[data-cast="${focused}"]`)?.focus({ preventScroll: true });
      list.removeAttribute("aria-busy");
    } else if (state.hidden.size || !state.replies || state.channel) {
      message(list, "nothing to show", "turn replies, hidden apps or the channel back off above");
    } else {
      message(list, "no casts yet", "open an account under you and follow it, then refresh");
    }
    $("more").hidden = items.length < state.limit || state.limit >= state.session.limits.feed;
  } catch (error) {
    if (!current() || error.status === 401) return;
    if (quiet) fail(error);
    else message(list, error.message, error.hint, () => loadFeed());
  }
}

/**
 * Notes that `view` numbered the terminal's casts, unless a list the server numbered later has:
 * two answers can arrive in the other order than the server numbered them.
 */
function numberedBy(view, turn) {
  if (turn <= state.turn) return;
  state.turn = turn;
  state.numbered = view;
}

/**
 * `path` with refresh=1 when the view is reloaded on purpose: the server reads the node afresh.
 * A page load is "reload": casts afresh, the follow list from the server's cache.
 */
const afresh = (path, fresh) =>
  fresh ? `${path}${path.includes("?") ? "&" : "?"}${freshness(fresh)}=1` : path;
const freshness = (fresh) => (fresh === "reload" ? "reload" : "refresh");

async function showMentions(fresh = false) {
  const current = ticket("mentions");
  const list = $("mentions-list");
  skeleton(list);
  try {
    const { items, turn } = await api(afresh(`/api/mentions?limit=${PAGE}&number=1`, fresh));
    numberedBy("mentions", turn);
    if (!current()) return;
    setUnseen(0);
    if (items.length) {
      list.replaceChildren(...items.map((cast, i) => castNode(cast, "feed", i + 1)));
      list.removeAttribute("aria-busy");
    } else {
      message(list, "nobody has mentioned you yet", "replies to your newest casts show here too");
    }
  } catch (error) {
    if (current() && error.status !== 401)
      message(list, error.message, error.hint, () => showMentions());
  }
}

async function showThread(fid, hash, fresh = false) {
  const current = ticket("thread");
  const list = $("thread-list");
  skeleton(list, 2);
  try {
    const { parent, cast, replies } = await api(
      afresh(`/api/thread?fid=${fid}&hash=${hash}`, fresh),
    );
    if (!current()) return;
    const divider = el(
      "li",
      "divider",
      replies.length === 1 ? "1 reply" : `${replies.length || "no"} replies`,
    );
    list.replaceChildren(
      ...(parent ? [castNode(parent, "parent")] : []),
      castNode(cast, "focus"),
      divider,
      ...replies.map((reply) => castNode(reply)),
    );
    list.removeAttribute("aria-busy");
    list.querySelector(".cast.focus")?.focus({ preventScroll: true });
  } catch (error) {
    if (current() && error.status !== 401) {
      message(list, error.message, error.hint, () => showThread(fid, hash));
    }
  }
}

async function showProfile(fid, fresh = false) {
  const current = ticket("profile");
  state.profileFid = null;
  const list = $("profile-list");
  const follow = $("profile-follow");
  follow.classList.remove("busy");
  $("profile-name").textContent = "";
  $("profile-fid").textContent = `fid ${fid}`;
  $("profile-bio").hidden = true;
  $("profile-apps").textContent = "";
  follow.hidden = true;
  skeleton(list, 3);
  try {
    const profile = await api(afresh(`/api/profile?fid=${fid}`, fresh));
    if (!current()) return;
    state.profileFid = fid;
    const handle = profile.username ? `@${profile.username}` : null;
    $("profile-name").textContent = profile.display ?? handle ?? `fid ${fid}`;
    $("profile-fid").textContent = [profile.display && handle, `fid ${fid}`, profile.you && "you"]
      .filter(Boolean)
      .join(" · ");
    $("profile-bio").textContent = profile.bio ?? "";
    $("profile-bio").hidden = !profile.bio;
    const verified = $("profile-verified");
    verified.replaceChildren("verified: ", ...verifiedNodes(profile.verifications));
    verified.hidden = profile.verifications.length === 0;
    $("profile-apps").textContent = profile.apps.length
      ? `posts via ${profile.apps
          .map((a) => `${a.name ?? `fid ${a.fid}`}${a.keys > 1 ? ` (${a.keys} keys)` : ""}`)
          .join(", ")}`
      : "no app keys";
    follow.hidden = profile.you || !state.session.canWrite;
    showFollowing(settled(`follow:${fid}`) ?? profile.following);
    list.replaceChildren(...profile.casts.map((cast) => castNode(cast)));
    if (!profile.casts.length) message(list, "no casts", null);
    list.removeAttribute("aria-busy");
  } catch (error) {
    if (current() && error.status !== 401) {
      message(list, error.message, error.hint, () => showProfile(fid));
    }
  }
}

function showFollowing(on) {
  const follow = $("profile-follow");
  follow.textContent = on ? "following" : "follow";
  follow.setAttribute("aria-pressed", String(on));
  follow.title = on ? "Stop following" : "Follow";
}

async function toggleFollow() {
  const follow = $("profile-follow");
  const fid = state.profileFid;
  if (!fid || follow.classList.contains("busy")) return;
  const was = follow.getAttribute("aria-pressed") === "true";
  showFollowing(!was);
  follow.classList.add("busy");
  const here = () => state.profileFid === fid;
  try {
    await api("/api/follow", { fid, undo: was });
    state.settled.set(`follow:${fid}`, { on: !was, at: Date.now() });
    toast(was ? "no longer following" : "following", was ? null : "their casts show in the feed");
    state.loadedAt = 0;
  } catch (error) {
    if (here()) showFollowing(was);
    fail(error);
  } finally {
    if (here()) follow.classList.remove("busy");
  }
}

function block(title, rows) {
  const section = el("section", "block");
  section.append(el("h2", "", title));
  const list = el("dl", "kv");
  for (const [term, ...values] of rows) {
    const dd = el("dd");
    dd.append(...values);
    const dt = el("dt");
    dt.append(term);
    list.append(dt, dd);
  }
  section.append(list);
  return section;
}

function bar(used, limit) {
  const outer = el("span", limit > 0 && used / limit >= 0.9 ? "bar full" : "bar");
  const inner = el("i");
  inner.style.width = `${limit > 0 ? Math.min(100, (used / limit) * 100) : 0}%`;
  outer.append(inner);
  return outer;
}

async function showYou(fresh = false) {
  const current = ticket("you");
  const body = $("you-body");
  body.replaceChildren(el("p", "empty", "loading"));
  try {
    const me = await api(afresh("/api/me", fresh));
    if (!current()) return;
    $("you-name").textContent = me.username ? `@${me.username}` : `fid ${me.fid}`;
    $("you-fid").textContent = `fid ${me.fid}`;
    const keys = me.keys.map((k) => keyRow(k, me.fid));
    for (const key of me.lapsed) {
      keys.push([shortKey(key), el("span", "sub", "held here, no longer on the node")]);
    }
    const node = me.node;
    const keyBlock = block(
      "app keys",
      keys.length
        ? keys
        : [["none", "add one with your wallet below, or run casty init in a terminal"]],
    );
    if (state.session.canAddKey) {
      keyBlock.append(
        addKeyControl(
          me.custody,
          me.keys.some((k) => k.ours),
        ),
      );
    }
    body.replaceChildren(
      block("account", [
        ["fid", String(me.fid)],
        ["username", me.username ? `@${me.username}` : "none"],
        [
          "custody",
          addressNode(
            me.custody,
            "custody",
            `https://optimistic.etherscan.io/address/${me.custody}`,
          ),
        ],
      ]),
      keyBlock,
      block(
        "verified addresses",
        me.verifications.length
          ? me.verifications.map((v) => [v.protocol, verifiedNode(v)])
          : [["none", "an address verified in another Farcaster app shows here"]],
      ),
      block("storage", [
        ["units", String(me.storage.units)],
        ...me.storage.stores.map((s) => [
          s.store
            .toLowerCase()
            .replace(/^store_type_/, "")
            .replaceAll("_", " "),
          `${s.used} / ${s.limit}`,
          bar(s.used, s.limit),
        ]),
      ]),
      block("node", [
        ["url", node.url],
        ["snapchain", node.version],
        ["synced", node.synced ? "yes" : "no"],
        ...node.shards.map((s) => [
          `shard ${s.shard}`,
          `${s.blockDelay <= 2 ? "in sync" : `${span(s.blockDelay)} behind`}, block ${s.maxHeight.toLocaleString("en")}`,
        ]),
        ["clock", node.clockSkew === null ? "unknown" : `${node.clockSkew}s from the node's`],
      ]),
      // The wallet first, the seed phrase last: a phrase controls the whole account and never
      // belongs in a browser, so what needs it stays in a terminal.
      block("in a terminal", [
        [
          "casty init",
          'add an app key where "add a key with your wallet" cannot; asks for the seed phrase',
        ],
        ["casty key revoke --self", "remove this casty's key with the key itself"],
        ["casty key revoke <key>", "remove any key; asks for the seed phrase"],
      ]),
      block("this browser", [
        ["theme", themeChoices()],
        ...(state.session.push ? [["notifications", notifyControl()]] : []),
        ["config", me.configDir],
        ["pairing", "stop casty web, start it with --new-token to unpair every browser"],
        ["keys", "n cast, r refresh, j k move, l like, o open, esc close"],
      ]),
    );
  } catch (error) {
    if (current() && error.status !== 401) {
      body.replaceChildren(
        el("p", "empty", `${error.message}${error.hint ? ` hint: ${error.hint}` : ""}`),
      );
    }
  }
}

// --- views -----------------------------------------------------------------------------------

function show(view) {
  if (!$("home").hidden && view !== "home") state.feedScroll = window.scrollY;
  for (const id of VIEWS) $(id).hidden = id !== view;
  for (const [tab, of] of [
    ["tab-feed", "home"],
    ["tab-mentions", "mentions"],
    ["tab-you", "you"],
  ]) {
    if (view === of) $(tab).setAttribute("aria-current", "page");
    else $(tab).removeAttribute("aria-current");
  }
}

const ROUTES = [
  [/^#\/cast\/(\d+)\/(0x[0-9a-f]{40})$/, "thread", (m, fresh) => showThread(m[1], m[2], fresh)],
  [/^#\/fid\/(\d+)$/, "profile", (m, fresh) => showProfile(Number(m[1]), fresh)],
  [/^#\/mentions$/, "mentions", (_, fresh) => showMentions(fresh)],
  [/^#\/you$/, "you", (_, fresh) => showYou(fresh)],
];

/** Shows the view the address names; `fresh` when it is reloaded on purpose. */
function route(fresh = false, early = null) {
  if (!state.session) return;
  for (const [pattern, view, load] of ROUTES) {
    const match = pattern.exec(location.hash);
    if (!match) continue;
    if (!$("home").hidden) {
      state.feedFocus = document.activeElement?.closest?.("#feed li.cast")?.dataset.cast ?? null;
    }
    show(view);
    window.scrollTo(0, 0);
    load(match, fresh);
    return;
  }
  const back = !$("home").hidden;
  show("home");
  if (!back) window.scrollTo(0, state.feedScroll);
  const left = state.feedFocus && $("feed").querySelector(`li[data-cast="${state.feedFocus}"]`);
  left?.focus({ preventScroll: true });
  // Mentions renumbered the terminal's casts; the feed takes its numbers back, from memory.
  if (!state.loadedAt || fresh) loadFeed({ fresh, early, quiet: Boolean(state.loadedAt) });
  else if (state.numbered !== "feed") loadFeed({ quiet: true });
}

function refresh() {
  if ($("home").hidden) route(true);
  else loadFeed({ quiet: $("feed").children.length > 0, fresh: true });
  checkNode();
  checkMentions();
}

// --- compose ---------------------------------------------------------------------------------

/** Drafts by what they answer ("new" for a cast), kept in the browser across reloads. */
const drafts = {
  get: (target) => saved.get("drafts", {})[target] ?? "",
  set(target, text) {
    const all = saved.get("drafts", {});
    if (text.trim()) all[target] = text;
    else delete all[target];
    saved.set("drafts", all);
  },
};

function openCompose(parent) {
  const target = parent ? `${parent.fid}:${parent.hash}` : "new";
  if (state.draftFor !== target || !$("text").value) {
    $("text").value = drafts.get(target);
    $("channel-input").value = "";
    $("links").replaceChildren();
    $("add-link").hidden = false;
  }
  state.draftFor = target;
  // A new cast from a feed showing one channel goes there, unless the draft names another.
  if (!parent && state.channel && !$("channel-input").value)
    $("channel-input").value = state.channel;
  state.replyTo = parent ?? null;
  $("compose-title").textContent = parent ? "reply" : "cast";
  $("send").textContent = parent ? "reply" : "cast";
  $("text").placeholder = parent ? "your reply" : "what is on your mind";
  // A cast is either a reply or a channel post, not both.
  $("channel-input").closest(".field").hidden = Boolean(parent);
  const replying = $("replying");
  replying.hidden = !parent;
  if (parent) {
    const said = textOf(parent);
    replying.textContent = `${nameOf(parent)}: ${said.length > 90 ? `${said.slice(0, 90)}...` : said}`;
  }
  $("compose-status").textContent = "";
  $("compose").showModal();
  $("text").focus();
  count();
}

function addLink(value = "") {
  const max = state.session.limits.embeds;
  if ($("links").children.length >= max) return;
  const row = el("label", "field");
  const input = el("input");
  input.type = "url";
  input.placeholder = "https://";
  input.value = value;
  const remove = el("button", "word", "remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    row.remove();
    $("add-link").hidden = false;
  });
  row.append(el("span", "mono", "link"), input, remove);
  $("links").append(row);
  $("add-link").hidden = $("links").children.length >= max;
  input.focus();
}

function count() {
  const text = $("text").value;
  const bytes = new TextEncoder().encode(text).length;
  const { cast, longCast } = state.session.limits;
  const counter = $("count");
  counter.textContent = bytes > cast ? `${bytes}/${longCast} long` : `${bytes}/${cast}`;
  counter.classList.toggle("over", bytes > longCast);
  counter.title = bytes > cast ? `over ${cast} bytes, so it goes out as a long cast` : "bytes";
  $("send").disabled = text.trim() === "" || bytes > longCast;
  // The counter is not read out on every key; going over the limit is, once.
  const status = $("compose-status");
  const over = `too long: ${bytes} bytes, the limit is ${longCast}`;
  if (bytes > longCast && !status.textContent.startsWith("too long")) status.textContent = over;
  if (bytes <= longCast && status.textContent.startsWith("too long")) status.textContent = "";
}

async function send(event) {
  event.preventDefault();
  const button = $("send");
  if (button.disabled) return;
  const parent = state.replyTo;
  const body = { text: $("text").value };
  if (parent) body.parent = { fid: parent.fid, hash: parent.hash };
  const channel = $("channel-input").value.trim();
  if (channel && !parent) body.channel = channel;
  const embeds = [...$("links").querySelectorAll("input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (embeds.length) body.embeds = embeds;
  const status = $("compose-status");
  button.disabled = true;
  state.sending = true;
  $("text").readOnly = true;
  status.classList.remove("error");
  status.textContent = "sending; casty waits until your node has it";
  try {
    const { plain } = await api("/api/cast", body);
    drafts.set(state.draftFor, "");
    $("text").value = "";
    $("channel-input").value = "";
    $("links").replaceChildren();
    $("add-link").hidden = false;
    $("compose").close();
    const done = parent ? "reply published" : "cast published";
    if (plain?.length) {
      const names = plain.map((name) => `@${name}`).join(", ");
      toast(`${done}; ${names} went out as text`, "no account has that name");
    } else {
      toast(done);
    }
    state.loadedAt = 0;
    refresh();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error.hint ? `${error.message}. hint: ${error.hint}` : error.message;
  } finally {
    state.sending = false;
    $("text").readOnly = false;
    count();
  }
}

// --- session ---------------------------------------------------------------------------------

function showPairing() {
  state.session = null;
  for (const id of [...VIEWS, "prompt", "refresh"]) $(id).hidden = true;
  $("pair-note").hidden = !state.token;
  $("pair").hidden = false;
  $("pair-input").focus();
}

/**
 * True when the address carried a token, which is then tried and taken out of the address. It
 * is saved only once casty web takes it (start), so a link with a wrong token, from anyone,
 * cannot unpair this browser.
 */
function takeToken() {
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!match) return false;
  state.token = match[1];
  history.replaceState(null, "", "/");
  return true;
}

function setDot(status) {
  const dot = $("dot");
  dot.className = `dot ${status}`;
  dot.parentElement.title =
    status === "ok" ? "node synced" : status === "down" ? "node unreachable" : "node behind";
}

function notice() {
  const { node, canWrite, keyExpiresAt } = state.session;
  const lines = [];
  if (!node.synced)
    lines.push(`your node is ${node.behind} behind; the newest casts may be missing`);
  if (!canWrite) lines.push("read-only: this page was started with \u2011\u2011read\u2011only");
  // A gasless key lapses after its TTL without use, and every message it signs renews it.
  const days = keyExpiresAt ? Math.ceil((new Date(keyExpiresAt) - Date.now()) / 86_400_000) : null;
  if (days !== null && days <= 7) {
    lines.push(
      days > 0
        ? `your app key lapses in ${days} day${days === 1 ? "" : "s"}; a cast, like or follow renews it`
        : "your app key has lapsed; run casty init in a terminal",
    );
  }
  $("notice").textContent = lines.join(". ");
  $("notice").hidden = lines.length === 0;
  setDot(node.synced ? "ok" : "behind");
}

async function checkNode() {
  try {
    state.session = { ...state.session, ...(await api("/api/session")) };
    notice();
  } catch {
    // api() has marked the node as down, or shown pairing.
  }
}

/** Marks the mentions tab, the title and an installed app's icon with how many are new. */
function setUnseen(count) {
  const badge = $("mentions-badge");
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.hidden = count === 0;
  if (count) $("tab-mentions").setAttribute("aria-label", `mentions, ${count} new`);
  else $("tab-mentions").removeAttribute("aria-label");
  document.title = count ? `(${badge.textContent}) casty` : "casty";
  const app = count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  app?.catch(() => {});
}

async function checkMentions() {
  const loads = tickets.mentions;
  try {
    const { mentions } = await api(`/api/unseen?limit=${PAGE}`);
    // The open list is what is new, and clears the count when it loads; a list loaded since this
    // was asked has shown what it counts.
    if ($("mentions").hidden && tickets.mentions === loads) setUnseen(mentions);
  } catch {
    // api() has marked the node as down, or shown pairing.
  }
}

async function start() {
  takeToken();
  if (!state.token) return showPairing();
  // The feed is asked for alongside the session, which it needs only to be drawn. A page load
  // reads the casts afresh; the follow list comes from the server's cache, which refresh and
  // the follows made here keep current.
  const home = !ROUTES.some(([pattern]) => pattern.test(location.hash));
  const early = home ? feedRequest("reload") : null;
  early?.catch(() => {});
  try {
    state.session = await api("/api/session");
  } catch (error) {
    if (error.status === 401) {
      // A token from a link that casty web refused: back to the saved one, if it is another.
      const kept = saved.get("token", "");
      if (kept && kept !== state.token) {
        state.token = kept;
        return start();
      }
      return;
    }
    // On the pairing screen the feed is hidden; say it where it shows.
    if (!$("pair").hidden) fail(error);
    else message($("feed"), error.message, error.hint, start);
    return;
  }
  saved.set("token", state.token);
  $("pair").hidden = true;
  $("refresh").hidden = false;
  const { canWrite } = state.session;
  document.body.classList.toggle("read-only", !canWrite);
  $("prompt").hidden = !canWrite;
  notice();
  route("reload", early);
  checkMentions();
}

// --- keyboard --------------------------------------------------------------------------------

function visibleCasts() {
  const view = VIEWS.find((id) => !$(id).hidden);
  return view ? [...$(view).querySelectorAll("li.cast:not(.skeleton):not([hidden])")] : [];
}

function move(step) {
  const casts = visibleCasts();
  if (!casts.length) return;
  const at = casts.indexOf(document.activeElement.closest?.("li.cast"));
  const next = casts[Math.max(0, Math.min(casts.length - 1, at < 0 ? 0 : at + step))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function onKey(event) {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || !state.session) return;
  if (event.key === "Escape") {
    for (const menu of document.querySelectorAll("details.menu[open]")) menu.open = false;
    return;
  }
  if (event.target.closest?.("input, textarea, dialog")) return;
  const focused = document.activeElement.closest?.("li.cast");
  const keys = {
    n: () => state.session.canWrite && openCompose(),
    r: refresh,
    j: () => move(1),
    k: () => move(-1),
    l: () => state.session.canWrite && focused?.querySelector(".like").click(),
    o: () => {
      if (focused) location.hash = focused.querySelector(".age").getAttribute("href");
    },
  };
  // Enter opens a cast only when the cast itself has focus, not a link or button inside it.
  const onCast = focused && document.activeElement === focused;
  const action = keys[event.key] ?? (event.key === "Enter" && onCast ? keys.o : null);
  if (!action) return;
  event.preventDefault();
  action();
}

// --- wiring ----------------------------------------------------------------------------------

$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = /([A-Za-z0-9_-]{43})\s*$/.exec($("pair-input").value)?.[1];
  if (!token) return toast("that is not a casty web link or token");
  state.token = token;
  start();
});
$("find").addEventListener("submit", async (event) => {
  event.preventDefault();
  const who = $("find-input").value.trim();
  try {
    const fid = /^\d+$/.test(who)
      ? Number(who)
      : (await api(`/api/resolve?name=${encodeURIComponent(who)}`)).fid;
    $("find-input").value = "";
    location.hash = profileHref(fid);
  } catch (error) {
    fail(error);
  }
});
$("replies").addEventListener("click", () => {
  state.replies = !state.replies;
  saved.set("replies", state.replies);
  loadFeed();
});
$("channel").addEventListener("click", () => setChannel(null));
$("more").addEventListener("click", () => {
  state.limit = Math.min(state.limit + PAGE, state.session.limits.feed);
  loadFeed({ quiet: true });
});
// The next page comes as the end of the list comes into view; the button stays for keyboards
// and browsers without the observer.
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !$("more").hidden) $("more").click();
  }).observe($("more"));
}
$("new-casts").addEventListener("click", () => {
  offerNew(0);
  window.scrollTo(0, 0);
  loadFeed({ quiet: true, fresh: "reload" });
});
// Pulling the feed down from its top and letting go refreshes it, as phone apps do; an
// installed page has no browser bar to pull.
let pullFrom = null;
document.addEventListener("touchstart", (event) => {
  const y = event.touches?.[0]?.clientY;
  pullFrom =
    y !== undefined && window.scrollY === 0 && !$("home").hidden && !$("compose").open ? y : null;
});
document.addEventListener("touchmove", (event) => {
  if (pullFrom === null) return;
  const y = event.touches?.[0]?.clientY;
  $("pull").hidden = y === undefined || y - pullFrom < PULL_PX;
});
document.addEventListener("touchend", () => {
  const pulled = !$("pull").hidden;
  $("pull").hidden = true;
  pullFrom = null;
  if (pulled) refresh();
});
$("refresh").addEventListener("click", refresh);
// Tapping the tab you are on scrolls up and reloads it, as phone apps do; small screens have no
// room for the refresh word.
for (const [tab, hashes] of [
  ["tab-feed", ["", "#/"]],
  ["tab-mentions", ["#/mentions"]],
  ["tab-you", ["#/you"]],
]) {
  $(tab).addEventListener("click", (event) => {
    if (!hashes.includes(location.hash)) return;
    event.preventDefault();
    window.scrollTo(0, 0);
    refresh();
  });
}
$("theme").addEventListener("click", () => {
  setTheme(THEMES[(THEMES.indexOf(saved.get("theme", "auto")) + 1) % THEMES.length]);
});
$("profile-follow").addEventListener("click", toggleFollow);
$("prompt").addEventListener("click", () => openCompose());
// While a cast is on its way the box stays open, so the next draft is not cleared with it.
const closeCompose = () => state.sending || $("compose").close();
$("compose-close").addEventListener("click", closeCompose);
$("compose").addEventListener("click", (event) => {
  if (event.target === $("compose")) closeCompose();
});
$("compose").addEventListener("cancel", (event) => {
  if (state.sending) event.preventDefault();
});
$("compose-form").addEventListener("submit", send);
$("add-link").addEventListener("click", () => addLink());
$("text").addEventListener("input", () => {
  drafts.set(state.draftFor, $("text").value);
  count();
});
$("text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("compose-form").requestSubmit();
});
// A pairing link opened in a tab that already shows the page changes only the hash.
window.addEventListener("hashchange", () => (takeToken() ? start() : route()));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
  applyTheme(saved.get("theme", "auto")),
);
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", onKey);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.session) return;
  checkNode();
  checkMentions();
  if (state.session.index) checkNew();
  else if (Date.now() - state.loadedAt > 120_000 && !$("home").hidden && window.scrollY < 80) {
    loadFeed({ quiet: true });
  }
});

// A tab left open in the background keeps its title current too; browsers slow this down there.
setInterval(() => state.session && checkMentions(), UNSEEN_MS);
setInterval(() => state.session && checkNew(), NEW_MS);

applyTheme(saved.get("theme", "auto"));
start();
