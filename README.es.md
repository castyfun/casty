# casty

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · Español · [Français](README.fr.md) · [العربية](README.ar.md)

Tu propio nodo de lectura de Farcaster y un cliente de línea de comandos que lee de él y escribe a
través de él. Sin claves de API, sin RPC de Ethereum en el camino normal, sin transacción en cadena
para la clave de aplicación.

Documentación en seis idiomas: https://castyfun.github.io/casty/es/ · todos los comandos explicados: https://castyfun.github.io/casty/es/commands/

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

O paso a paso, que es lo que ejecuta `deploy.sh`:

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

Una frase semilla controla toda la cuenta. Usa una cuenta de prueba para este tutorial, pega una
frase semilla solo en software de desarrolladores en los que confíes y prefiere una clave autorizada
por tu billetera: `./scripts/2-client.sh --fid <fid>` (o `deploy.sh --fid <fid>`), luego
`./bin/casty web` y, en tu cuenta, "add a key with your wallet".

| Paso | Qué necesitas | Con qué te deja |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` y `HCLOUD_TOKEN`, o la CLI `aws` con credenciales; `~/.ssh/id_ed25519.pub` | un host y `node.env` |
| `1-node.sh` | `ssh` y `jq`; un host con 16 GB de RAM, 2 TB de disco y Docker (cloud-init lo instala) | un nodo de lectura sincronizado y un túnel |
| `2-client.sh` | `curl`; el fid de una cuenta de prueba con una storage unit, y su frase semilla o una billetera. Con `--from-source`: Node 22.12 o más reciente y pnpm a través de corepack | `./bin/casty`, un solo archivo, con una clave de aplicación |

Cada paso se puede volver a ejecutar sin riesgo, así que `deploy.sh` retoma donde se detuvo una
ejecución: la primera sincronización lleva horas, y Ctrl-C durante ella no pierde nada.
`deploy.sh --tailscale` llega a la página a través de tu tailnet en lugar de un dominio; sin ninguno
de los dos, se detiene después del cliente. Hasta que se etiquete la primera versión, el paso 2 no
encuentra nada que descargar y en su lugar compila el cliente aquí, lo que requiere Node 22.12 o más
reciente. Cada script acepta `--help`. `0-provision.sh --dry-run` y `1-node.sh --dry-run` imprimen
cada comando en lugar de ejecutarlo; una ejecución real de `0-provision.sh` enumera lo que creará y
facturará, y solo sigue adelante cuando escribes de vuelta el nombre del servidor. La primera
sincronización descarga una instantánea de varios cientos de GB y lleva horas;
`./scripts/1-node.sh status` muestra cuánto va retrasado cada shard.

`./bin/casty --help` enumera los comandos del cliente: `doctor`, `init`, `whoami`, `feed`, `mentions`,
`thread`, `cast`, `reply`, `like` y `unlike`, `recast` y `unrecast`, `follow` y `unfollow`, `delete`,
`clients`, `storage`, `key list`, `key revoke`, `node status`, `web` y `serve`, que `1-node.sh serve`
ejecuta en el host. Con `casty init --fid <fid>` la frase semilla nunca se teclea: la página añade
la clave con la billetera en el navegador. En otro caso, la frase se usa una sola vez para firmar la
solicitud de clave y nunca se escribe en disco. La clave de aplicación se guarda cifrada (scrypt,
XChaCha20-Poly1305) en `~/.config/casty/keys.enc.json`. [SECURITY.md](SECURITY.md) enumera cada
secreto involucrado, dónde vive y cómo revocarlo.

## En un navegador y en un teléfono

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="casty web en un teléfono, tema claro: el feed numerado">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="casty web en un teléfono, tema oscuro: un cast con lo que responde y su respuesta">
</p>

`./bin/casty web` sirve los comandos de la CLI como una página en `http://127.0.0.1:3390`, salvo
quitar claves, e imprime un enlace que empareja un navegador; en tu cuenta añade una clave de
aplicación con tu billetera. `--listen 0.0.0.0:3390` añade un código QR para un teléfono en la misma
red. [docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx) tiene los detalles.

