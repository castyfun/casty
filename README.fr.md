# casty

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · Français · [العربية](README.ar.md)

Votre propre nœud de lecture Farcaster, et un client en ligne de commande qui lit depuis ce nœud et écrit à travers lui.
Pas de clé d'API, pas de RPC Ethereum sur le chemin normal, pas de transaction on-chain pour la clé d'application.

Documentation en six langues : https://castyfun.github.io/casty/fr/ · toutes les commandes expliquées : https://castyfun.github.io/casty/fr/commands/

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

Ou étape par étape, ce que `deploy.sh` exécute :

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

Une phrase de récupération contrôle tout le compte. Utilisez un compte de test pour ce tutoriel,
ne collez une phrase de récupération que dans un logiciel de développeurs en qui vous avez
confiance, et préférez une clé autorisée par votre portefeuille : `./scripts/2-client.sh --fid <fid>`
(ou `deploy.sh --fid <fid>`), puis `./bin/casty web` et, dans votre compte, « add a key with your wallet ».

| Étape | Ce qu'il vous faut | Ce qui vous reste |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` et `HCLOUD_TOKEN`, ou la CLI `aws` et ses identifiants ; `~/.ssh/id_ed25519.pub` | un hôte et `node.env` |
| `1-node.sh` | `ssh` et `jq` ; un hôte avec 16 Go de RAM, 2 To de disque et Docker (cloud-init l'installe) | un nœud de lecture synchronisé et un tunnel |
| `2-client.sh` | `curl` ; le fid d'un compte de test avec une storage unit, et sa phrase de récupération ou un portefeuille. Avec `--from-source` : Node 22.12 ou plus récent et pnpm via corepack | `./bin/casty`, un seul fichier, avec une clé d'application |

Chaque étape peut être relancée sans risque, si bien que `deploy.sh` reprend là où une exécution
s'est arrêtée : la première synchronisation prend des heures, et un Ctrl-C pendant celle-ci ne fait
rien perdre. `deploy.sh --tailscale` rend la page accessible via votre tailnet au lieu d'un domaine ;
sans l'un ni l'autre, il s'arrête après le client. Tant que la première version n'est pas étiquetée,
l'étape 2 ne trouve rien à télécharger et compile le client ici à la place, ce qui demande Node 22.12
ou plus récent. Chaque script accepte `--help`. `0-provision.sh --dry-run` et `1-node.sh --dry-run`
affichent chaque commande au lieu de l'exécuter ; une vraie exécution de `0-provision.sh` liste ce
qu'elle va créer et facturer, et ne continue qu'une fois que vous avez retapé le nom du serveur. La
première synchronisation télécharge un instantané de plusieurs centaines de Go et prend des heures ;
`./scripts/1-node.sh status` montre le retard de chaque shard.

`./bin/casty --help` liste les commandes du client : `doctor`, `init`, `whoami`, `feed`, `mentions`,
`thread`, `cast`, `reply`, `like` et `unlike`, `recast` et `unrecast`, `follow` et `unfollow`, `delete`,
`clients`, `storage`, `key list`, `key revoke`, `node status`, `web`, et `serve`, que
`1-node.sh serve` exécute sur l'hôte. Avec `casty init --fid <fid>`, la phrase de récupération n'est
jamais saisie : la page ajoute la clé avec le portefeuille dans le navigateur. Sinon, la phrase sert
une seule fois, pour signer la demande de clé, et n'est jamais écrite sur le disque. La clé
d'application est stockée chiffrée (scrypt, XChaCha20-Poly1305) dans `~/.config/casty/keys.enc.json`.
[SECURITY.md](SECURITY.md) liste chaque secret concerné, où il se trouve et comment le révoquer.

## Dans un navigateur et sur un téléphone

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="casty web sur un téléphone, thème clair : le fil numéroté">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="casty web sur un téléphone, thème sombre : un cast avec ce à quoi il répond et sa réponse">
</p>

`./bin/casty web` sert les commandes de la CLI sous forme de page sur `http://127.0.0.1:3390`, à part
la suppression de clés, et affiche un lien qui appaire un navigateur ; dans votre compte, elle ajoute
une clé d'application avec votre portefeuille. `--listen 0.0.0.0:3390` ajoute un code QR pour un
téléphone sur le même réseau. Les détails sont dans
[docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx).

`./scripts/1-node.sh serve --domain <name>` (ou `--tailscale`) fait tourner la même page sur l'hôte du
nœud derrière HTTPS, pour qu'un téléphone lise et écrive depuis n'importe quel réseau : le client y est
compilé dans un conteneur, Caddy obtient le certificat (ouvrez 80 et 443 avec `0-provision.sh --https`),
et la clé d'application et son mot de passe vont sur l'hôte comme secret Docker, sauf avec
`--read-only`. Là, le fil vient d'un index qui suit les événements du nœud, et une mention ou une
réponse arrive sur le téléphone comme une notification push qui nomme l'expéditeur et rien d'autre.
[docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx) donne les détails et le compromis.

## Sans nœud

Le nœud factice dans `test/mock-node` sert l'API HTTP de Snapchain à partir de fixtures, vérifie les
signatures des messages soumis et les fusionne, si bien que tout le client fonctionne hors ligne.
`pnpm demo` (après `pnpm install`) en démarre un sur un port libre, ajoute une clé d'application avec la
phrase de test, lit le fil avec et sans une application, publie un cast et supprime sa configuration
temporaire à la fin :

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

`pnpm demo:web` fait la même préparation, puis sert `casty web` sur un port libre jusqu'à Ctrl-C.

`via` nomme l'application qui a demandé la clé avec laquelle un cast a été signé ; `--only-app` et
`--exclude-app` filtrent dessus. Le numéro devant un cast est ce que prennent `like`, `reply`, `recast`
et `delete`, tout comme `<fid>:<hash>` ou le lien farcaster.xyz du cast. Pas à pas :

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

Dans les fixtures, la phrase de référence BIP-39 ci-dessus possède le fid 2000000001.
`CASTY_PASSPHRASE` existe pour les tests ; sans elle, casty demande dans le terminal.
`pnpm mock-node gen --fids 300 --casts 50 --seed 42` écrit un jeu plus grand dans
`test/mock-node/fixtures/generated`, servi avec `pnpm mock-node serve --fixtures generated`.

## Vérifications

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

`make check` fonctionne hors ligne et a besoin de `shellcheck`, `jq` et `yq` (mikefarah) en plus de
Node et pnpm ; lychee est utilisé s'il est installé. La CI exécute aussi la couverture et, chaque
semaine en plus, `pnpm audit`. Les liens de la documentation entre pages fonctionnent sur le site, pas
quand les fichiers `.mdx` sont lus sur GitHub. Les tests sur nœud réel dans `client/test/e2e` ne
s'exécutent que si `CASTY_E2E_NODE_URL` et `CASTY_E2E_MNEMONIC` (la phrase d'un compte de test) sont
définis ; avec `CASTY_E2E_READ_FID`, un compte qui a été mentionné et à qui on a répondu, ils
vérifient aussi les réponses du nœud sur lesquelles le client s'appuie.

