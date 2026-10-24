<div align="center">

# casty

**Tu propio nodo de lectura de Farcaster y un cliente que lee de él y escribe a través de él.**<br>
Tres comandos. Sin claves de API, sin RPC de Ethereum, sin gas.

[![ci](https://github.com/castyfun/casty/actions/workflows/ci.yml/badge.svg)](https://github.com/castyfun/casty/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-c4390a)](LICENSE)
[![docs](https://img.shields.io/badge/docs-6%20languages-191813)](https://castyfun.github.io/casty/)

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · Español · [Français](README.fr.md) · [العربية](README.ar.md)

<img src="docs/src/assets/hero.webp" width="880" alt="casty web en un portátil con el tema oscuro y en un teléfono con el tema claro">

**[Sitio web y documentación](https://castyfun.github.io/casty/es/)** · [Todos los comandos](https://castyfun.github.io/casty/es/commands/) · [Despliegue con un agente](https://castyfun.github.io/casty/es/agents/) · [llms.txt](llms.txt)

</div>

casty pone un nodo de lectura de [Snapchain](https://snapchain.farcaster.xyz), una copia completa de
Farcaster, en un host que tú controlas, y te da un cliente que no habla con nada más: un comando de
terminal y una página para el navegador y el teléfono. Tu feed, tus menciones y tus hilos se leen de
tu nodo; tus casts, respuestas, likes, recasts y follows salen a través de él. La clave de aplicación
que los firma se añade con un solo mensaje que firma tu billetera: sin transacción, sin gas.

## Inicio rápido

Necesitas el fid de una cuenta de prueba de Farcaster y una billetera que tenga su dirección de custodia; para un nodo nuevo, además, un token de Hetzner, credenciales de AWS o un host Linux con 16 GB de RAM y 2 TB libres.

Una cuenta creada en la app de Farcaster guarda esa dirección en la propia app, no en una billetera del navegador: muestra su frase de recuperación en la app del teléfono e impórtala una vez en MetaMask o Rabby, o escríbela en `./bin/casty init` en tu propia terminal en lugar de usar `casty web`.

```sh
# a new node of your own
git clone https://github.com/castyfun/casty.git && cd casty
export HCLOUD_TOKEN=<token>            # Hetzner; or AWS credentials, or 0-provision.sh --host user@ip
./scripts/0-provision.sh               # (0) compute: a server, a 2 TB volume, a firewall
./scripts/1-node.sh                    # (1) a Snapchain read node, synced (hours), and a tunnel
./scripts/2-client.sh --fid <your fid> # (2) a client, ./bin/casty, reading from your node
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
./scripts/0-provision.sh --destroy     # when you are done: server, volume and firewall go
```

O sin nodo propio, en uno que ya funciona:

```sh
# casty on a node that already runs
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
```


## Empieza con un solo comando

### Un nodo nuevo, tuyo

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --fid <your fid> --domain node.example.org
```

`deploy.sh` alquila un servidor con un volumen de 2 TB y un firewall en Hetzner (`HCLOUD_TOKEN`) o AWS
(credenciales de la AWS CLI), instala Snapchain y espera a que se sincronice (unas horas), instala
`casty` en tu máquina y pone la página en el host detrás de HTTPS. Muestra lo que va a crear y
facturar, y solo sigue adelante cuando lo confirmas. Con `--fid` no se teclea ninguna frase semilla:
añade la clave en `./bin/casty web` cuando te lo diga, y luego vuelve a ejecutar el mismo comando para
la página en el host. Cada paso se puede volver a ejecutar sin riesgo: el mismo comando retoma donde
se detuvo una ejecución. También sirve una máquina Linux propia con 16 GB de RAM y 2 TB libres:
añade `-- --host user@ip`.

### casty en un nodo que ya funciona

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
```

Sin servidor y sin espera: casty se conecta a la API HTTP de cualquier nodo Snapchain, uno tuyo en
otra máquina o uno público, y lo recuerda para todos los comandos posteriores. Luego ejecuta
`./bin/casty web` y, en «you», pulsa «add a key with your wallet».

### Deja que lo haga un agente

Pega el prompt de [Despliegue con un agente](https://castyfun.github.io/casty/es/agents/) en
Claude Code, Codex, Cursor u otro agente de programación. Lee [llms.txt](llms.txt), te pregunta cuál
de las dos opciones quieres, te muestra el plan antes de que nada cueste dinero y nunca te pide la
frase semilla.

> Una frase semilla controla toda la cuenta. casty nunca la necesita: `--fid` lo configura sin ella,
> y la clave la aprueba tu billetera en `casty web`. Si usas `casty init` con una frase, usa una
> cuenta de prueba y tecléala solo en software de desarrolladores en los que confíes.

## Cómo encaja todo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/architecture-dark.png">
  <img src="docs/src/assets/architecture-light.png" width="880" alt="Tu terminal y tu navegador o teléfono llegan a tu propio nodo de lectura de Snapchain por un túnel SSH o por HTTPS; el nodo guarda una copia completa de Farcaster y propaga tus mensajes a los validadores.">
</picture>

Las lecturas vienen de tu nodo, así que el feed es tan rápido como la máquina en la que funciona. Las
escrituras se firman en tu máquina y tu nodo las retransmite. Nada pasa por una API de Farcaster
alojada.

## En un portátil y en un teléfono

<p>
  <img src="docs/src/assets/desktop-feed-light.png" width="600" alt="El feed en un portátil, tema claro">
  <img src="docs/src/assets/phone-mentions-dark.png" width="240" alt="Las menciones en un teléfono, tema oscuro">
</p>
<p>
  <img src="docs/src/assets/desktop-compose-dark.png" width="600" alt="Un cast nuevo en un portátil, tema oscuro">
  <img src="docs/src/assets/phone-feed-light.png" width="240" alt="El feed en un teléfono, tema claro">
</p>

`./bin/casty web` sirve el feed, los hilos, las menciones, los perfiles y un cuadro de redacción en
`http://127.0.0.1:3390` e imprime un enlace que empareja un navegador; `--listen 0.0.0.0:3390` añade
un código QR para un teléfono en la misma red. `./scripts/1-node.sh serve --domain <name>` ejecuta la
misma página en el host del nodo detrás de HTTPS, con notificaciones push para menciones y
respuestas, de modo que un teléfono lee y escribe desde cualquier red.

## En la terminal

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

| Comando | Qué hace |
| --- | --- |
| `./scripts/deploy.sh` | los pasos 0, 1 y 2 en orden, y la página en el host con `--domain` o `--tailscale` |
| `./scripts/0-provision.sh` | un servidor, un volumen de 2 TB y un firewall en Hetzner o AWS, o `--host user@ip` para el tuyo |
| `./scripts/1-node.sh` | Snapchain en el host, la espera de su sincronización, un túnel SSH; `status`, `logs`, `upgrade`, `serve`, `down` |
| `./scripts/2-client.sh` | `casty` en `./bin`, comprobado con las sumas de verificación de la versión, una clave de aplicación, tu feed |
| `casty feed`, `mentions`, `thread` | leer, de tu nodo, con números que toma el comando siguiente |
| `casty cast`, `reply`, `like`, `recast`, `follow`, `delete` | escribir, a través de tu nodo, confirmado en cuanto se vuelve a leer |
| `casty web`, `casty serve` | la página, en esta máquina o en el host |
| `casty doctor`, `whoami`, `key list`, `storage` | la sincronización del nodo, tu cuenta, tus claves, tu almacenamiento |

[Comandos](https://castyfun.github.io/casty/es/commands/) explica cada uno de ellos y sus opciones;
cada script y cada comando también acepta `--help`.

## Sin un nodo

El nodo Snapchain simulado en `test/mock-node` sirve la misma API HTTP desde fixtures y comprueba la
firma de cada mensaje que se le envía, así que el cliente entero funciona sin conexión:

```sh
pnpm install --frozen-lockfile
pnpm demo       # a throwaway app key, the feed with and without one app, a cast, a like
pnpm demo:web   # the same, then casty web until Ctrl-C
```

Los fixtures usan la frase de prueba BIP-39 `test test test test test test test test test test test
junk` y fids a partir de 2000000001, que no pertenecen a nadie.

## Desarrollo

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src
pnpm --filter @casty/docs dev                    # the website at localhost:4321
```

`make check` funciona sin conexión y necesita `shellcheck`, `jq` y `yq` (mikefarah) además de Node
22.12+ y pnpm. CI lo ejecuta en Linux, y las suites de shell en el bash 3.2 de macOS, además de
`pnpm audit` y una comprobación de enlaces. Las pruebas con un nodo real en `client/test/e2e` solo se
ejecutan cuando `CASTY_E2E_NODE_URL` está definida.

| Ruta | Qué es |
| --- | --- |
| `scripts/` | los tres pasos, `deploy.sh` y `demo.sh`, sus bibliotecas y plantillas; suites bats en `scripts/tests` |
| `client/` | la CLI `casty` (TypeScript) y la página `casty web` en `client/src/web` |
| `test/mock-node/` | el nodo Snapchain simulado y su generador de fixtures |
| `docs/` | el sitio web y la documentación (Astro Starlight), en seis idiomas |
| `llms.txt` | el proyecto para agentes de programación, con la configuración de un solo prompt |

[SECURITY.md](SECURITY.md) enumera cada secreto involucrado, dónde vive y cómo revocarlo, y cómo
informar de una vulnerabilidad.

## Licencia

casty se publica bajo la [licencia MIT](LICENSE). El repositorio solo contiene el código propio de
casty. Snapchain, que es GPL-3.0, no forma parte de él: `1-node.sh` descarga la imagen de Docker y el
archivo compose propios de Snapchain en tu host y los ejecuta allí. El binario `casty` de un solo
archivo de cada versión lleva dentro unos veinte paquetes MIT y Apache-2.0, cuyos avisos se
distribuyen junto a él en `THIRD_PARTY_LICENSES`.
