# casty

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · العربية

عقدة قراءة Farcaster خاصة بك، وعميل سطر أوامر يقرأ منها ويكتب من خلالها.
بلا مفاتيح API، وبلا Ethereum RPC في المسار المعتاد، وبلا معاملة على السلسلة لمفتاح التطبيق.

التوثيق بست لغات: https://savvax.github.io/casty/ar/ · شرح جميع الأوامر: https://savvax.github.io/casty/ar/commands/

```sh
git clone https://github.com/savvax/casty.git && cd casty
./scripts/deploy.sh --domain node.example.org   # all of the below, in order, and the page on the host behind HTTPS
```

أو خطوة بخطوة، وهو ما يشغّله `deploy.sh`:

```sh
./scripts/0-provision.sh   # a VM, 2 TB volume and firewall on Hetzner or AWS, whichever credentials are set; or --host user@ip
./scripts/1-node.sh        # Snapchain read node, wait for sync, SSH tunnel to 127.0.0.1:3381
./scripts/2-client.sh      # download casty, add a gasless app key with your wallet (--fid) or seed phrase, read your feed
```

عبارة البذرة تتحكم في الحساب كله. استخدم حساب اختبار لهذا الدليل، ولا تلصق عبارة البذرة إلا في
برامج من مطورين تثق بهم، وفضّل مفتاحًا تأذن به محفظتك: `./scripts/2-client.sh --fid <fid>`
(أو `deploy.sh --fid <fid>`)، ثم `./bin/casty web`، ومن صفحتك اختر «add a key with your wallet».

| الخطوة | ما تحتاجه | ما يبقى لك |
| --- | --- | --- |
| `0-provision.sh` | `hcloud` و`HCLOUD_TOKEN`، أو أداة `aws` مع بيانات الاعتماد؛ و`~/.ssh/id_ed25519.pub` | مضيف وملف `node.env` |
| `1-node.sh` | `ssh` و`jq`؛ مضيف بذاكرة 16 GB وقرص 2 TB وDocker (يثبّته cloud-init) | عقدة قراءة متزامنة ونفق |
| `2-client.sh` | `curl`؛ معرّف fid لحساب اختبار له storage unit، وعبارة البذرة الخاصة به أو محفظة. مع `--from-source`: Node 22.12 أو أحدث وpnpm عبر corepack | `./bin/casty`، ملف واحد، مع مفتاح تطبيق |

يمكن إعادة تشغيل كل خطوة بأمان، لذا يتابع `deploy.sh` من حيث توقف التشغيل السابق: تستغرق المزامنة
الأولى ساعات، والضغط على Ctrl-C أثناءها لا يُضيع شيئًا. يصل `deploy.sh --tailscale` إلى الصفحة عبر
شبكة tailnet الخاصة بك بدل نطاق؛ وبدون أي منهما يتوقف بعد العميل. إلى أن يُوسَم أول إصدار، لا تجد
الخطوة 2 ما تنزّله فتبني العميل هنا بدلًا من ذلك، وهذا يحتاج إلى Node 22.12 أو أحدث. كل سكربت يقبل
`--help`. يطبع `0-provision.sh --dry-run` و`1-node.sh --dry-run` كل أمر بدل تنفيذه؛ أما التشغيل الفعلي
لـ `0-provision.sh` فيعرض ما سينشئه وما سيُحاسَب عليه، ولا يتابع إلا بعد أن تكتب اسم الخادم مجددًا.
تنزّل المزامنة الأولى لقطة بحجم عدة مئات من GB وتستغرق ساعات؛ ويعرض `./scripts/1-node.sh status`
مقدار تأخر كل شريحة.

يعرض `./bin/casty --help` أوامر العميل: `doctor` و`init` و`whoami` و`feed` و`mentions` و`thread` و`cast`
و`reply` و`like` و`unlike` و`recast` و`unrecast` و`follow` و`unfollow` و`delete` و`clients` و`storage`
و`key list` و`key revoke` و`node status` و`web`، و`serve` الذي يشغّله `1-node.sh serve` على المضيف. مع
`casty init --fid <fid>` لا تُكتب عبارة البذرة أبدًا: تضيف الصفحة المفتاح بالمحفظة في المتصفح. وإلا
فتُستخدم العبارة مرة واحدة لتوقيع طلب المفتاح ولا تُكتب على القرص أبدًا. يُحفظ مفتاح التطبيق مشفرًا
(scrypt وXChaCha20-Poly1305) في `~/.config/casty/keys.enc.json`.
يسرد [SECURITY.md](SECURITY.md) كل سر معني، وأين يوجد، وكيف يُلغى.

## في المتصفح وعلى الهاتف

<p>
  <img src="docs/src/assets/web-phone-light.png" width="260" alt="casty web على هاتف، السمة الفاتحة: التغذية المرقّمة">
  <img src="docs/src/assets/web-phone-dark.png" width="260" alt="casty web على هاتف، السمة الداكنة: منشور مع ما يرد عليه والرد عليه">
</p>

