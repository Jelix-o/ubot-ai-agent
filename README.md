# UBot · 会仙群聊机器人

基于 NapCat / OneBot、Node.js 22、TypeScript 和 Vue 的 QQ 群机器人与管理控制台。支持群聊、看图、显式记忆、知识查询、BT 搜索、生图、静态网页、提醒、日报和节日倒计时。

本页是统一使用与运维手册。下载与历史更新见 [GitHub Releases](https://github.com/Jelix-o/ubot-ai-agent/releases)。必要的数据核验说明随资源保留，开发指令保留在 `AGENTS.md`。

## 目录

- [功能与架构](#features)
- [安装与开发](#quickstart)
- [配置](#configuration)
- [群聊指令](#commands)
- [BT 搜索与依赖](#bt)
- [模型与权限](#models)
- [成员称呼、记忆与知识](#memory)
- [后台账号与恢复](#accounts)
- [部署与健康检查](#deployment)
- [数据迁移与维护](#migration)
- [备份与回滚](#recovery)
- [验证与发布](#release)
- [本版更新](#changes)

<a id="features"></a>
## 功能与架构

```text
NapCat / OneBot
  → Ingress：入站去重、QQ 发送、真实回执、静默撤回
  ↔ SQLite WAL：唯一业务权威源与持久化发件箱
  ← Worker：对话、模型路由、记忆、知识和定时任务
  ↔ Admin：账号、群授权、配置、审计和管理 API
```

生产由 `ubot.target` 管理 Ingress、Worker、Admin 三个进程，发布通过 `current` 软链接切换。发送结果未知不自动重放，避免重复消息。

会仙是唯一启用的人格，保持自然、有分寸的聊天方式，不编造照片、位置、见面或外部执行结果。人格在后台维护，基线是 `assets/huixian-profile.json`。旧人格市场、运行时 Skill 切换、自动记忆抽取、语音、唱歌和 TTS 已退休。

<a id="quickstart"></a>
## 安装与开发

需要 Node.js 22+、npm、已配置 OneBot 的 NapCat；BT 另需 Python 与浏览器。

```bash
npm ci
cp .env.example .env
# 编辑本地 .env，填写机器人、NapCat、模型及后台配置。
npm run migrate:v3                 # 预览迁移计划
npm run migrate:v3 -- --execute    # 备份并停止其他写入者后执行
npm run dev
```

另开终端运行 `npm run dev:admin` 启动 Vue 开发服务器。Windows 用 `Copy-Item .env.example .env` 复制配置。生产安装与升级使用正式 Release 包，见 [部署](#deployment)。

<a id="configuration"></a>
## 配置

模板见 [.env.example](.env.example) 和 [.env.server-2022.example](.env.server-2022.example)。真实 `.env`、数据库、凭据、Cookie 和缓存不进入 Git 或发布包。

| 配置 | 用途 |
| --- | --- |
| `BOT_QQ` | 本地实际机器人账号 |
| `NAPCAT_MODE`、`NAPCAT_REVERSE_WS_*` | OneBot 连接和反向 WebSocket 监听 |
| `NAPCAT_ACCESS_TOKEN` | OneBot 鉴权；非本地 Ingress 监听必须设置 |
| `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` | 初始回复模型连接，后续在后台维护 |
| `ADMIN_HTTP_ENABLED`、`ADMIN_HTTP_HOST`、`ADMIN_HTTP_PORT` | 生产为 `true`、`127.0.0.1`、`6200` |
| `INGRESS_READ_API_PORT`、`INGRESS_READ_API_TOKEN` | 内部读接口；生产为 `6198`、仅本机访问，并使用独立的至少 32 随机字节 Bearer token |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 账户表为空时创建首个超管，密码至少 12 位 |
| `UBOT_STATE_ENCRYPTION_KEY` | 恰好 32 字节主密钥，以 64 位十六进制或 base64url 编码 |
| `HTML_PREVIEW_PUBLIC_BASE_URL`、`HTML_PREVIEW_ROOT` | 独立预览域与持久页面目录 |
| `UBOT_BT_PYTHON`、`UBOT_BT_BROWSER_PATH`、`UBOT_BT_PROXY` | BT Python、浏览器和可选代理 |

主密钥在本地受控配置或秘密管理器保存，不放入命令行、日志、Issue 或 Actions。`ADMIN_SESSION_SECRET`、`ADMIN_TOTP_ENCRYPTION_KEY`、共享群密码和旧 QQ 管理员列表已退休。

<a id="commands"></a>
## 群聊指令

以下为默认名称；后台“指令设置”可调整主命令、别名、启停与权限。以当前账号的 `#帮助` 为准。默认用 `#`，BT 兼容 `/bt`。

| 入口 | 行为 |
| --- | --- |
| `@会仙 <内容>` | 普通成员对话、看图或联网查询 |
| 回复机器人消息 | 同群、真实回执确认的机器人消息可无 @ 追问 |
| `#功能` / `#帮助` / `#命令` | 查看有权使用的功能 |
| `#对话 清空` | 清空本人在当前群的短期上下文 |
| `#模型` / `#模型 状态` / `#模型 列表` | 成员查看生效模型 |
| `#模型 切换 <ID>` / `#模型 跟随` | 仅超管：设置本群例外或恢复统一默认 |
| `#记忆 <内容>` | 保存本人在当前群的显式记忆 |
| `@会仙 请记住 <内容>` / `请记忆 <内容>` | 同显式记忆指令，需 @ 或可信机器人引用 |
| `#bt <关键词> [anime\|movie\|adult]` / `/bt` | 无需 @，用合并转发卡片返回资源 |
| `#网页 <需求>` / `#html <需求>` | 生成静态预览，可对单群关闭 |
| `#画图 <提示词>` / `#生图 <提示词>` | 默认全员可用，指令设置可提高权限 |
| `#民营企业排名 <问题>` | 查询内置 2026 民营企业 500 强 |
| `#群知识库 <问题>` | 查询本群 FAQ；`#知识库` 为管理员状态命令 |

群管理、提醒、日报、节日倒计时、黑名单及上下文管理沿用后台授权，具体用法通过群内帮助查看。`#管理员`、`#语音`、`#唱歌` 和默认语音回复已退休。

功能遵循群启用、静默与黑名单规则。引用普通成员或未知消息不会单独唤起机器人。关键词须管理员配置对应参与模式，指定成员低频参与仅在 `selected_members` 模式启用。“机器人静音”停止普通对话、关键词、实时参与和复读，保留定时能力。

明确 `@会仙 生成网页/HTML/静态页面` 也会生成页面，普通提及网页不会发布。预览链接独立、约 30 天有效；后台只管理元数据与删除，不在后台域渲染生成 HTML。

生图提示词为 1–5000 个 Unicode 字符，默认一张 `1024x1024` 图片。每人每群成功后冷却 60 秒，失败不计。检查通过先提示生成中，成功只发图片。仅接受上游 Base64 PNG、JPEG、WebP；回执确认后删除临时文件，送达未知不自动重发。生图统一提供，无额外群级开关。

<a id="bt"></a>
## BT 搜索与依赖

`#bt <关键词> [anime|movie|adult]`，兼容 `/bt`。非黑名单成员在已启用、非静默群无需 @。默认推断类型，使用 Mikan、Nyaa、BTBTLA、1LOU、KPkuang、Sukebei 对应来源。前 5 条集中在一张 QQ 转发卡片，每条有标题、清晰度、体积、字幕、来源和完整链接。磁力原始编码及 Tracker 保留，链接单独成行供复制。

实际执行超过 5 秒才提示一次进度，快速完成或缓存命中直接返回卡片。空参数为 4 行帮助，`#bt --help` 查看全部参数。独立排队，不调用聊天模型、不进入对话记忆或上下文。

| 参数 | 行为 |
| --- | --- |
| `anime` / `movie` / `adult` | 指定类型，否则推断并保留无结果时类型回退 |
| `--fast` | 总预算 15 秒，默认单站 8 秒，足够结果提前返回 |
| `--full` / `--detail` | 最多 20 条及分站详情，`--limit` 可覆盖 |
| `--source mikan,nyaa,btbtla,onelou,kpkuang,sukebei` | 筛选当前类型可用来源 |
| `--timeout 8s` | 单站 1–60 秒，支持 ms/s/m；裸数为毫秒，默认 30 秒 |
| `--limit 1～20` | 返回数量，默认 5 |
| `--no-cache` / `--no-deep` | 跳过缓存 / 详情扩展 |
| `--json` / `--debug` | 同一卡片收纳 JSON / 诊断，列表不重复 |

例如 `#bt 葬送的芙莉莲 anime --fast`、`/bt 星际穿越 movie --source kpkuang,btbtla`。保留清晰度、字幕、集数和体积筛选语法。完整搜索总预算 180 秒，截止返回已有结果；全局单并发、最多等待 4 个请求。结果缓存 15 分钟，站点连续 3 次失败熔断 5 分钟。无结果、超时、验证页与依赖缺失分别提示。明确转发拒绝只降级一条短文本，发送未知或 ACK 保存失败不重发。

最终 `resolvedType === "adult"` 的卡片首节点第一行固定为：

> 【成人内容提示】含成人向资源，仅限成年人查看；请注意隐私并遵守当地法律。

成人卡片取得真实外层 QQ 回执后约 90 秒静默撤回；明确未派发只重试一次，任何新动作不晚于送达后 105 秒。撤回前后不提示。非成人、无结果和降级文本不创建撤回任务。

### 依赖安装

需要 Python 3.10+；固定 `curl_cffi==0.16.3`、`scrapling[fetchers]==0.4.15`，见 `assets/bt/requirements.txt`。首次浏览器系统依赖需要 sudo：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv
sudo node scripts/install-bt-deps.mjs --runtime-root /opt/ai-project/bt-runtime --python python3
sudo chown -R root:root /opt/ai-project/bt-runtime
sudo chmod -R a+rX,go-w /opt/ai-project/bt-runtime
```

```powershell
node scripts/install-bt-deps.mjs --runtime-root D:\UBot\bt-runtime --python python
```

Linux 生产运行用户为无登录、无 sudo、无 Docker 组权限的 `ubot`。BT 依赖树由 root 维护且只读；虚拟环境和浏览器放在应用持久目录，适配 `ProtectHome=yes`，不放 `/root` 或 `/home`。持久 `.env` 示例：

```dotenv
UBOT_BT_PYTHON=/opt/ai-project/bt-runtime/venv/bin/python
UBOT_BT_BROWSER_PATH=/opt/ai-project/bt-runtime/browsers
UBOT_BT_PROXY=socks5h://127.0.0.1:1080
```

Windows 使用 `venv\Scripts\python.exe` 和对应浏览器路径。可直连时省略代理；配置时使用已验证地址。浏览器把 `socks5h` 转为支持的 `socks5`，curl 层保留远程 DNS。

`data/bt/` 保存缓存、站点状态、Cookie 与 `browser-state/`，供运行用户写入，建议 `0700`。默认从实际持久 `data/` 相邻目录寻找 `bt-runtime/`，兼容软链接。发布包排除虚拟环境、浏览器、Cookie 和缓存。

```bash
sudo -u ubot env PLAYWRIGHT_BROWSERS_PATH=/opt/ai-project/bt-runtime/browsers \
  /opt/ai-project/bt-runtime/venv/bin/python -c "from scrapling.fetchers import StealthyFetcher; import curl_cffi; print('ready')"
```

<a id="models"></a>
## 模型与权限

超级管理员在“系统设置 → 对话回复”维护统一主模型、自动降级、备用顺序和超时；群配置支持例外或跟随。新群继承默认，成员与群管理员只读。初始顺序 Sol → GPT → DS，DS 使用 `deepseek-flash`。

聊天、看图、辅助判定、网页共用“当前群主模型＋全局备用”路由，去重并跳过停用、缺密钥、能力不匹配或策略禁止候选，看图只用视觉模型。网络、限流、异常、超时、空输出、解析失败和网页截断可降级；取消、内容拒绝及明确请求／认证错误终止。队列繁忙不降级。每个候选最多一次，参数协商、流式兼容和网页修复计入同一截止时间；仅交付最终结果，不发切换提示。

| 用途 | 默认单次 / 总预算 |
| --- | --- |
| 聊天 | 45 / 120 秒 |
| 网页 | 120 / 300 秒 |
| 辅助判定 | 4 / 10 秒 |

实际请求取模型超时、单次预算、剩余总预算的最小值。熔断按模型与连接隔离，连续失败 5 次暂停 30 秒，只放行一个恢复探测；P95 仅监测。生图保留独立主备，网络、超时、HTTP 408、429、5xx 可降级；日报等保留用途设置。

路由设置不足 1000px 上下排列，超时始终展开且以秒标注；模型抽屉连接超时以毫秒标注。关闭降级保留备用顺序。编辑按基本连接、调用参数、密钥与启用分组，保留密钥掩码。图片模型检测产生生成费用，“检测全部”跳过图片模型。

指令权限可选全员／群管理员／超级管理员，服务端校验权限下限、版本及操作身份。生图、聊天、BT、网页、帮助可全员；管理命令保留最低管理权限，模型切换最低超级管理员。主命令、别名、对应自然语言入口统一授权；停用或未授权命令仍被识别，避免误入聊天和对话分支。

<a id="memory"></a>
## 成员称呼、记忆与知识

成员抽屉分开维护“主称呼”“其他别名”“成员备注”。`names[0]` 是主称呼，其余仅为管理员明确保留的别名；保存完整替换，旧名、群名片和历史画像标题不自动合并。改名不改写画像，记忆始终按成员 QQ 归属。

支持“成员甲的常用语”“成员甲的聊天习惯”“我的爱好”等明确资料问句。目标须来自真实 @、回复成员、唯一后台称呼或明确本人；未知、重名、多目标和冲突先确认。称呼核对直接比较后台与真实群名片的 QQ 映射，必要时刷新目录最多 3 秒，不调用模型猜人。

只注入目标已批准、启用的 `member_profile`，隔离提问者画像、旧回答、引用正文和附近聊天。无画像或关闭记忆直接保守提示；普通提名、陈述、纯文本账号及词语解释不扩大第三方读取范围。画像可回答已有稳定资料；近期证据为空仅限制近期原话或行为。历史回答和成员自称不能覆盖本轮验证身份。

仅 `#记忆`、明确“请记住／请记忆”及管理员操作保存记忆，普通聊天不自动抽取。密码、API Key、令牌等明显凭据会被拒绝。隐私退出成员不新增或使用个人记忆，群管理员可设置退出，只有超级管理员可恢复。

### 群知识与榜单

`#群知识库 <问题>` 或 `@会仙 本群知识库里……` 只检索本群已启用 FAQ，无匹配明确说明，不查其他群。群管理员可改本群知识包命令；全局榜单命令仅超管可改，冲突拒绝保存。

`#民营企业排名 京东排第几`、`#民营企业排名 前十名` 或明确 @ 查询完整榜单名称，可确定性查询 2026 中国民营企业 500 强。默认 2026，按 2025 年营收排序，省份取榜单原列；名单按名次分批，简称歧义需确认。省略榜单名称的“前十名”走普通对话。

同一成员同群 10 分钟内可 @ 或回复机器人追问“分别是哪些”；切换话题、来源、超时或重启结束，其他成员不继承。后台榜单只读，不影响群 FAQ。总部城市未完成全部 500 家独立核验前不开放精确统计。

数据核验见 [榜单](assets/private-enterprises-2026-review.md) 和 [总部城市](assets/private-enterprises-2026-headquarters-review.md)。总部账本仅在全部证据归档、独立审核与 Ed25519 签名验证后标为 `complete`。验证公钥和 ID 分别用 `UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY`、`UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID` 配置；完成态打包时同值设置为 Actions 仓库变量并导入本地打包环境。部署器从持久 `.env` 只读这两个公钥字段，在停止服务前验证；私钥离线保存，签名无效拒绝发布或开放城市统计。

<a id="accounts"></a>
## 后台账号与恢复

后台使用独立账号、至少 12 位密码和邀请机制，无 TOTP／恢复码。邀请、账号启停、群授权、QQ 绑定及全局设置等敏感操作要求 10 分钟内密码复验。

| 身份 | 权限 |
| --- | --- |
| `super_admin` | 全局模型、管理员、授权、人格、能力、诊断和恢复隐私退出 |
| `group_admin` | 已授权群配置、备注、记忆、知识和任务，模型只读 |
| QQ 群主／群管 | 自动获得本群群内管理指令权限，不获得后台或跨群权限 |

后台账号绑定 QQ 后，群内继承角色和群授权；停用、解绑或撤销授权及时失效。旧管理员 QQ 列表和共享群密码不授予 V3 权限。

账户表为空时通过持久 `.env` 的 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 创建首个超管，登录后创建日常独立账号。忘记密码时在服务器交互终端运行：

```bash
cd /opt/ai-project-releases/current
npm run admin:reset-password -- --username <account> --data-dir /opt/ai-project
```

脚本要求 TTY 输入并确认新密码，撤销该账号全部会话并审计。不要手工改账号、会话或审计表，也不要恢复旧 JSON 鉴权。

<a id="deployment"></a>
## 部署与健康检查

### 持久目录与网络

| 路径 | 用途 |
| --- | --- |
| `/opt/ai-project/.env` | 持久配置与密钥，`root:ubot 0640` |
| `/opt/ai-project/data` | SQLite、加密归档、缓存；仅 `ubot` 可写 |
| `/var/lib/ubot-preview` | 预览静态页面；仅 `ubot` 可写，不是 release 子目录 |
| `/opt/ai-project/bt-runtime` | Python 虚拟环境与浏览器；root 维护、服务仅读 |
| `/opt/ai-project/release-backups` | 部署前受限备份 |
| `/opt/ai-project-releases/<version>` | root 拥有的只读独立发布目录 |
| `/opt/ai-project-releases/current` | 当前版本软链接 |

旧 `config/`、`skills/` 仅首次迁移输入，不链接到 V3 运行目录。旧 `ai-project.service` 保留用于人工灾难恢复，切换后禁用，不与 `ubot.target` 并行。

现有 Docker NapCat 连 `ws://172.21.0.1:6199/onebot/ws`，Ingress 监听 Docker 网关。`6198`、`6200` 仅 loopback；Ingress Read API 在所有非 loopback 检查上要求独立 Bearer token，健康检查仍供本机使用。NapCat 文件路径由操作者本地提供，公开示例用 `/opt/napcat/config/onebot11_<BOT_QQ>.json`，不得提交真实账号。

### 独立网页预览域

示例后台 `bot.9958.uk`，预览 `preview.9958.uk`。预览只提供静态内容，不代理 `6200`，不共享后台 Cookie 或 API。页面目录固定为 `/var/lib/ubot-preview`，不是版本目录；Worker 写入，Nginx 只读取 token 的页面文件。

两个 UBot 域名使用 Cloudflare Origin CA 证书，分别置于 `/etc/ssl/cloudflare/`，私钥由 `root:root` 持有并为 `0600` 或 `0640`。安装与部署预检会拒绝已经失效或七天内到期的证书。在 Cloudflare 控制台将整个 `9958.uk` Zone 的所有已代理域名完成有效源站证书预检后，才将 Zone 切换到 **Full (strict)**。该变更需要最小 Zone SSL/Origin CA/设置权限和变更窗口，令牌不写入服务器或仓库。

Origin hardening 只安装并影响 UBot 的两个 Nginx vhost：`/etc/nginx/sites-available/bot-9958`、`/etc/nginx/sites-available/preview-9958` 和专用 include。root 定时任务从 Cloudflare 验证并原子更新 CIDR include；更新、`nginx -t` 或 reload 失败时保留上一次有效配置。两站只接受 Cloudflare 源地址，并仅对可信 Cloudflare 请求恢复真实访客 IP；同机其他站点与 GCP 全局防火墙不在此改动范围。预览仅允许 GET／HEAD、token 路径，禁止目录与软链接遍历，返回 no-store、noindex、nosniff、CSP、sandbox 和 referrer 保护；删除后 404。

### 正式部署步骤

1. 同一正式 Release 下载匹配 tar.gz 和 `.sha256`，核对摘要。以 root 拥有、无符号链接且不可被组或其他用户写入的临时 bootstrap 目录解包；不得从旧的可写 `current` 目录运行特权安装脚本。
2. 在 Cloudflare 中完成所有已代理源站的 Origin CA 预检并切换为 Full (strict)。将两个已配对、覆盖正确域名的证书和私钥放入 `/etc/ssl/cloudflare/`；确认 `nginx -t`。这一步先于来源限制，避免切换中断其他已代理站点。
3. 先以 root 从已校验的 bootstrap 目录安装并校验独立 Node 22 运行时；再运行 UBot Origin hardening。该步骤创建 root 定时 CIDR 更新器并只限制两个 UBot vhost。不得将 Cloudflare 临时令牌保存到 `.env`、环境文件或命令历史。
4. 部署器创建受限 `ubot` 服务账户、固定运行时与只读 release，迁移预览目录并以原子方式更新配置、unit、Nginx 和 `current`。它在停止服务前备份状态，失败时恢复旧 release、unit、Nginx 和持久配置。

```bash
sudo bash /secure/bootstrap/ubot-3.0.49-linux/scripts/install-node22-runtime.sh 22.22.1
sudo env UBOT_CLOUDFLARE_STRICT_READY=1 \
  bash /secure/bootstrap/ubot-3.0.49-linux/scripts/install-cloudflare-origin-hardening.sh
sudo bash /secure/bootstrap/ubot-3.0.49-linux/scripts/deploy-linux-release.sh \
  3.0.49 /secure/bootstrap/ubot-3.0.49-linux.tar.gz
```

部署器验证正式资产、路径、权限、SQLite、Node 22、Origin hardening 和证书，备份持久状态、执行迁移，原子更新批准的 `network.websocketClients.0.url`、专用预览配置和 units，再切 `current` 并启动三项服务。它会为 Read API 配置独立 token，并轮询 Read API 的 JSON 健康结果、Admin 鉴权边界和三项服务重启计数；任一检查失败即回滚。已切换 V3 的升级不重导旧 JSON。`.env` 存在 UTF-8 BOM 时先逐字节受限备份，仅移除 BOM 并保留权限。

NapCat 不监听宿主 JSON 替换；部署器在 V3 active 检查后重启原运行的 `napcat` 容器（`UBOT_NAPCAT_CONTAINER` 可指定批准名称），等待 Docker running。恢复配置时也需受控重启，以重新加载 URL。

```bash
systemctl status ubot-ingress ubot-worker ubot-admin --no-pager
systemctl list-timers ubot-maintenance.timer ubot-cloudflare-allowlist.timer
systemctl show ubot-ingress ubot-worker ubot-admin -p NRestarts --no-pager
curl -I http://127.0.0.1:6200/api/health
curl -I https://preview.9958.uk/p/not-a-valid-token/
```

未登录 Admin health 返回 401 是预期，无效预览应 404 且没有 Set-Cookie。允许 NapCat 正常重连间隔；部署器会使用不回显的 Read API token 确认 `/read/health` 为 `ok: true`。HTTPS 登录后在测试群检查 @、回复机器人、网页、生图和 BT，核对配置保留；经 Cloudflare 访问应正常，直连源站应被拒绝。

Windows 包先运行 `install-deps.cmd`，准备持久配置并迁移后用 `run.cmd`。默认启动三个角色，`BOT_ROLE` 可选角色；已迁移 V3 的数据不能交给 legacy。

<a id="migration"></a>
## 数据迁移与维护

RC.2 或更早版本为一次性单向切换。先停全部写入者，确认主密钥与 SQLite `PRAGMA integrity_check` 正常，备份 `.env`、`data/`、旧 `config/`、`skills/` 和 NapCat，并确认归档、删除旧输入和原子替换权限。

```bash
npm run migrate:v3
npm run migrate:v3 -- --execute
```

导入群配置、设置、批准显式记忆、知识、任务、报告、审计与健康历史。记忆仅接受 `admin`、`explicit_command`、`explicit_request`。旧候选、自动画像、人格、对话进入七天加密回滚归档，不作为运行输入；标记后停止读写旧 JSON。

现有 V3 正式升级执行 `--execute --allow-existing-cutover`，只应用新增迁移、清理与授权能力变更。打包人格的一次性修订有审计、幂等标记，不覆盖管理员后续修改。v3.0.49 在单一 SQLite 事务中从全部群配置移除已退休的 `roastModeUserIds`；遇到损坏配置整批回滚，不启动部分结果。核对账本达到当前版本、`v3_state_meta` 标记存在后启动三项服务。

`ubot-maintenance.timer` 每小时清理按 Ingress 接收时间计算的七天原始群消息、附件元数据、过期加密归档、30 天网页、租约和孤儿文件。事件时间不延长留存，日报保留结果。撤回表只存交付标识与时间，不存搜索词或卡片，终态按消息保留周期清理。

### 策略与存量修复

仅需初始化模型策略时，先验证 Sol、GPT、DS 文字及 GPT 视觉真实调用，在新目录运行 `node scripts/upgrade-model-policy.mjs --check`，停 Worker 后 `--apply`。工具事务内加密备份系统、群模型和指令权限，初始化默认链、全群跟随、生图权限与 DS 上游名。成功后重复执行无操作；完整回滚后可显式 `--apply --retry-after-rollback`。支持 `RELEASE_ROOT`、`UBOT_APP_ROOT`、`DB_PATH`。

`scripts/repair-member-name.mjs --check|--apply` 是 v3.0.46 已授权的一次性存量工具，不是通用改名入口。公开文档仅说明精确旧值校验、加密备份与跳过行为，不公开群、成员或称呼。备份键 `release-policy-backup/v3.0.46-member-names`，已改记录跳过；日常改名使用后台。

<a id="recovery"></a>
## 备份与回滚

每次升级保留受限 `/opt/ai-project/release-backups/<timestamp>-v<version>`、原 Release 和完整持久状态，保留所有者、权限及加密密钥，不把备份公开。

### 数据切换边界

首次迁移前可恢复原 `current`、unit、`.env`、专用预览配置和 NapCat，再启原服务；既有 V3 增量升级失败，也可在配置恢复后启动先前 V3 target。

首次数据切换可能开始后，不自动恢复 SQLite、生成页面、重放发件箱或启动旧 JSON 服务。保留备份、迁移输出、版本及 journal，选择前向修复或停机恢复完整数据库。禁止自动重试历史 pending／sending／投递未知 Outbox，禁止把旧 JSON 拷回 V3。恢复 SQLite 必须全服务停写，整体恢复并重验完整性、标记及消息状态。

### 版本相关回滚

- 成人 BT：先停 Worker，Ingress 排空最后卡片撤回最多 105 秒再停；保留 migration 20 字段和 `message_recalls`，未知、拒绝或过期任务不重放、不补发群消息。
- 合并转发：保留 migration 19 和 `forward_payload_json`，旧版从 `text` 读取短降级提示，终态及歧义行不重放。
- 回退 v3.0.33 或更早：全服务停写，用新版 `bt-capability-policy.mjs restore <DB_PATH> <POLICY_BACKUP>` 恢复旧能力策略后切程序，避免旧版不识别 `bt_search`。恢复失败保持停止。
- 撤销模型策略升级：排空后停新版服务，保留新目录并执行 `node scripts/upgrade-model-policy.mjs --rollback`，恢复加密备份的系统模型、权限、群选择和 DS 名，再选旧版。普通界面修复回滚不运行该操作。
- v3.0.43／v3.0.44／v3.0.46 画像和界面修复无新迁移，切回兼容程序并保留配置、称呼和画像，不整体回退群或重写画像。
- V3 兼容层至少保留至 `2027-01-31`。删除前必须在隔离环境以受限备份完成恢复演练，记录备份、耗时、SQLite 完整性、三项服务健康、NapCat 重连、结论和批准人；不得让旧程序误指向 V3 数据目录。

### 故障排查

看三项服务、NapCat URL、容器重启结果和授权 health；未登录 401 不代表故障。画像看 `memberQueryType`、`memberQueryResolutionSource`、`memberQueryUnresolvedReason`、`targetUserIds`、`memorySubjectUserIds`，旧字段还有 `memberProfileQueryIntent`、`savedAliasStatus`。`memoryCount` 只是条数，结合归属判断查不到或查错。这些字段不含正文，向外反馈还需脱敏标识。

BT 先以运行用户验证 Python、浏览器和代理，部分站失败不影响其他源。发件箱 ACK 保存失败和送达未知需人工核对，不能通过重放验证。登录恢复见 [后台账号](#accounts)。

<a id="release"></a>
## 验证与发布

```bash
node scripts/run-node22.cjs scripts/public-docs.mjs check
node scripts/run-node22.cjs scripts/typecheck.cjs
node scripts/run-node22.cjs scripts/test.cjs
node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs
node scripts/run-node22.cjs scripts/rollback-smoke.mjs
npm run package:all
```

全量测试包含统一服务端/Vue 类型检查、文档检查、BT 回归、后台视觉冒烟和密钥扫描。后台布局样例 `scripts/visual-admin-smoke.mjs --layout-fixture --hold` 只用临时数据库，不用于生产。CI、打包和正式发布前均运行 Gitleaks；打包显式白名单，排除测试、运行数据、虚拟环境、Cookie 和私有备份，校验解包内容及生产依赖安装。

新版本更新 `package.json`、锁文件与下方标记中的版本和更新内容，直接维护统一手册，不新增逐版本 Markdown。运行：

```bash
node scripts/run-node22.cjs scripts/public-docs.mjs release-notes
```

生成忽略目录 `.codex_tmp/release-notes.md`，版本、标记或检查失败会停止。只有匹配 `v<version>` 的 GitHub Actions 工作流能创建正式 Release：提交历史密钥扫描、Node 22 全量测试、后台视觉冒烟、双平台打包、产物校验和精确产物扫描均成功后才获得写入 Release 的最小权限。本地没有绕过这些门禁的发布命令。

凭据事件的历史净化和旧标签／Release 重建期间，Release 工作流默认停用：除非仓库管理员在 Actions Variables 中将 `UBOT_RELEASE_PIPELINE_ENABLED` 精确设为 `true`，所有 Release 作业都会跳过。只有凭据轮换、历史重写、旧 Release 重建、协作者重新克隆及恢复演练均已完成并有审批记录后，才可开启该变量。

发布说明只记录功能、兼容和验证结果，示例使用“成员甲／成员乙”、`<USER_ID>`、`<GROUP_ID>`、`<BOT_QQ>`；不公开真实称呼、备注、账号、群号、画像、聊天原文和线上定点修复对象。自动检查拦截编号与聊天摘录格式，无法识别所有自然语言姓名，发布前仍需人工复核。报错只输出文件、行号、规则，不回显敏感值。

历史 Release 可单独脱敏；旧 Git 历史和旧发布包不会随文案修改改变。发生凭据事件时先在发行方吊销和轮换，再用仅从标准输入读取的 `scripts/rotate-gemini-reply-key.mjs` 更新 Gemini 回退模型；默认回复模型必须保持 `sol`。历史净化、标签/Release 重建、备份清理和协作者重新克隆属于单独的受控变更。生产数据和凭据通过私有渠道维护。

<a id="changes"></a>
## 本版更新

<!-- release-notes:start -->
### v3.0.49

安全与可靠性整合发布，保留 v3.0.48 的日报、生图诊断、成员称呼、身份隔离和画像隐私修复。

- Ingress Read API 新增独立 Bearer token、1 MiB 请求上限及超时控制；Admin 启动失败会传递到服务管理器，可信反代才使用单值真实 IP。
- Worker 统一管理 SQLite 生命周期，Ingress 出站改为单飞；消费者失败按 5、10、20、30 秒退避，成功后重置。
- 部署器先验证 Read API 监听与鉴权边界，再重启 NapCat，随后才要求已连接的健康状态；失败恢复旧 release、unit、Nginx 和持久配置。
- 退休嘴臭模式：旧配置写入返回 `410 roast_mode_retired`，群配置存量在可审计的单一事务中清理，损坏记录会整体回滚。
- Linux 生产固定独立校验的 Node 22、受限 `ubot` 账户和只读 release；预览文件迁至 `/var/lib/ubot-preview`，服务使用严格 systemd 隔离。
- 两个 UBot 域名支持 Cloudflare Origin CA、Full (strict)、可信来源限制和原子 CIDR 更新；其他同机站点及全局防火墙保持不变。
- CI、发布和打包增加类型检查、BT 与后台冒烟、生产依赖审计及密钥扫描门禁；Actions 固定到 commit SHA，并由 Dependabot 跟踪更新。
- Release 工作流在历史净化完成前默认失效关闭，必须由仓库管理员显式启用后才会执行任何打包或发布作业。

升级会保留现有模型、权限与持久配置。完整发布前需完成 Node 22 测试、后台冒烟、BT 离线回归、密钥扫描、双平台包校验和隔离恢复演练；回滚前排空成人卡片撤回最多 105 秒。
<!-- release-notes:end -->
