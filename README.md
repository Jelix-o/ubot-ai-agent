# UBot V3.0.0

UBot 是一个基于 `NapCat + OneBot + Node.js 22 + TypeScript + Vue` 的 QQ 群机器人和管理后台。V3.0.0 的唯一人格是会仙，一位原创的成年虚拟聊天伙伴；她可以聊天、协助、联网查询、语音、唱歌、提醒、日报和节日倒计时，但不会伪造真人身份、私人照片或线下经历。

项目地址：[Jelix-o/ubot-ai-agent](https://github.com/Jelix-o/ubot-ai-agent)。本版发布说明见 [RELEASE-v3.0.0.md](RELEASE-v3.0.0.md)，生产运维见 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md)，一次性数据切换与故障边界分别见 [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md) 和 [docs/ROLLBACK-v3.md](docs/ROLLBACK-v3.md)。

## V3 架构

```text
NapCat / OneBot
  -> Ingress                 接收、去重、Outbox 实际发送与 QQ 回执
  -> SQLite WAL              唯一业务权威源
  -> Worker                  对话、显式记忆、知识、提醒、日报和能力编排
  -> Admin                   账号、TOTP、群授权、审计和后台 API
```

Ingress、Worker、Admin 是独立进程。生产环境由 `ubot.target` 管理三个 systemd unit；它们使用 `/opt/ai-project-releases/current` 这个原子切换的软链接，而不是一个父进程拉起三个子进程。

V3 使用 SQLite 保存群配置、系统设置、会仙 Character Profile、Knowledge Pack、Capability Policy、显式记忆、排程、管理员账号和审计。旧 JSON 数据只在一次性切换时导入；切换标记写入后，运行时不会回退读取或双写 JSON。

## 主要行为

- 会仙是唯一启用的人格，角色市场、旧人格选择和运行时 `skills/` 目录已退休。
- 只有 `#记忆`、`@机器人 请记住` / `请记忆` 和管理员明确操作才会保存记忆。普通聊天不会自动抽取、推断或进入候选审核。
- 导入时只接受 `admin`、`explicit_command`、`explicit_request` 来源的记忆。候选记忆、自动画像、旧人格和旧对话素材进入加密的七天回滚归档，不进入运行数据库。
- 原始群消息和附件元数据保留最多七天。日报保留结果，不依赖长期保存的原始内容。
- OpenAI-compatible provider 保留，Anthropic 使用官方 SDK 和明确的 capability 合约处理流式、视觉、超时与降级。
- 未授权访问 `/api/health` 返回 `401` 是预期行为，不是健康检查失败。

完整的群内命令说明见 [COMMANDS.md](COMMANDS.md)。

## 本地开发

要求：Node.js `>=22`。

```bash
npm ci
npm test
```

管理后台开发：

```bash
npm run dev:admin
```

服务端监听开发：

```bash
npm run dev
```

从模板创建本地环境文件：

```bash
cp .env.example .env
```

不要提交 `.env`、SQLite 数据库、群配置、日志、私钥、令牌或真实群消息。

## 必要配置

| 配置 | 作用 |
| --- | --- |
| `BOT_QQ` | 机器人 QQ 号 |
| `NAPCAT_MODE` / `NAPCAT_REVERSE_WS_*` | NapCat reverse WebSocket 连接 |
| `NAPCAT_ACCESS_TOKEN` | 非本地 ingress 监听时必须设置的 NapCat 令牌 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 默认回复模型 |
| `ADMIN_HTTP_*` | 后台监听和公开 HTTPS 地址 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 仅账户表为空时导入第一个超级管理员 |
| `UBOT_STATE_ENCRYPTION_KEY` | V3 状态、TOTP 和回滚归档的 32-byte 主密钥（64 位 hex 或 base64url），使用 HKDF 用途隔离 |

生产部署必须从批准的密钥管理器提供 `UBOT_STATE_ENCRYPTION_KEY`，且不输出或提交其值。`ADMIN_SESSION_SECRET` 和 `ADMIN_TOTP_ENCRYPTION_KEY` 已退休。首次登录后的管理员必须绑定 TOTP；恢复码和账号恢复流程见 [docs/ADMIN-RECOVERY-v3.md](docs/ADMIN-RECOVERY-v3.md)。

Linux 生产 `.env` 还必须明确设置 `ADMIN_HTTP_ENABLED=true`、`ADMIN_HTTP_HOST=127.0.0.1`、`ADMIN_HTTP_PORT=6200` 与 `INGRESS_READ_API_PORT=6198`。发布脚本会在数据切换前校验这些内部监听边界。

## 数据切换

从 RC.2 或更早版本升级时，在**所有 UBot 服务已停止且可重试 Outbox 已清空**后，先预览迁移：

```bash
npm run migrate:v3
```

确认预览内容后才执行：

```bash
npm run migrate:v3 -- --execute
```

正式 Linux 部署脚本会在停服务、完整性检查和受限备份后自动执行同一迁移。成功切换后不要运行旧版本或 `ai-project.service` 来读取同一 `data/` 目录，也不要自动重发历史 Outbox。

## 打包与 GitHub Release

```bash
npm run package:all
```

命令生成以下四个发布资产，并重新验证 SHA-256：

```text
release/ubot-3.0.0-win.zip
release/ubot-3.0.0-win.zip.sha256
release/ubot-3.0.0-linux.tar.gz
release/ubot-3.0.0-linux.tar.gz.sha256
```

发布包不包含 `.env`、数据库、日志、`data/`、`config/`、旧 `skills/`、私钥或任何持久群资料。Windows 使用 `run.cmd` 启动三种角色；已有旧数据时，先按上节显式运行切换迁移，不要让启动脚本猜测迁移时机。

正式路径由 GitHub Actions 在匹配的最终 `v3.0.0` 标签上完成。仅在工作流不可用时，才可用本地后备发布；它要求当前检出正是已创建的最终标签提交，并需要具有 Release 写权限的 `GITHUB_TOKEN` 或 `GH_TOKEN`：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
npm run release:github
```

GitHub Actions 在 `v3.0.0` 标签上执行 Windows/Linux 测试、双平台打包、摘要校验和正式 Release 创建。候选标签只通过验证和打包，不会创建正式 Release；工作流不接触服务器私钥或生产密钥。

## Linux 生产部署

生产使用 `ubuntu@43.212.131.90` 上的 `bot.9958.uk`，但部署命令不应将私钥、密码或令牌写入仓库。部署前阅读 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md)。概要如下：

```bash
sha256sum -c ubot-3.0.0-linux.tar.gz.sha256 # matching GitHub Release asset
UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json \
  UBOT_NGINX_CONFIG=/absolute/path/to/active-bot.9958.uk.conf \
  bash scripts/deploy-linux-release.sh 3.0.0 ubot-3.0.0-linux.tar.gz
```

部署会使用 `172.21.0.1:6199` 作为 Docker 中 NapCat 访问宿主 Ingress 的反向 WebSocket 地址。`6198` 和 `6200` 继续仅监听回环地址；不修改 UFW 或 AWS 安全组。Nginx 模板位于 [deploy/nginx/bot.9958.uk.conf](deploy/nginx/bot.9958.uk.conf)，固定写入 `X-Forwarded-Proto: https`，不会信任可伪造的客户端请求头。