يقدّم `./bin/casty web` أوامر سطر الأوامر كصفحة على `http://127.0.0.1:3390`، عدا إزالة المفاتيح، ويطبع
رابطًا يقرن المتصفح؛ ومن صفحتك يضيف مفتاح تطبيق بمحفظتك. يضيف `--listen 0.0.0.0:3390` رمز QR لهاتف
على الشبكة نفسها. التفاصيل في [docs/src/content/docs/web.mdx](docs/src/content/docs/web.mdx).

يشغّل `./scripts/1-node.sh serve --domain <name>` (أو `--tailscale`) الصفحة نفسها على مضيف العقدة خلف HTTPS،
فيقرأ الهاتف ويكتب من أي شبكة: يُبنى العميل هناك داخل حاوية، ويحصل Caddy على الشهادة (افتح المنفذين 80
و443 بـ `0-provision.sh --https`)، وينتقل مفتاح التطبيق وكلمة مروره إلى المضيف كسر Docker ما لم تحدد
`--read-only`. هناك تأتي التغذية من فهرس يتابع أحداث العقدة، ويصل الذِكر أو الرد إلى الهاتف كإشعار دفع
يذكر اسم المرسل ولا شيء غيره. التفاصيل والمقايضة في
[docs/src/content/docs/serve.mdx](docs/src/content/docs/serve.mdx).

## بدون عقدة

تقدّم العقدة الوهمية في `test/mock-node` واجهة Snapchain HTTP API من بيانات ثابتة، وتتحقق من تواقيع
الرسائل المرسلة وتدمجها، فيعمل العميل كله دون اتصال. يشغّل `pnpm demo` (بعد `pnpm install`) عقدة على
منفذ حر، ويضيف مفتاح تطبيق بعبارة الاختبار، ويقرأ التغذية مع تطبيق واحد وبدونه، وينشر منشورًا، ثم يحذف
إعداداته المؤقتة في النهاية:

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

يقوم `pnpm demo:web` بالتهيئة نفسها، ثم يقدّم `casty web` على منفذ حر حتى الضغط على Ctrl-C.

يذكر `via` التطبيق الذي طلب المفتاح الذي وُقّع به المنشور؛ ويرشّح `--only-app` و`--exclude-app` بحسبه.
الرقم أمام المنشور هو ما تقبله `like` و`reply` و`recast` و`delete`، وكذلك `<fid>:<hash>` أو رابط المنشور على
farcaster.xyz. خطوة بخطوة:

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

في البيانات الثابتة، تملك عبارة BIP-39 المرجعية أعلاه المعرّف fid 2000000001. يوجد `CASTY_PASSPHRASE`
للاختبارات؛ وبدونه يسأل casty في الطرفية. يكتب `pnpm mock-node gen --fids 300 --casts 50 --seed 42`
مجموعة أكبر في `test/mock-node/fixtures/generated`، تُقدَّم بالأمر `pnpm mock-node serve --fixtures generated`.

## الفحوصات

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src, cli/ excluded
pnpm --filter @casty/docs dev                    # the documentation site at localhost:4321
```

يعمل `make check` دون اتصال ويحتاج إلى `shellcheck` و`jq` و`yq` (mikefarah) إلى جانب Node وpnpm؛ ويُستخدم
lychee إن كان مثبتًا. يشغّل CI أيضًا فحص التغطية، وأسبوعيًا كذلك، `pnpm audit`. تعمل روابط التوثيق بين
الصفحات على الموقع، لا عند قراءة ملفات `.mdx` على GitHub. لا تعمل اختبارات العقدة الحقيقية في
`client/test/e2e` إلا عند ضبط `CASTY_E2E_NODE_URL` و`CASTY_E2E_MNEMONIC` (عبارة حساب اختبار)؛ ومع
`CASTY_E2E_READ_FID`، وهو حساب ذُكر ورُدّ عليه، تتحقق أيضًا من إجابات العقدة التي يعتمد عليها العميل.

## البنية

| المسار | المحتوى |
| --- | --- |
| `scripts/` | الخطوات الثلاث و`deploy.sh` و`demo.sh`، ومكتباتها وقوالبها؛ مجموعات bats في `scripts/tests` |
| `client/` | أداة `casty` (TypeScript) وصفحة `casty web` في `client/src/web` |
| `test/mock-node/` | عقدة Snapchain الوهمية ومولّد بياناتها الثابتة |
| `test/fakebin/` | نسخ وهمية من `hcloud` و`aws` و`cherryctl` و`ssh` و`sudo` و`docker` و`curl` و`crontab` و`cloud-init` و`tailscale` لمجموعات bats |
| `docs/` | موقع التوثيق (Astro Starlight) |
| `SECURITY.md` | الأسرار، وما هو مكشوف، وما يجب فعله عند تسريب شيء |

يثبّت `1-node.sh --autoupgrade` مهمة الترقية الأسبوعية لـ Snapchain، التي تشغّل
`docker system prune --volumes -f` على المضيف كله. على Windows، شغّل السكربتات داخل WSL2.

مرخّص برخصة MIT. يُنزَّل Snapchain (GPL-3.0) ويُشغَّل على مضيفك، ولا يُضمَّن هنا أبدًا. يحتوي
الملف التنفيذي للإصدار على نحو عشرين حزمة برخصتي MIT وApache-2.0؛ وإشعاراتها في `THIRD_PARTY_LICENSES`
بجانبه.
