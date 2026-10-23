# casty

[English](README.md) · [Русский](README.ru.md) · 中文 · [Español](README.es.md) · [Français](README.fr.md) · [العربية](README.ar.md)

你自己的 Farcaster 只读节点，以及一个从它读取、通过它写入的命令行客户端。
不需要 API 密钥，常规路径上不需要 Ethereum RPC，应用密钥也不需要链上交易。

六种语言的文档：https://savvax.github.io/casty/zh-cn/ · 全部命令及说明：https://savvax.github.io/casty/zh-cn/commands/

```sh
git clone https://github.com/savvax/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

也可以分步运行，`deploy.sh` 执行的就是这些步骤：

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

助记词掌控整个账户。跟着本教程操作时请使用测试账户，只把助记词粘贴到你信任的开发者所写的软件中，
并优先使用由钱包授权的密钥：`./scripts/2-client.sh --fid <fid>`（或 `deploy.sh --fid <fid>`），
然后运行 `./bin/casty web`，在“你”页面中选择 “add a key with your wallet”。

| 步骤 | 需要什么 | 得到什么 |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` 和 `HCLOUD_TOKEN`，或 `aws` CLI 及其凭据；`~/.ssh/id_ed25519.pub` | 一台主机和 `node.env` |
| `1-node.sh` | `ssh` 和 `jq`；一台有 16 GB 内存、2 TB 磁盘和 Docker（cloud-init 会安装）的主机 | 一个已同步的只读节点和一条隧道 |
| `2-client.sh` | `curl`；一个测试账户的 fid，带 storage unit，以及它的助记词或一个钱包。使用 `--from-source` 时：Node 22.12 或更新版本，以及通过 corepack 提供的 pnpm | `./bin/casty`，单个文件，带应用密钥 |

每一步都可以安全地重复运行，所以 `deploy.sh` 会从上次中断的地方继续：首次同步需要数小时，期间按
Ctrl-C 不会丢失任何东西。`deploy.sh --tailscale` 通过你的 tailnet 而不是域名访问页面；两者都不指定时，
它在客户端这一步之后停止。在第一个发布版打上标签之前，第 2 步找不到可下载的内容，会改为在本机构建
客户端，这需要 Node 22.12 或更新版本。每个脚本都接受 `--help`。`0-provision.sh --dry-run` 和
`1-node.sh --dry-run` 只打印每条命令而不执行；真正运行 `0-provision.sh` 时会列出将要创建和计费的内容，
只有你把服务器名称输回去之后才会继续。首次同步会下载几百 GB 的快照，需要数小时；
`./scripts/1-node.sh status` 显示每个分片落后多少。

`./bin/casty --help` 列出客户端命令：`doctor`、`init`、`whoami`、`feed`、`mentions`、`thread`、
`cast`、`reply`、`like` 和 `unlike`、`recast` 和 `unrecast`、`follow` 和 `unfollow`、`delete`、
`clients`、`storage`、`key list`、`key revoke`、`node status`、`web`，以及由 `1-node.sh serve` 在主机上
运行的 `serve`。使用 `casty init --fid <fid>` 时完全不需要输入助记词：页面会在浏览器中用钱包添加密钥。
否则，助记词只用一次，用来签署密钥请求，从不写入磁盘。应用密钥以加密形式（scrypt，
XChaCha20-Poly1305）保存在 `~/.config/casty/keys.enc.json`。
[SECURITY.md](SECURITY.md) 列出了涉及的每一个机密、它存放的位置以及如何撤销。

## 在浏览器和手机上

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="手机上的 casty web，浅色主题：带编号的时间线">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="手机上的 casty web，深色主题：一条 cast、它所回复的内容和对它的回复">
</p>

`./bin/casty web` 把 CLI 的命令（删除密钥除外）作为页面提供在 `http://127.0.0.1:3390`，并打印一个
用于配对浏览器的链接；在“你”页面中，它会用你的钱包添加应用密钥。`--listen 0.0.0.0:3390` 会为同一
网络中的手机加上二维码。详见 [docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx)。

