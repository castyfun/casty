# casty

[English](README.md) · Русский · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md)

Ваша собственная read-нода Farcaster и клиент командной строки, который читает из неё и пишет через неё.
Без API-ключей, без Ethereum RPC на обычном пути, без ончейн-транзакции для ключа приложения.

Документация на шести языках: https://castyfun.github.io/casty/ru/ · все команды с описанием: https://castyfun.github.io/casty/ru/commands/

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

Или по шагам, которые и запускает `deploy.sh`:

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

Seed-фраза управляет всем аккаунтом. Для этого руководства используйте тестовый аккаунт,
вставляйте seed-фразу только в программы разработчиков, которым доверяете, и предпочитайте ключ,
одобренный кошельком: `./scripts/2-client.sh --fid <fid>` (или `deploy.sh --fid <fid>`), затем
`./bin/casty web` и в разделе о вас «add a key with your wallet».

| Шаг | Что нужно | Что остаётся после |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` и `HCLOUD_TOKEN`, либо `aws` CLI с учётными данными; `~/.ssh/id_ed25519.pub` | хост и `node.env` |
| `1-node.sh` | `ssh` и `jq`; хост с 16 ГБ RAM, диском 2 ТБ, Docker (cloud-init ставит его сам) | синхронизированная read-нода и туннель |
| `2-client.sh` | `curl`; fid тестового аккаунта со storage unit и его seed-фраза или кошелёк. С `--from-source`: Node 22.12 или новее и pnpm через corepack | `./bin/casty`, один файл, с ключом приложения |

Каждый шаг можно запускать повторно, поэтому `deploy.sh` продолжает с того места, где запуск
остановился: первая синхронизация занимает часы, и Ctrl-C во время неё ничего не теряет.
`deploy.sh --tailscale` открывает страницу через ваш tailnet вместо домена; без обоих флагов он
останавливается после клиента. Пока не выпущен первый релиз, шагу 2 нечего скачивать, и он собирает
клиент здесь, для этого нужен Node 22.12 или новее. Каждый скрипт понимает `--help`.
`0-provision.sh --dry-run` и `1-node.sh --dry-run` печатают каждую команду вместо её выполнения;
настоящий запуск `0-provision.sh` показывает, что он создаст и за что будет выставлен счёт, и
продолжает только после того, как вы введёте имя сервера. Первая синхронизация скачивает снимок в
несколько сотен ГБ и занимает часы; `./scripts/1-node.sh status` показывает, насколько отстаёт
каждый шард.

`./bin/casty --help` перечисляет команды клиента: `doctor`, `init`, `whoami`, `feed`, `mentions`,
`thread`, `cast`, `reply`, `like` и `unlike`, `recast` и `unrecast`, `follow` и `unfollow`, `delete`,
`clients`, `storage`, `key list`, `key revoke`, `node status`, `web` и `serve`, который на хосте
запускает `1-node.sh serve`. С `casty init --fid <fid>` seed-фраза не вводится вовсе: ключ добавляет
страница кошельком в браузере. Иначе фраза используется один раз, чтобы подписать запрос ключа, и
никогда не записывается на диск. Ключ приложения хранится зашифрованным (scrypt, XChaCha20-Poly1305)
в `~/.config/casty/keys.enc.json`. [SECURITY.md](SECURITY.md) перечисляет каждый задействованный
секрет, где он лежит и как его отозвать.

## В браузере и на телефоне

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="casty web на телефоне, светлая тема: пронумерованная лента">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="casty web на телефоне, тёмная тема: каст, на что он отвечает, и ответ на него">
</p>

`./bin/casty web` отдаёт команды CLI как страницу на `http://127.0.0.1:3390`, кроме удаления ключей,
и печатает ссылку, которая связывает браузер с сервером; в разделе о вас страница добавляет ключ
приложения вашим кошельком. `--listen 0.0.0.0:3390` добавляет QR-код для телефона в той же сети.
Подробности в [docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx).

