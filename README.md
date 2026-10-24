<div align="center">

# casty

**Your own Farcaster read node, and a client that reads from it and writes through it.**<br>
Three commands. No API keys, no Ethereum RPC, no gas.

[![ci](https://github.com/castyfun/casty/actions/workflows/ci.yml/badge.svg)](https://github.com/castyfun/casty/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-c4390a)](LICENSE)
[![docs](https://img.shields.io/badge/docs-6%20languages-191813)](https://castyfun.github.io/casty/)

English · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md)

<img src="docs/src/assets/hero.webp" width="880" alt="casty web on a laptop in the dark theme and on a phone in the light theme">

**[Website and documentation](https://castyfun.github.io/casty/)** · [Every command](https://castyfun.github.io/casty/commands/) · [Deploy with an agent](https://castyfun.github.io/casty/agents/) · [llms.txt](llms.txt)

</div>

casty puts a [Snapchain](https://snapchain.farcaster.xyz) read node, a full copy of Farcaster, on
a host you control, and gives you a client that talks to nothing else: a terminal command and a
page for the browser and the phone. Your feed, mentions and threads are read from your node; your
casts, replies, likes, recasts and follows go out through it. The app key that signs them is
added with one message your wallet signs: no transaction, no gas.

## Quick start

You need the fid of a Farcaster test account and a wallet that holds its custody address; for a new node also a Hetzner token, AWS credentials or a Linux host with 16 GB RAM and 2 TB free disk.

An account made in the Farcaster app keeps that address in the app, not in a browser wallet: show its recovery phrase in the app on your phone and import it once into MetaMask or Rabby, or type it into `./bin/casty init` in your own terminal instead of using `casty web`.

```sh
# a new node of your own
git clone https://github.com/castyfun/casty.git && cd casty
export HCLOUD_TOKEN=<token>            # Hetzner; or AWS credentials, or add -- --host user@ip below
./scripts/deploy.sh --fid <your fid>   # server, node (syncs for hours), ./bin/casty
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
./scripts/0-provision.sh --destroy     # when you are done: server, volume and firewall go
```

Or with no node of your own, on one that already runs:

```sh
# casty on a node that already runs
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
```


## Start with one command

### A new node of your own

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --fid <your fid> --domain node.example.org
```

`deploy.sh` rents a server with a 2 TB volume and a firewall on Hetzner (`HCLOUD_TOKEN`) or AWS
(AWS CLI credentials), installs Snapchain and waits for its sync (a few hours), installs `casty`
on your machine, and puts the page on the host behind HTTPS. It shows what it will create and
bill, and goes ahead only once you confirm. With `--fid` no seed phrase is typed: add the key in
`./bin/casty web` when it says so, then run the same command again for the page on the host.
Every step is safe to run again: the same command picks up where a run stopped. A Linux machine
of your own with 16 GB RAM and 2 TB free works too: add `-- --host user@ip`.

### casty on a node that already runs

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
```

No server and no wait: casty connects to any Snapchain node's HTTP API, one of yours on another
machine or a public one, and remembers it for every later command. Then run `./bin/casty web`
and, under you, press "add a key with your wallet".

### Let an agent do it

Paste the prompt from [Deploy with an agent](https://castyfun.github.io/casty/agents/) into
Claude Code, Codex, Cursor or another coding agent. It reads [llms.txt](llms.txt), asks which of
the two you want, shows you the plan before anything costs money, and never asks for your seed
phrase.

> A seed phrase controls the whole account. casty never needs it: `--fid` sets up without one,
> and the key is approved by your wallet in `casty web`. If you do use `casty init` with a phrase,
> use a test account and type it only into software from developers you trust.

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/architecture-dark.png">
  <img src="docs/src/assets/architecture-light.png" width="880" alt="Your terminal and your browser or phone reach your own Snapchain read node over an SSH tunnel or HTTPS; the node holds a full copy of Farcaster and gossips your messages to the validators.">
</picture>

Reads come from your node, so the feed is as fast as the machine it runs on. Writes are signed on
your machine and relayed by your node. Nothing goes through a hosted Farcaster API.

## On a laptop and on a phone

<p>
  <img src="docs/src/assets/desktop-feed-light.png" width="600" alt="The feed on a laptop, light theme">
  <img src="docs/src/assets/phone-mentions-dark.png" width="240" alt="Mentions on a phone, dark theme">
</p>
<p>
  <img src="docs/src/assets/desktop-compose-dark.png" width="600" alt="A new cast on a laptop, dark theme">
  <img src="docs/src/assets/phone-feed-light.png" width="240" alt="The feed on a phone, light theme">
</p>

`./bin/casty web` serves the feed, threads, mentions, profiles and a compose box at
`http://127.0.0.1:3390` and prints a link that pairs a browser; `--listen 0.0.0.0:3390` adds a QR
code for a phone on the same network. `./scripts/1-node.sh serve --domain <name>` runs the same
page on the node's host behind HTTPS, with push notifications for mentions and replies, so a phone
reads and writes from any network.

## In the terminal

```text
$ casty feed --limit 3
1  @casty-test · 0s · via casty
   Reading the feed from my own node. No API key, no rate limit.

2  @user-2000000002 · 22d · via app-alpha
   @casty-test thanks for the pointer, it worked.
   https://example.com/2000000002/3

3  @user-2000000011 · 22d · via app-beta
   Reading the Snapchain docs on a train. A good way to spend an hour.

$ casty like 2
liked 2000000002:0x973d398ad75e1f25fa780085f3c22d30b01d2504
```

| Command | What it does |
| --- | --- |
| `./scripts/deploy.sh` | steps 0, 1 and 2 in order, and the page on the host with `--domain` or `--tailscale` |
| `./scripts/0-provision.sh` | a server, a 2 TB volume and a firewall on Hetzner or AWS, or `--host user@ip` for your own |
| `./scripts/1-node.sh` | Snapchain on the host, the wait for its sync, an SSH tunnel; `status`, `logs`, `upgrade`, `serve`, `down` |
| `./scripts/2-client.sh` | `casty` in `./bin`, checked against the release's checksums, an app key, your feed |
| `casty feed`, `mentions`, `thread` | read, from your node, with numbers the next command takes |
| `casty cast`, `reply`, `like`, `recast`, `follow`, `delete` | write, through your node, confirmed once it is read back |
| `casty web`, `casty serve` | the page, on this machine or on the host |
| `casty doctor`, `whoami`, `key list`, `storage` | the node's sync, your account, your keys, your storage |

[Commands](https://castyfun.github.io/casty/commands/) explains every one of them and its
options; every script and command also takes `--help`.

## Without a node

The mock Snapchain node in `test/mock-node` serves the same HTTP API from fixtures and checks the
signature of every message submitted to it, so the whole client runs offline:

```sh
pnpm install --frozen-lockfile
pnpm demo       # a throwaway app key, the feed with and without one app, a cast, a like
pnpm demo:web   # the same, then casty web until Ctrl-C
```

The fixtures use the BIP-39 test phrase `test test test test test test test test test test test
junk` and fids from 2000000001, which belong to no one.

## Development

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src
pnpm --filter @casty/docs dev                    # the website at localhost:4321
```

`make check` runs offline and needs `shellcheck`, `jq` and `yq` (mikefarah) besides Node 22.12+
and pnpm. CI runs it on Linux and the shell suites on macOS's bash 3.2, plus `pnpm audit` and a
link check. Tests against a real node in `client/test/e2e` run only when `CASTY_E2E_NODE_URL` is
set.

| Path | What |
| --- | --- |
| `scripts/` | the three steps, `deploy.sh` and `demo.sh`, their libraries and templates; bats suites in `scripts/tests` |
| `client/` | the `casty` CLI (TypeScript) and the `casty web` page in `client/src/web` |
| `test/mock-node/` | the mock Snapchain node and its fixture generator |
| `docs/` | the website and documentation (Astro Starlight), in six languages |
| `llms.txt` | the project for coding agents, with the one-prompt setup |

[SECURITY.md](SECURITY.md) lists every secret involved, where it lives and how to revoke it, and
how to report a vulnerability.

## License

casty is released under the [MIT License](LICENSE). The repository holds only casty's own code.
Snapchain, which is GPL-3.0, is not part of it: `1-node.sh` downloads Snapchain's own Docker image
and compose file onto your host and runs them there. The one-file `casty` binary of each release
bundles about twenty MIT and Apache-2.0 packages, whose notices ship next to it in
`THIRD_PARTY_LICENSES`.