## Arborescence

| Chemin | Contenu |
| --- | --- |
| `scripts/` | les trois étapes, `deploy.sh` et `demo.sh`, leurs bibliothèques et gabarits ; suites bats dans `scripts/tests` |
| `client/` | la CLI `casty` (TypeScript) et la page `casty web` dans `client/src/web` |
| `test/mock-node/` | le nœud Snapchain factice et son générateur de fixtures |
| `test/fakebin/` | faux `hcloud`, `aws`, `cherryctl`, `ssh`, `sudo`, `docker`, `curl`, `crontab`, `cloud-init`, `tailscale` pour les suites bats |
| `docs/` | le site de documentation (Astro Starlight) |
| `SECURITY.md` | secrets, exposition, que faire en cas de fuite |

`1-node.sh --autoupgrade` installe la tâche hebdomadaire de mise à jour de Snapchain, qui exécute
`docker system prune --volumes -f` sur tout l'hôte. Sous Windows, lancez les scripts dans WSL2.

Sous licence MIT. Snapchain (GPL-3.0) est téléchargé et exécuté sur votre hôte, jamais inclus ici. Le
binaire de la version contient une vingtaine de paquets sous licence MIT et Apache-2.0 ; leurs avis
figurent dans `THIRD_PARTY_LICENSES`, à côté de lui.
