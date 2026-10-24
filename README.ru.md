<div align="center">

# casty

**Ваша собственная read-нода Farcaster и клиент, который читает из неё и пишет через неё.**<br>
Три команды. Без API-ключей, без Ethereum RPC, без газа.

[![ci](https://github.com/castyfun/casty/actions/workflows/ci.yml/badge.svg)](https://github.com/castyfun/casty/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-c4390a)](LICENSE)
[![docs](https://img.shields.io/badge/docs-6%20languages-191813)](https://castyfun.github.io/casty/)

[English](README.md) · Русский · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md)

<img src="docs/src/assets/hero.webp" width="880" alt="casty web на ноутбуке в тёмной теме и на телефоне в светлой теме">

**[Сайт и документация](https://castyfun.github.io/casty/ru/)** · [Все команды](https://castyfun.github.io/casty/ru/commands/) · [Развернуть с агентом](https://castyfun.github.io/casty/ru/agents/) · [llms.txt](llms.txt)

</div>

casty ставит read-ноду [Snapchain](https://snapchain.farcaster.xyz), полную копию Farcaster, на
хост, которым вы управляете, и даёт вам клиент, который ни с чем больше не общается: команду для
терминала и страницу для браузера и телефона. Ваша лента, упоминания и треды читаются с вашей ноды;
ваши касты, ответы, лайки, рекасты и подписки уходят через неё. Ключ приложения, который их
подписывает, добавляется одним сообщением, которое подписывает ваш кошелёк: без транзакции, без газа.

## Быстрый старт

Нужны fid тестового аккаунта Farcaster и кошелёк с его custody-адресом; для новой ноды ещё токен Hetzner, ключи AWS или Linux-хост с 16 ГБ RAM и 2 ТБ свободного диска.

У аккаунта, созданного в приложении Farcaster, этот адрес хранится в самом приложении, а не в браузерном кошельке: откройте его фразу восстановления в приложении на телефоне и один раз импортируйте её в MetaMask или Rabby, либо вместо `casty web` введите её в `./bin/casty init` в своём терминале.

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

Или без своей ноды, на уже работающей:

```sh
# casty on a node that already runs
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
```


## Начните с одной команды

### Новая собственная нода

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --fid <your fid> --domain node.example.org
```

`deploy.sh` арендует сервер с томом 2 ТБ и файрволом у Hetzner (`HCLOUD_TOKEN`) или AWS
(учётные данные AWS CLI), ставит Snapchain и ждёт его синхронизации (несколько часов), ставит `casty`
на вашу машину и запускает страницу на хосте за HTTPS. Он показывает, что создаст и за что будет
выставлен счёт, и продолжает только после вашего подтверждения. С `--fid` seed-фраза не вводится:
добавьте ключ в `./bin/casty web`, когда он об этом попросит, затем запустите ту же команду снова
для страницы на хосте. Каждый шаг можно безопасно запускать повторно: та же команда продолжает с
того места, где запуск остановился. Подойдёт и ваша собственная машина с Linux, 16 ГБ RAM и 2 ТБ
свободного места: добавьте `-- --host user@ip`.

### casty на уже работающей ноде

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
```

Ни сервера, ни ожидания: casty подключается к HTTP API любой ноды Snapchain, вашей на другой
машине или публичной, и запоминает её для всех следующих команд. Затем запустите `./bin/casty web`
и в разделе «you» нажмите «add a key with your wallet».

### Поручите это агенту

Вставьте промпт со страницы [Развернуть с агентом](https://castyfun.github.io/casty/ru/agents/) в
Claude Code, Codex, Cursor или другой агент для программирования. Он читает [llms.txt](llms.txt),
спрашивает, какой из двух вариантов вам нужен, показывает план, прежде чем что-либо начнёт стоить
денег, и никогда не просит вашу seed-фразу.

> Seed-фраза управляет всем аккаунтом. casty она не нужна: `--fid` настраивает всё без неё,
> а ключ одобряет ваш кошелёк в `casty web`. Если вы всё же используете `casty init` с фразой,
> возьмите тестовый аккаунт и вводите её только в программы разработчиков, которым доверяете.

## Как это устроено

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/architecture-dark.png">
  <img src="docs/src/assets/architecture-light.png" width="880" alt="Ваш терминал и ваш браузер или телефон обращаются к вашей собственной read-ноде Snapchain через SSH-туннель или HTTPS; нода хранит полную копию Farcaster и передаёт ваши сообщения валидаторам.">
</picture>

Чтение идёт с вашей ноды, поэтому лента работает так быстро, как машина, на которой нода запущена.
Записи подписываются на вашей машине и передаются дальше вашей нодой. Ничего не проходит через
хостинговый API Farcaster.

## На ноутбуке и на телефоне

<p>
  <img src="docs/src/assets/desktop-feed-light.png" width="600" alt="Лента на ноутбуке, светлая тема">
  <img src="docs/src/assets/phone-mentions-dark.png" width="240" alt="Упоминания на телефоне, тёмная тема">
</p>
<p>
  <img src="docs/src/assets/desktop-compose-dark.png" width="600" alt="Новый каст на ноутбуке, тёмная тема">
  <img src="docs/src/assets/phone-feed-light.png" width="240" alt="Лента на телефоне, светлая тема">
</p>

`./bin/casty web` отдаёт ленту, треды, упоминания, профили и поле для нового каста на
`http://127.0.0.1:3390` и печатает ссылку, которая связывает браузер; `--listen 0.0.0.0:3390` добавляет
QR-код для телефона в той же сети. `./scripts/1-node.sh serve --domain <name>` запускает ту же
страницу на хосте ноды за HTTPS, с push-уведомлениями об упоминаниях и ответах, так что телефон
читает и пишет из любой сети.

## В терминале

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

| Команда | Что делает |
| --- | --- |
| `./scripts/deploy.sh` | шаги 0, 1 и 2 по порядку и страницу на хосте с `--domain` или `--tailscale` |
| `./scripts/0-provision.sh` | сервер, том 2 ТБ и файрвол у Hetzner или AWS либо `--host user@ip` для вашей собственной машины |
| `./scripts/1-node.sh` | Snapchain на хосте, ожидание его синхронизации, SSH-туннель; `status`, `logs`, `upgrade`, `serve`, `down` |
| `./scripts/2-client.sh` | `casty` в `./bin`, проверенный по контрольным суммам релиза, ключ приложения, ваша лента |
| `casty feed`, `mentions`, `thread` | чтение с вашей ноды, с номерами, которые принимает следующая команда |
| `casty cast`, `reply`, `like`, `recast`, `follow`, `delete` | запись через вашу ноду, подтверждённая, как только она прочитана обратно |
| `casty web`, `casty serve` | страница, на этой машине или на хосте |
| `casty doctor`, `whoami`, `key list`, `storage` | синхронизация ноды, ваш аккаунт, ваши ключи, ваше хранилище |

[Команды](https://castyfun.github.io/casty/ru/commands/) описывают каждую из них и её
параметры; каждый скрипт и каждая команда также понимают `--help`.

## Без ноды

Mock-нода Snapchain в `test/mock-node` отдаёт тот же HTTP API из фикстур и проверяет подпись
каждого присланного ей сообщения, так что весь клиент работает офлайн:

```sh
pnpm install --frozen-lockfile
pnpm demo       # a throwaway app key, the feed with and without one app, a cast, a like
pnpm demo:web   # the same, then casty web until Ctrl-C
```

Фикстуры используют тестовую фразу BIP-39 `test test test test test test test test test test test
junk` и fid начиная с 2000000001, которые никому не принадлежат.

## Разработка

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src
pnpm --filter @casty/docs dev                    # the website at localhost:4321
```

`make check` работает офлайн и требует `shellcheck`, `jq` и `yq` (mikefarah) помимо Node 22.12+
и pnpm. CI запускает его на Linux, а наборы для оболочки на bash 3.2 из macOS, плюс `pnpm audit` и
проверку ссылок. Тесты на реальной ноде в `client/test/e2e` запускаются только при заданном
`CASTY_E2E_NODE_URL`.

| Путь | Что там |
| --- | --- |
| `scripts/` | три шага, `deploy.sh` и `demo.sh`, их библиотеки и шаблоны; bats-наборы в `scripts/tests` |
| `client/` | CLI `casty` (TypeScript) и страница `casty web` в `client/src/web` |
| `test/mock-node/` | mock-нода Snapchain и её генератор фикстур |
| `docs/` | сайт и документация (Astro Starlight) на шести языках |
| `llms.txt` | проект для агентов, с настройкой одним промптом |

[SECURITY.md](SECURITY.md) перечисляет каждый задействованный секрет, где он лежит и как его отозвать,
а также как сообщить об уязвимости.

## Лицензия

casty распространяется под [лицензией MIT](LICENSE). Репозиторий содержит только собственный код casty.
Snapchain, распространяемый под GPL-3.0, в него не входит: `1-node.sh` скачивает собственный Docker-образ
и compose-файл Snapchain на ваш хост и запускает их там. Однофайловый бинарник `casty` каждого релиза
включает около двадцати пакетов под MIT и Apache-2.0, уведомления которых поставляются рядом с ним в
`THIRD_PARTY_LICENSES`.
