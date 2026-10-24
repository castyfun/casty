<div align="center">

# casty

**Votre propre nœud de lecture Farcaster, et un client qui lit depuis ce nœud et écrit à travers lui.**<br>
Trois commandes. Pas de clé d'API, pas de RPC Ethereum, pas de gas.

[![ci](https://github.com/castyfun/casty/actions/workflows/ci.yml/badge.svg)](https://github.com/castyfun/casty/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-c4390a)](LICENSE)
[![docs](https://img.shields.io/badge/docs-6%20languages-191813)](https://castyfun.github.io/casty/)

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · Français · [العربية](README.ar.md)

<img src="docs/src/assets/hero.webp" width="880" alt="casty web sur un ordinateur portable en thème sombre et sur un téléphone en thème clair">

**[Site et documentation](https://castyfun.github.io/casty/fr/)** · [Toutes les commandes](https://castyfun.github.io/casty/fr/commands/) · [Déployer avec un agent](https://castyfun.github.io/casty/fr/agents/) · [llms.txt](llms.txt)

</div>

casty installe un nœud de lecture [Snapchain](https://snapchain.farcaster.xyz), une copie complète de
Farcaster, sur un hôte que vous contrôlez, et vous donne un client qui ne parle à rien d'autre : une
commande de terminal et une page pour le navigateur et le téléphone. Votre fil, vos mentions et vos
fils de discussion sont lus depuis votre nœud ; vos casts, réponses, likes, recasts et follows
partent à travers lui. La clé d'application qui les signe est ajoutée avec un seul message que
votre portefeuille signe : pas de transaction, pas de gas.

## Démarrage rapide

Il vous faut le fid d'un compte de test Farcaster et un portefeuille qui détient son adresse de custody ; pour un nouveau nœud, aussi un jeton Hetzner, des identifiants AWS ou un hôte Linux avec 16 Go de RAM et 2 To libres.

Un compte créé dans l'application Farcaster garde cette adresse dans l'application, pas dans un portefeuille du navigateur : affichez sa phrase de récupération dans l'application sur votre téléphone et importez-la une fois dans MetaMask ou Rabby, ou saisissez-la dans `./bin/casty init` dans votre propre terminal au lieu de `casty web`.

```sh
# a new node of your own
git clone https://github.com/castyfun/casty.git && cd casty
export HCLOUD_TOKEN=<token>            # Hetzner; or AWS credentials, or add -- --host user@ip below
./scripts/deploy.sh --fid <your fid>   # server, node (syncs for hours), ./bin/casty
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
./scripts/0-provision.sh --destroy     # when you are done: server, volume and firewall go
```

Ou sans nœud à vous, sur un nœud qui tourne déjà :

```sh
# casty on a node that already runs
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
```


## Commencer avec une seule commande

### Un nouveau nœud à vous

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --fid <your fid> --domain node.example.org
```

`deploy.sh` loue un serveur avec un volume de 2 To et un pare-feu chez Hetzner (`HCLOUD_TOKEN`) ou
AWS (identifiants de la CLI AWS), installe Snapchain et attend sa synchronisation (quelques heures),
installe `casty` sur votre machine, et met la page sur l'hôte derrière HTTPS. Il affiche ce qu'il va
créer et facturer, et ne continue qu'une fois que vous avez confirmé. Avec `--fid`, aucune phrase de
récupération n'est saisie : ajoutez la clé dans `./bin/casty web` quand il vous le demande, puis
relancez la même commande pour la page sur l'hôte. Chaque étape peut être relancée sans risque : la
même commande reprend là où une exécution s'est arrêtée. Une machine Linux à vous avec 16 Go de RAM
et 2 To libres fonctionne aussi : ajoutez `-- --host user@ip`.

### casty sur un nœud qui tourne déjà

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
```

Pas de serveur et pas d'attente : casty se connecte à l'API HTTP de n'importe quel nœud Snapchain,
l'un des vôtres sur une autre machine ou un nœud public, et le retient pour toutes les commandes
suivantes. Lancez ensuite `./bin/casty web` et, dans « you », appuyez sur « add a key with your
wallet ».

### Laisser un agent le faire

Collez le prompt de [Déployer avec un agent](https://castyfun.github.io/casty/fr/agents/) dans
Claude Code, Codex, Cursor ou un autre agent de programmation. Il lit [llms.txt](llms.txt), vous
demande laquelle des deux voies vous voulez, vous montre le plan avant que quoi que ce soit ne coûte
de l'argent, et ne vous demande jamais votre phrase de récupération.

> Une phrase de récupération contrôle tout le compte. casty n'en a jamais besoin : `--fid` configure
> sans elle, et la clé est approuvée par votre portefeuille dans `casty web`. Si vous utilisez quand
> même `casty init` avec une phrase, utilisez un compte de test et ne la saisissez que dans un
> logiciel de développeurs en qui vous avez confiance.

## Comment l'ensemble s'articule

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/architecture-dark.png">
  <img src="docs/src/assets/architecture-light.png" width="880" alt="Votre terminal et votre navigateur ou téléphone joignent votre propre nœud de lecture Snapchain par un tunnel SSH ou HTTPS ; le nœud détient une copie complète de Farcaster et diffuse vos messages aux validateurs.">
</picture>

Les lectures viennent de votre nœud, donc le fil est aussi rapide que la machine sur laquelle il
tourne. Les écritures sont signées sur votre machine et relayées par votre nœud. Rien ne passe par
une API Farcaster hébergée.

## Sur un ordinateur portable et sur un téléphone

<p>
  <img src="docs/src/assets/desktop-feed-light.png" width="600" alt="Le fil sur un ordinateur portable, thème clair">
  <img src="docs/src/assets/phone-mentions-dark.png" width="240" alt="Les mentions sur un téléphone, thème sombre">
</p>
<p>
  <img src="docs/src/assets/desktop-compose-dark.png" width="600" alt="Un nouveau cast sur un ordinateur portable, thème sombre">
  <img src="docs/src/assets/phone-feed-light.png" width="240" alt="Le fil sur un téléphone, thème clair">
</p>

`./bin/casty web` sert le fil, les fils de discussion, les mentions, les profils et une zone de
rédaction sur `http://127.0.0.1:3390` et affiche un lien qui appaire un navigateur ;
`--listen 0.0.0.0:3390` ajoute un code QR pour un téléphone sur le même réseau.
`./scripts/1-node.sh serve --domain <name>` fait tourner la même page sur l'hôte du nœud derrière
HTTPS, avec des notifications push pour les mentions et les réponses, pour qu'un téléphone lise et
écrive depuis n'importe quel réseau.

## Dans le terminal

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

| Commande | Ce qu'elle fait |
| --- | --- |
| `./scripts/deploy.sh` | les étapes 0, 1 et 2 dans l'ordre, et la page sur l'hôte avec `--domain` ou `--tailscale` |
| `./scripts/0-provision.sh` | un serveur, un volume de 2 To et un pare-feu chez Hetzner ou AWS, ou `--host user@ip` pour le vôtre |
| `./scripts/1-node.sh` | Snapchain sur l'hôte, l'attente de sa synchronisation, un tunnel SSH ; `status`, `logs`, `upgrade`, `serve`, `down` |
| `./scripts/2-client.sh` | `casty` dans `./bin`, vérifié contre les sommes de contrôle de la version, une clé d'application, votre fil |
| `casty feed`, `mentions`, `thread` | lire, depuis votre nœud, avec des numéros que la commande suivante reprend |
| `casty cast`, `reply`, `like`, `recast`, `follow`, `delete` | écrire, à travers votre nœud, confirmé une fois relu |
| `casty web`, `casty serve` | la page, sur cette machine ou sur l'hôte |
| `casty doctor`, `whoami`, `key list`, `storage` | la synchronisation du nœud, votre compte, vos clés, votre stockage |

[Commandes](https://castyfun.github.io/casty/fr/commands/) explique chacune d'elles et ses options ;
chaque script et chaque commande accepte aussi `--help`.

## Sans nœud

Le nœud Snapchain factice dans `test/mock-node` sert la même API HTTP à partir de fixtures et vérifie
la signature de chaque message qui lui est soumis, si bien que tout le client fonctionne hors ligne :

```sh
pnpm install --frozen-lockfile
pnpm demo       # a throwaway app key, the feed with and without one app, a cast, a like
pnpm demo:web   # the same, then casty web until Ctrl-C
```

Les fixtures utilisent la phrase de test BIP-39 `test test test test test test test test test test test
junk` et des fids à partir de 2000000001, qui n'appartiennent à personne.

## Développement

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src
pnpm --filter @casty/docs dev                    # the website at localhost:4321
```

`make check` fonctionne hors ligne et a besoin de `shellcheck`, `jq` et `yq` (mikefarah) en plus de
Node 22.12+ et pnpm. La CI l'exécute sous Linux et les suites shell avec le bash 3.2 de macOS, plus
`pnpm audit` et une vérification des liens. Les tests sur nœud réel dans `client/test/e2e` ne
s'exécutent que si `CASTY_E2E_NODE_URL` est défini.

| Chemin | Contenu |
| --- | --- |
| `scripts/` | les trois étapes, `deploy.sh` et `demo.sh`, leurs bibliothèques et gabarits ; suites bats dans `scripts/tests` |
| `client/` | la CLI `casty` (TypeScript) et la page `casty web` dans `client/src/web` |
| `test/mock-node/` | le nœud Snapchain factice et son générateur de fixtures |
| `docs/` | le site et la documentation (Astro Starlight), en six langues |
| `llms.txt` | le projet pour les agents de programmation, avec la configuration en un seul prompt |

[SECURITY.md](SECURITY.md) liste chaque secret concerné, où il se trouve et comment le révoquer, et
comment signaler une vulnérabilité.

## Licence

casty est publié sous la [licence MIT](LICENSE). Le dépôt ne contient que le code propre de casty.
Snapchain, sous GPL-3.0, n'en fait pas partie : `1-node.sh` télécharge l'image Docker et le fichier
compose de Snapchain lui-même sur votre hôte et les y exécute. Le binaire `casty` en un seul fichier
de chaque version contient une vingtaine de paquets sous licence MIT et Apache-2.0, dont les avis
sont fournis à côté de lui dans `THIRD_PARTY_LICENSES`.