`./scripts/1-node.sh serve --domain <name>`（或 `--tailscale`）在节点主机上以 HTTPS 运行同一个页面，
手机可以从任何网络读写：客户端在那里的容器中构建，Caddy 获取证书（用 `0-provision.sh --https`
打开 80 和 443 端口），除非指定 `--read-only`，否则应用密钥及其口令会作为 Docker secret 送到主机。
在那里，时间线来自一个跟随节点事件的索引，提及或回复会以推送通知到达手机，通知里只有发送者的名字。
详情与取舍见 [docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx)。

## 没有节点时

`test/mock-node` 中的模拟节点用预置数据提供 Snapchain HTTP API，检查提交消息的签名并合并它们，
因此整个客户端可以离线运行。`pnpm demo`（先 `pnpm install`）会在空闲端口启动一个模拟节点，用测试
助记词添加应用密钥，分别在包含和排除一个应用的情况下读取时间线，发一条 cast，最后删除临时配置：

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

`pnpm demo:web` 做同样的准备，然后在空闲端口提供 `casty web`，直到按下 Ctrl-C。

`via` 给出请求了签署这条 cast 的密钥的应用；`--only-app` 和 `--exclude-app` 据此过滤。cast 前面的
数字是 `like`、`reply`、`recast` 和 `delete` 接受的参数，也可以用 `<fid>:<hash>` 或这条 cast 在
farcaster.xyz 上的链接。分步操作：

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

在预置数据中，上面的 BIP-39 参考助记词拥有 fid 2000000001。`CASTY_PASSPHRASE` 只为测试而存在；
没有它时 casty 会在终端询问。`pnpm mock-node gen --fids 300 --casts 50 --seed 42` 会向
`test/mock-node/fixtures/generated` 写入更大的数据集，用 `pnpm mock-node serve --fixtures generated` 提供。

## 检查

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

`make check` 离线运行，除 Node 和 pnpm 外还需要 `shellcheck`、`jq` 和 `yq`（mikefarah）；
安装了 lychee 时也会用到它。CI 还会运行覆盖率检查，并且每周运行 `pnpm audit`。文档页面之间的链接
在站点上有效，在 GitHub 上直接阅读 `.mdx` 文件时无效。`client/test/e2e` 中的真实节点测试只在设置了
`CASTY_E2E_NODE_URL` 和 `CASTY_E2E_MNEMONIC`（测试账户的助记词）时运行；再加上
`CASTY_E2E_READ_FID`（一个被提及和被回复过的账户），它们还会检查客户端所依赖的节点应答。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `scripts/` | 三个步骤、`deploy.sh` 和 `demo.sh`、它们的库和模板；bats 测试集在 `scripts/tests` |
| `client/` | `casty` CLI（TypeScript）和 `client/src/web` 中的 `casty web` 页面 |
| `test/mock-node/` | 模拟 Snapchain 节点及其预置数据生成器 |
| `test/fakebin/` | 供 bats 测试集使用的假 `hcloud`、`aws`、`cherryctl`、`ssh`、`sudo`、`docker`、`curl`、`crontab`、`cloud-init`、`tailscale` |
| `docs/` | 文档站点（Astro Starlight） |
| `SECURITY.md` | 机密、暴露面、泄露时该怎么做 |

`1-node.sh --autoupgrade` 安装 Snapchain 的每周升级任务，它会在整台主机上运行
`docker system prune --volumes -f`。在 Windows 上请在 WSL2 中运行这些脚本。

MIT 许可。Snapchain（GPL-3.0）在你的主机上下载并运行，从不打包进本仓库。发布版二进制文件内含
大约二十个 MIT 和 Apache-2.0 许可的软件包；它们的许可声明在同目录下的 `THIRD_PARTY_LICENSES` 中。