`./scripts/1-node.sh serve --domain <name>` (или `--tailscale`) запускает ту же страницу на хосте ноды
за HTTPS, так что телефон читает и пишет из любой сети: клиент собирается там в контейнере, Caddy сам
получает сертификат (порты 80 и 443 открывает `0-provision.sh --https`), а ключ приложения и его пароль
попадают на хост как Docker-секрет, если не указан `--read-only`. Там лента берётся из индекса, который
следует за событиями ноды, а упоминание или ответ приходят на телефон push-уведомлением с именем
отправителя и ничем больше. Подробности и компромисс в
[docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx).

## Без ноды

Mock-нода в `test/mock-node` отдаёт HTTP API Snapchain из фикстур, проверяет подписи присланных
сообщений и применяет их, так что весь клиент работает офлайн. `pnpm demo` (после `pnpm install`)
запускает её на свободном порту, добавляет ключ приложения с тестовой фразой, читает ленту с одним
приложением и без него, публикует каст и в конце удаляет свой временный конфиг:

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

`pnpm demo:web` делает ту же подготовку, а затем отдаёт `casty web` на свободном порту до Ctrl-C.

`via` называет приложение, которое запросило ключ, подписавший каст; `--only-app` и `--exclude-app`
фильтруют по нему. Число перед кастом принимают `like`, `reply`, `recast` и `delete`, как и
`<fid>:<hash>` или ссылку каста на farcaster.xyz. По шагам:

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

В фикстурах эталонная фраза BIP-39 выше владеет fid 2000000001. `CASTY_PASSPHRASE` существует для
тестов; без неё casty спрашивает пароль в терминале. `pnpm mock-node gen --fids 300 --casts 50 --seed 42`
пишет набор побольше в `test/mock-node/fixtures/generated`, который отдаётся командой
`pnpm mock-node serve --fixtures generated`.

## Проверки

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

`make check` работает офлайн и требует `shellcheck`, `jq` и `yq` (mikefarah) помимо Node и pnpm;
lychee используется, если установлен. CI также считает покрытие и, ещё и еженедельно, запускает
`pnpm audit`. Ссылки документации между страницами работают на сайте, а не при чтении `.mdx` на GitHub.
Тесты на реальной ноде в `client/test/e2e` запускаются только при заданных `CASTY_E2E_NODE_URL` и
`CASTY_E2E_MNEMONIC` (фраза тестового аккаунта); с `CASTY_E2E_READ_FID`, аккаунтом, который упоминали
и которому отвечали, они проверяют и ответы ноды, на которые опирается клиент.

## Структура

| Путь | Что там |
| --- | --- |
| `scripts/` | три шага, `deploy.sh` и `demo.sh`, их библиотеки и шаблоны; bats-наборы в `scripts/tests` |
| `client/` | CLI `casty` (TypeScript) и страница `casty web` в `client/src/web` |
| `test/mock-node/` | mock-нода Snapchain и её генератор фикстур |
| `test/fakebin/` | поддельные `hcloud`, `aws`, `cherryctl`, `ssh`, `sudo`, `docker`, `curl`, `crontab`, `cloud-init`, `tailscale` для bats-наборов |
| `docs/` | сайт документации (Astro Starlight) |
| `SECURITY.md` | секреты, что доступно извне, что делать при утечке |

`1-node.sh --autoupgrade` ставит еженедельное задание обновления Snapchain, которое выполняет
`docker system prune --volumes -f` на всём хосте. В Windows запускайте скрипты в WSL2.

Лицензия MIT. Snapchain (GPL-3.0) скачивается и запускается на вашем хосте и никогда не включается в
этот репозиторий. В релизном бинарнике около двадцати пакетов под MIT и Apache-2.0; их уведомления
лежат рядом с ним в `THIRD_PARTY_LICENSES`.
