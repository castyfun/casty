<div align="center" dir="rtl">

# casty

**عقدة قراءة Farcaster خاصة بك، وعميل يقرأ منها ويكتب من خلالها.**<br>
ثلاثة أوامر. بلا مفاتيح API، وبلا Ethereum RPC، وبلا رسوم غاز.

[![ci](https://github.com/castyfun/casty/actions/workflows/ci.yml/badge.svg)](https://github.com/castyfun/casty/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-c4390a)](LICENSE)
[![docs](https://img.shields.io/badge/docs-6%20languages-191813)](https://castyfun.github.io/casty/)

[English](README.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · العربية

<img src="docs/src/assets/hero.webp" width="880" alt="casty web على حاسوب محمول بالسمة الداكنة وعلى هاتف بالسمة الفاتحة">

**[الموقع والتوثيق](https://castyfun.github.io/casty/ar/)** · [كل الأوامر](https://castyfun.github.io/casty/ar/commands/) · [النشر بمساعدة وكيل](https://castyfun.github.io/casty/ar/agents/) · [llms.txt](llms.txt)

</div>

يضع casty عقدة قراءة [Snapchain](https://snapchain.farcaster.xyz)، وهي نسخة كاملة من Farcaster، على
مضيف تتحكم فيه، ويمنحك عميلًا لا يتصل بشيء غيرها: أمرًا في الطرفية وصفحة للمتصفح والهاتف. تُقرأ
تغذيتك وإشارات الذِكر وسلاسل المحادثة من عقدتك؛ وتخرج من خلالها منشوراتك وردودك وإعجاباتك وإعادات
النشر والمتابعات. يُضاف مفتاح التطبيق الذي يوقّعها برسالة واحدة توقّعها محفظتك: بلا معاملة، وبلا
رسوم غاز.

## البدء السريع

تحتاج إلى fid لحساب Farcaster تجريبي ومحفظة تحمل عنوان الحفظ الخاص به؛ ولعقدة جديدة أيضًا رمز Hetzner أو بيانات اعتماد AWS أو مضيف Linux بذاكرة 16 GB وقرص فارغ 2 TB.

الحساب الذي أُنشئ في تطبيق Farcaster يحفظ هذا العنوان داخل التطبيق لا في محفظة المتصفح: اعرض عبارة الاسترداد في التطبيق على هاتفك واستوردها مرة واحدة إلى MetaMask أو Rabby، أو أدخلها في `./bin/casty init` في طرفيتك الخاصة بدلًا من `casty web`.

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

أو من دون عقدة خاصة بك، على عقدة تعمل بالفعل:

```sh
# casty on a node that already runs
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
./bin/casty web                        # open the link; under "you": "add a key with your wallet"
./bin/casty feed                       # read; ./bin/casty cast "hello" writes
```


## ابدأ بأمر واحد

### عقدة جديدة خاصة بك

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/deploy.sh --fid <your fid> --domain node.example.org
```

يستأجر `deploy.sh` خادمًا مع قرص بسعة 2 TB وجدار حماية على Hetzner (`HCLOUD_TOKEN`) أو AWS
(بيانات اعتماد AWS CLI)، ويثبّت Snapchain وينتظر اكتمال مزامنته (بضع ساعات)، ويثبّت `casty`
على جهازك، ويضع الصفحة على المضيف خلف HTTPS. ويعرض ما سينشئه وما سيُحاسَب عليه، ولا يتابع إلا بعد
أن تؤكد. مع `--fid` لا تُكتب عبارة البذرة: أضف المفتاح في `./bin/casty web` حين يطلب ذلك، ثم شغّل
الأمر نفسه مجددًا للصفحة على المضيف. يمكن إعادة تشغيل كل خطوة بأمان: يتابع الأمر نفسه من حيث توقف
التشغيل السابق. ويصلح أيضًا جهاز Linux خاص بك بذاكرة 16 GB و2 TB من القرص الحر: أضف `-- --host user@ip`.

### casty على عقدة تعمل بالفعل

```sh
git clone https://github.com/castyfun/casty.git && cd casty
./scripts/2-client.sh --node https://snap.farcaster.xyz:3381 --fid <your fid>
```

بلا خادم وبلا انتظار: يتصل casty بواجهة HTTP API لأي عقدة Snapchain، عقدة لك على جهاز آخر أو عقدة
عامة، ويتذكرها لكل أمر لاحق. ثم شغّل `./bin/casty web` واضغط، تحت «you»، على «add a key with your wallet».

### دع وكيلًا يقوم بذلك

الصق الموجّه (prompt) من [النشر بمساعدة وكيل](https://castyfun.github.io/casty/ar/agents/) في
Claude Code أو Codex أو Cursor أو أي وكيل برمجة آخر. يقرأ [llms.txt](llms.txt)، ويسألك أيّ الطريقتين
تريد، ويعرض عليك الخطة قبل أن يكلّف أي شيء مالًا، ولا يطلب منك عبارة البذرة أبدًا.

> عبارة البذرة تتحكم في الحساب كله. لا يحتاج casty إليها أبدًا: يُعِدّ `--fid` كل شيء بدونها،
> وتأذن محفظتك بالمفتاح في `casty web`. وإن استخدمت `casty init` مع عبارة، فاستخدم حساب اختبار،
> ولا تكتبها إلا في برامج من مطورين تثق بهم.

## كيف تترابط الأجزاء

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/architecture-dark.png">
  <img src="docs/src/assets/architecture-light.png" width="880" alt="تصل طرفيتك ومتصفحك أو هاتفك إلى عقدة قراءة Snapchain الخاصة بك عبر نفق SSH أو HTTPS؛ تحتفظ العقدة بنسخة كاملة من Farcaster وتمرر رسائلك إلى المدقِّقين عبر gossip.">
</picture>

تأتي القراءات من عقدتك، فتكون التغذية بسرعة الجهاز الذي تعمل عليه. وتُوقَّع الكتابات على جهازك
وتنقلها عقدتك. لا يمر شيء عبر واجهة Farcaster API مستضافة.

## على حاسوب محمول وعلى هاتف

<p>
  <img src="docs/src/assets/desktop-feed-light.png" width="600" alt="التغذية على حاسوب محمول، السمة الفاتحة">
  <img src="docs/src/assets/phone-mentions-dark.png" width="240" alt="إشارات الذِكر على هاتف، السمة الداكنة">
</p>
<p>
  <img src="docs/src/assets/desktop-compose-dark.png" width="600" alt="منشور جديد على حاسوب محمول، السمة الداكنة">
  <img src="docs/src/assets/phone-feed-light.png" width="240" alt="التغذية على هاتف، السمة الفاتحة">
</p>

يقدّم `./bin/casty web` التغذية وسلاسل المحادثة وإشارات الذِكر والملفات الشخصية ومربع كتابة على
`http://127.0.0.1:3390`، ويطبع رابطًا يقرن المتصفح؛ ويضيف `--listen 0.0.0.0:3390` رمز QR لهاتف
على الشبكة نفسها. ويشغّل `./scripts/1-node.sh serve --domain <name>` الصفحة نفسها على مضيف العقدة خلف
HTTPS، مع إشعارات دفع لإشارات الذِكر والردود، فيقرأ الهاتف ويكتب من أي شبكة.

## في الطرفية

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

| الأمر | ما يفعله |
| --- | --- |
| `./scripts/deploy.sh` | الخطوات 0 و1 و2 بالترتيب، والصفحة على المضيف مع `--domain` أو `--tailscale` |
| `./scripts/0-provision.sh` | خادم وقرص بسعة 2 TB وجدار حماية على Hetzner أو AWS، أو `--host user@ip` لجهازك |
| `./scripts/1-node.sh` | Snapchain على المضيف، وانتظار مزامنته، ونفق SSH؛ `status` و`logs` و`upgrade` و`serve` و`down` |
| `./scripts/2-client.sh` | `casty` في `./bin`، مُتحقَّق منه مقابل المجاميع الاختبارية للإصدار، ومفتاح تطبيق، وتغذيتك |
| `casty feed`، `mentions`، `thread` | القراءة، من عقدتك، مع أرقام يأخذها الأمر التالي |
| `casty cast`، `reply`، `like`، `recast`، `follow`، `delete` | الكتابة، من خلال عقدتك، مع التأكيد حين تُقرأ مجددًا |
| `casty web`، `casty serve` | الصفحة، على هذا الجهاز أو على المضيف |
| `casty doctor`، `whoami`، `key list`، `storage` | مزامنة العقدة، وحسابك، ومفاتيحك، وتخزينك |

تشرح صفحة [الأوامر](https://castyfun.github.io/casty/ar/commands/) كل واحد منها وخياراته؛ ويقبل
كل سكربت وكل أمر أيضًا `--help`.

## بدون عقدة

تقدّم عقدة Snapchain الوهمية في `test/mock-node` واجهة HTTP API نفسها من بيانات ثابتة، وتتحقق من
توقيع كل رسالة تُرسل إليها، فيعمل العميل كله دون اتصال:

```sh
pnpm install --frozen-lockfile
pnpm demo       # a throwaway app key, the feed with and without one app, a cast, a like
pnpm demo:web   # the same, then casty web until Ctrl-C
```

تستخدم البيانات الثابتة عبارة الاختبار BIP-39 `test test test test test test test test test test test
junk` ومعرّفات fid تبدأ من 2000000001، ولا تخص أحدًا.

## التطوير

```sh
make check                                       # lint, types, tests, shellcheck, bats, docs
pnpm --filter @casty/client test -- --coverage   # fails below 95 % of lines on client/src
pnpm --filter @casty/docs dev                    # the website at localhost:4321
```

يعمل `make check` دون اتصال ويحتاج إلى `shellcheck` و`jq` و`yq` (mikefarah) إلى جانب Node 22.12 أو أحدث
وpnpm. يشغّله CI على Linux، ويشغّل مجموعات الصدفة على bash 3.2 في macOS، إضافة إلى `pnpm audit` وفحص
للروابط. لا تعمل الاختبارات على عقدة حقيقية في `client/test/e2e` إلا عند ضبط `CASTY_E2E_NODE_URL`.

| المسار | المحتوى |
| --- | --- |
| `scripts/` | الخطوات الثلاث و`deploy.sh` و`demo.sh`، ومكتباتها وقوالبها؛ مجموعات bats في `scripts/tests` |
| `client/` | أداة `casty` لسطر الأوامر (TypeScript) وصفحة `casty web` في `client/src/web` |
| `test/mock-node/` | عقدة Snapchain الوهمية ومولّد بياناتها الثابتة |
| `docs/` | الموقع والتوثيق (Astro Starlight)، بست لغات |
| `llms.txt` | المشروع لوكلاء البرمجة، مع الإعداد بموجّه واحد |

يسرد [SECURITY.md](SECURITY.md) كل سر معني، وأين يوجد، وكيف يُلغى، وكيف تُبلّغ عن ثغرة.

## الترخيص

يُنشر casty بموجب [رخصة MIT](LICENSE). لا يحتوي المستودع إلا على شيفرة casty نفسها. أما Snapchain،
المرخّص بـ GPL-3.0، فليس جزءًا منه: ينزّل `1-node.sh` صورة Docker الخاصة بـ Snapchain وملف compose
الخاص به إلى مضيفك ويشغّلهما هناك. ويضم ملف `casty` التنفيذي الواحد في كل إصدار نحو عشرين حزمة برخصتي
MIT وApache-2.0، وتأتي إشعاراتها بجانبه في `THIRD_PARTY_LICENSES`.
