# Security

What casty holds, where it keeps it, and what each piece can do. casty has not been audited.

| Secret | Where it is | What it can do | How to take it back |
| --- | --- | --- | --- |
| Seed phrase | In memory while `casty init` or `casty key revoke` runs; never written to disk, never sent anywhere. With `casty init --fid` and a key added from the page by a wallet, casty never sees it at all | Everything: it is the custody of your fid | casty cannot. Keep it offline |
| App key (Ed25519) | `~/.config/casty/keys.enc.json`, encrypted with scrypt (N=2^17, r=8, p=1) and XChaCha20-Poly1305, mode 0600 | Sign casts, reactions and follows for your fid (the `--scopes` given to `init`) until its TTL runs out unused (default 30 days, at most 90) | `casty key revoke <key>` with the seed phrase, or `--self` with the key itself |
| Signed KEY_ADD not yet confirmed | Inside the same encrypted store, until a `casty init` sees the key listed or the node refuses the message | Add that one key, once | `casty key revoke` if it ever merges |
| Key store passphrase | Typed at a hidden prompt. `CASTY_PASSPHRASE` exists for tests and `pnpm demo` | Decrypt the app keys on this machine | Revoke the keys with the seed phrase, delete `keys.enc.json`, run `casty init` |
| casty web token | `~/.config/casty/web-token`, mode 0600; in the paired browser's storage | While `casty web` runs: read the feed and write as your app key, from wherever the page is reachable | Stop `casty web`, then start it with `--new-token` |
| The same on the node's host (`1-node.sh serve`) | `~/snapchain/casty/config/keys.enc.json` (0600), the passphrase in `~/snapchain/casty/passphrase` (0600, a Docker secret), the token in `~/snapchain/casty/config/web-token`; the key decrypted in the service's memory | Read and write as you from any network while the service runs; root on the host has the key | `casty key revoke <key>` with the seed phrase; `docker compose stop casty` on the host; `--read-only` keeps the key at home |
| Push key pair and subscriptions (`casty serve`) | `~/snapchain/casty/config/vapid.json` (0600) and `cache/push.json` on the host | Send a push, "new mention from @name", to the subscribed browsers; the push service sees only ciphertext | Delete both files and restart `casty`; turn notifications off in the browser |
| Cloud token (`HCLOUD_TOKEN`, AWS credentials) | Your environment; the scripts never write it | Create and delete servers in that project | Revoke it in the provider's console |
| SSH key | Yours (`~/.ssh/id_ed25519` unless `--ssh-pubkey`); only the public half is uploaded | Root on the node host | Remove it from the host and the provider |

## What is reachable

- The provider firewall opens SSH (22) and the node's HTTP (3381) and gRPC (3383) ports to `--allow-ip` only, your address by default; gossip (3382) is open to everyone so peers can connect. An existing host gets no firewall from casty.
- statsd (8125/udp, 8126/tcp) and Grafana (3000) are bound to the host's loopback, on any host `1-node.sh` runs on: it sets the compose file's own `STATSD_PUBLISH` and `STATSD_ADMIN_PUBLISH` in `.env`. Grafana's `admin` password is the random one `.env` records as `GRAFANA_PASSWORD`, not the default; reach it over SSH.
- casty reaches the node through the SSH tunnel at `127.0.0.1:3381`. It calls no hosted Farcaster API. The fname registry is asked only for a name the node cannot resolve: an `@name` you follow or mention in a cast (`--no-allow-fname-server` turns that off), read with `feed --fids` or look up in `casty web`, and the author of a cast you name by its farcaster.xyz link, and an OP Mainnet RPC only when you pass `--op-rpc`.
- `casty web` listens on 127.0.0.1:3390 unless `--listen` names another address. Every API call needs its token; writes are JSON only, a Host that is not an IP address, `localhost` or the `--listen` host is refused, and the page runs only its own script and loads nothing from other sites. With `--listen 0.0.0.0:3390` the page and its token travel over plain HTTP on that network. While it runs, the app key is decrypted in memory.
- `1-node.sh serve --domain` opens the page to the internet over HTTPS (80 and 443, opened with `0-provision.sh --https`); `--tailscale` only to your tailnet. The page then needs its token, sends HSTS, and answers one address at most 120 API requests a minute.
- With notifications on, `casty serve` sends the browser's push service (Apple's, Google's or Mozilla's) one encrypted message per mention or reply: the sender's name, never the cast's text. Besides the fname registry above, the only request casty makes to a third party, and only for browsers that asked.
- Cast text from other people has terminal control characters removed before it is printed, and enters the web page only as text.

## If something leaks

- App key: `casty key revoke <key> --self` from any machine that still has it, or with the seed phrase from anywhere; `casty key list` shows what is registered.
- Seed phrase: move the fid to a new custody address with a wallet you trust, then revoke every app key.
- Cloud token: revoke it, then check the project for servers you did not create.
- casty web token: stop `casty web`, then start it with `--new-token`; links printed before stop working. On the node's host: delete `~/snapchain/casty/config/web-token` and `docker compose restart casty`.
- The node's host: revoke the app key with the seed phrase, delete `~/snapchain/casty`, and treat the host as compromised for the node too.

## Reporting a problem

Report vulnerabilities privately (on GitHub: Security, then "Report a vulnerability"), not in a public issue.
