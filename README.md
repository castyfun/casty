# casty

English · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md)

Your own Farcaster read node, and a command-line client that reads from it and writes through it.
No API keys, no Ethereum RPC on the normal path, no onchain transaction for the app key.

Documentation in six languages: https://castyfun.github.io/casty/ · every command explained: https://castyfun.github.io/casty/commands/

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

Or step by step, which is what `deploy.sh` runs:

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

A seed phrase controls the whole account. Use a test account for this tutorial, paste a seed
phrase only into software from developers you trust, and prefer a key authorised by your
wallet: `./scripts/2-client.sh --fid <fid>` (or `deploy.sh --fid <fid>`), then `./bin/casty web`
and, under you, "add a key with your wallet".

| Step | You need | It leaves you with |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` and `HCLOUD_TOKEN`, or the `aws` CLI and credentials; `~/.ssh/id_ed25519.pub` | a host and `node.env` |
| `1-node.sh` | `ssh` and `jq`; a host with 16 GB RAM, 2 TB disk, Docker (cloud-init installs it) | a synced read node and a tunnel |
| `2-client.sh` | `curl`; a test account's fid with a storage unit, and its seed phrase or a wallet. With `--from-source`: Node 22.12 or newer and pnpm through corepack | `./bin/casty`, one file, with an app key |

Every step is safe to run again, so `deploy.sh` picks up where a run stopped: the first sync
takes hours, and Ctrl-C during it loses nothing. `deploy.sh --tailscale` reaches the page over
your tailnet instead of a domain; without either, it stops after the client. Until the first
release is tagged, step 2 finds nothing to download and builds the client here instead, which
needs Node 22.12 or newer. Every script takes `--help`. `0-provision.sh --dry-run` and `1-node.sh --dry-run` print each
command instead of running it; a real `0-provision.sh` run lists what it will create and bill,
and goes ahead only once you type the server name back. The first sync downloads a snapshot of several hundred GB and takes
hours; `./scripts/1-node.sh status` shows how far each shard is behind.

`./bin/casty --help` lists the client commands: `doctor`, `init`, `whoami`, `feed`, `mentions`,
`thread`, `cast`, `reply`, `like` and `unlike`, `recast` and `unrecast`, `follow` and `unfollow`, `delete`,
`clients`, `storage`, `key list`, `key revoke`, `node status`, `web`, and `serve`, which
`1-node.sh serve` runs on the host. With `casty init --fid <fid>`
the seed phrase is never typed: the page adds the key with the wallet in the browser. Otherwise
the phrase is used once to sign the key request and is never written to disk. The app key is stored encrypted (scrypt, XChaCha20-Poly1305) in `~/.config/casty/keys.enc.json`.
[SECURITY.md](SECURITY.md) lists every secret involved, where it lives and how to revoke it.

## In a browser and on a phone

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="casty web on a phone, light theme: the numbered feed">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="casty web on a phone, dark theme: a cast with what it answers and its reply">
</p>

`./bin/casty web` serves the CLI's commands as a page on `http://127.0.0.1:3390`, apart from
removing keys, and prints a link that pairs a browser; under you it adds an app key with your
wallet. `--listen 0.0.0.0:3390` adds a
QR code for a phone on the same network. [docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx)
has the details.

`./scripts/1-node.sh serve --domain <name>` (or `--tailscale`) runs the same page on the node's
host behind HTTPS, so a phone reads and writes from any network: the client is built there in a
container, Caddy gets the certificate (open 80 and 443 with `0-provision.sh --https`), and the
app key and its passphrase go to the host as a Docker secret unless `--read-only`. There the
feed comes from an index that follows the node's events, and a mention or a reply reaches the
phone as a push notification naming the sender and nothing else.
[docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx) has the details and the trade.

## Without a node

The mock node in `test/mock-node` serves the Snapchain HTTP API from fixtures, checks signatures
on submitted messages and merges them, so the whole client runs offline. `pnpm demo` (after
`pnpm install`) starts one on a free port, adds an app key with the test phrase, reads the feed
with and without one app, casts, and removes its throwaway config at the end:

```text
$ casty feed --limit 3
1  @casty-test · 1s · via casty
   hello from casty

2  @user-2000000002 · 17d · via app-alpha
   @casty-test thanks for the pointer, it worked.
   https://example.com/2000000002/3

3  @user-2000000011 · 17d · via app-beta
   Reading the Snapchain docs on a train. A good way to spend an hour.

$ casty like 2
```

`pnpm demo:web` does the same setup, then serves `casty web` on a free port until Ctrl-C.

`via` names the app that requested the key a cast was signed with; `--only-app` and
`--exclude-app` filter on it. The number in front of a cast is what `like`, `reply`, `recast`
and `delete` take, as well as `<fid>:<hash>` or the cast's farcaster.xyz link. Step by step:

```sh
pnpm install --frozen-lockfile
pnpm mock-node &                      # http://127.0.0.1:3381, fixtures from test/mock-node/fixtures/basic
export XDG_CONFIG_HOME=$(mktemp -d)   # keeps the test key out of your real config
./scripts/2-client.sh --no-init --from-source   # builds ./bin/casty from this checkout and runs casty doctor
printf 'test test test test test test test test test test test junk\n' \
  | CASTY_PASSPHRASE=x ./bin/casty init --mnemonic-stdin
./bin/casty feed --limit 20
./bin/casty cast "hello from casty"
```

In the fixtures the BIP-39 reference phrase above owns fid 2000000001. `CASTY_PASSPHRASE` exists for
tests; without it casty asks on the terminal. `pnpm mock-node gen --fids 300 --casts 50 --seed 42`
writes a bigger set to `test/mock-node/fixtures/generated`, served with
`pnpm mock-node serve --fixtures generated`.

## Checks

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

`make check` runs offline and needs `shellcheck`, `jq` and `yq` (mikefarah) besides Node and pnpm;
lychee is used when installed. CI also runs the coverage and, weekly too, `pnpm audit`. The docs'
links between pages work on the site, not when the `.mdx` files are read on GitHub. Real-node tests in `client/test/e2e` run
only when `CASTY_E2E_NODE_URL` and `CASTY_E2E_MNEMONIC` (a test account's phrase) are set; with `CASTY_E2E_READ_FID`, an
account that has been mentioned and replied to, they also check the node's answers the client relies on.

## Layout

| Path | What |
| --- | --- |
| `scripts/` | the three steps, `deploy.sh` and `demo.sh`, their libraries and templates; bats suites in `scripts/tests` |
| `client/` | the `casty` CLI (TypeScript) and the `casty web` page in `client/src/web` |
| `test/mock-node/` | the mock Snapchain node and its fixture generator |
| `test/fakebin/` | fake `hcloud`, `aws`, `cherryctl`, `ssh`, `sudo`, `docker`, `curl`, `crontab`, `cloud-init`, `tailscale` for the bats suites |
| `docs/` | the documentation site (Astro Starlight) |
| `SECURITY.md` | secrets, exposure, what to do if something leaks |

`1-node.sh --autoupgrade` installs Snapchain's weekly upgrade job, which runs
`docker system prune --volumes -f` on the whole host. On Windows, run the scripts in WSL2.

MIT licensed. Snapchain (GPL-3.0) is downloaded and run on your host, never vendored here. The
release binary has about twenty MIT and Apache-2.0 packages inside it; their notices are in
`THIRD_PARTY_LICENSES` next to it.