`./scripts/1-node.sh serve --domain <name>` (o `--tailscale`) ejecuta la misma página en el host del
nodo detrás de HTTPS, de modo que un teléfono lee y escribe desde cualquier red: el cliente se compila
allí en un contenedor, Caddy obtiene el certificado (abre 80 y 443 con `0-provision.sh --https`), y la
clave de aplicación y su contraseña van al host como un secreto de Docker salvo con `--read-only`. Allí
el feed sale de un índice que sigue los eventos del nodo, y una mención o una respuesta llega al teléfono
como una notificación push que nombra al remitente y nada más.
[docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx) tiene los detalles y la contrapartida.

## Sin un nodo

El nodo simulado en `test/mock-node` sirve la API HTTP de Snapchain desde fixtures, comprueba las
firmas de los mensajes enviados y los fusiona, así que el cliente entero funciona sin conexión.
`pnpm demo` (tras `pnpm install`) arranca uno en un puerto libre, añade una clave de aplicación con la
frase de prueba, lee el feed con y sin una aplicación, publica un cast y al final borra su configuración
temporal:

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

`pnpm demo:web` hace la misma preparación y luego sirve `casty web` en un puerto libre hasta Ctrl-C.

`via` nombra la aplicación que solicitó la clave con la que se firmó un cast; `--only-app` y
`--exclude-app` filtran por ella. El número delante de un cast es lo que toman `like`, `reply`, `recast`
y `delete`, igual que `<fid>:<hash>` o el enlace del cast en farcaster.xyz. Paso a paso:

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

En los fixtures, la frase de referencia BIP-39 de arriba posee el fid 2000000001. `CASTY_PASSPHRASE`
existe para las pruebas; sin ella casty pregunta en la terminal. `pnpm mock-node gen --fids 300 --casts 50 --seed 42`
escribe un conjunto mayor en `test/mock-node/fixtures/generated`, servido con
`pnpm mock-node serve --fixtures generated`.

## Comprobaciones

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

`make check` funciona sin conexión y necesita `shellcheck`, `jq` y `yq` (mikefarah) además de Node y
pnpm; lychee se usa cuando está instalado. CI también ejecuta la cobertura y, además semanalmente,
`pnpm audit`. Los enlaces de la documentación entre páginas funcionan en el sitio, no al leer los
archivos `.mdx` en GitHub. Las pruebas con nodo real en `client/test/e2e` solo se ejecutan cuando
`CASTY_E2E_NODE_URL` y `CASTY_E2E_MNEMONIC` (la frase de una cuenta de prueba) están definidas; con
`CASTY_E2E_READ_FID`, una cuenta que ha sido mencionada y respondida, también comprueban las
respuestas del nodo en las que se apoya el cliente.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `scripts/` | los tres pasos, `deploy.sh` y `demo.sh`, sus bibliotecas y plantillas; suites bats en `scripts/tests` |
| `client/` | la CLI `casty` (TypeScript) y la página `casty web` en `client/src/web` |
| `test/mock-node/` | el nodo Snapchain simulado y su generador de fixtures |
| `test/fakebin/` | `hcloud`, `aws`, `cherryctl`, `ssh`, `sudo`, `docker`, `curl`, `crontab`, `cloud-init`, `tailscale` falsos para las suites bats |
| `docs/` | el sitio de documentación (Astro Starlight) |
| `SECURITY.md` | secretos, exposición, qué hacer si algo se filtra |

`1-node.sh --autoupgrade` instala la tarea semanal de actualización de Snapchain, que ejecuta
`docker system prune --volumes -f` en todo el host. En Windows, ejecuta los scripts en WSL2.

Licencia MIT. Snapchain (GPL-3.0) se descarga y se ejecuta en tu host; nunca se incluye aquí. El
binario de la versión publicada lleva dentro unos veinte paquetes MIT y Apache-2.0; sus avisos están
en `THIRD_PARTY_LICENSES`, junto a él.
