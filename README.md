# UBot V2.0.3

UBot 是基于 `NapCat + OneBot + Node.js 22+ + TypeScript + Vue 3` 的 QQ 群机器人和管理后台。它以三进程服务运行，并将群消息、上下文路由、回执和管理配置持久化到 SQLite。

项目地址：[Jelix-o/ubot-ai-agent](https://github.com/Jelix-o/ubot-ai-agent)

当前版本：`v2.0.3`。本次新增显式长文本支持：用户要求“3000 字”“写成长文”或继续未完成长文时，机器人会在当前轮直接生成正文，并按 Skill 的单条、总字符和最多消息数拆成 QQ 消息。完整变更见 [RELEASE-v2.0.3.md](RELEASE-v2.0.3.md)。

## 核心特性

- **三进程架构**：Ingress 独占 NapCat 连接并写入消息总线；Worker 处理路由、模型与回复；Admin 提供后台 HTTP 服务。
- **因果上下文隔离**：上下文按 `(群号, 因果分支)` 保存。明确引用在 1 小时内精确恢复链路；无引用只允许同一用户在 10 分钟内按追问或相似度规则续聊。
- **不注入群聊原文**：普通会仙问答只使用当前因果链、显式引用、长期记忆和脱敏群氛围摘要，其他群消息不会进入 prompt。
- **真实 QQ 回执**：Worker outbox 使用内部 `deliveryId`，Ingress 成功发送后回填真实 QQ `platformMessageId`，后续引用机器人回复可稳定恢复上下文。
- **模型热刷新**：后台更新 `system-settings.json` 后，Ingress、Worker 和 Legacy 进程会自动刷新；`#模型` 展示实际调用的上游模型名。
- **可读群聊日报**：日报按“当前群名片 → 当前 QQ 昵称 → 消息快照 → QQ 号”显示成员；成员接口暂时失败时仍可使用已保存快照生成。
- **按需长文本**：普通聊天保持短回复；用户明确指定篇幅时，一次生成正文并按 Skill 回复控制自动分段，不再先承诺或要求用户重复确认。
- **可靠消费**：消息按 SQLite 自增 ID 消费并记录完成状态；失败可重试，时间戳乱序不会跳过消息。
- **运维能力**：幂等去重、撤回处理、熔断与降级、限流、日志、指标、管理后台、长期记忆和知识库。

## 架构

```text
NapCat / OneBot
  -> Ingress: 入站校验、幂等、审计消息、Outbox 发送
  -> SQLite WAL: data/shared/bot-shared.db
  -> Worker: 持久化路由、因果链、LLM、Outbox 草稿/发布
  -> Admin: 管理后台与系统设置
```

`data/shared/bot-shared.db` 是多进程的唯一短期上下文来源。`data/`、`.env` 和 `config/groups.json` 是生产数据，升级代码时必须保留。

## 本地开发

要求：Node.js `>=22`。

```bash
npm install
npm run build
npm test
```

管理后台开发：

```bash
npm run dev:admin
```

服务端调试：

```bash
npm run dev
```

## 配置

从模板创建本地配置：

```bash
cp .env.example .env
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `BOT_QQ` | 机器人 QQ 号 |
| `NAPCAT_REVERSE_WS_HOST` / `PORT` / `PATH` | NapCat 反向 WebSocket 配置 |
| `NAPCAT_ACCESS_TOKEN` | NapCat 访问令牌 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 默认回复模型兜底配置 |
| `ADMIN_HTTP_ENABLED` / `ADMIN_HTTP_HOST` / `ADMIN_HTTP_PORT` | 管理后台监听配置 |
| `ADMIN_PUBLIC_BASE_URL` | 对外后台地址 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` | 管理后台认证 |
| `BOT_ROLE` | `ingress`、`worker`、`admin` 或 `legacy`；留空时运行前三者 |

群配置位于 `config/groups.json`。模型、指令和成本控制由后台的系统设置管理；模型 ID（例如 `ds`）是群内选择值，实际 API 模型名取自该模型项的 `model` 字段。

```text
#模型                 查看当前群回复模型
#模型切换 ds          切换到 ID 为 ds 的已启用回复模型
```

`#ds` 只有在后台将其配置为“模型”指令别名时才生效。

## 上下文迁移

V2.0.1 改用了新的短期上下文结构。首次升级前必须停止 Ingress 和 Worker，等待 outbox 排空，然后在项目目录执行：

```bash
npm run migrate:context
npm run migrate:context -- --execute
```

第一条命令是只读预检；第二条命令会：

1. 在 `data/context-backups/<timestamp>/` 创建旧短期上下文和 SQLite 快照。
2. 清空旧会话、话题、路由、消息锚点、inflight 和氛围缓存。
3. 记录消息表的切换水位，旧消息保留审计用途但不会再进入新上下文。

不会清理长期记忆、画像、知识库、群配置、系统设置、日报或原始消息审计表。

从 V2.0.1 升级到 V2.0.2 不需要再次执行上述迁移。V2.0.2 启动时只会为 SQLite `messages` 表自动增加可空的 `sender_card` 和 `sender_nickname` 列，不清空上下文、日报统计或历史审计消息。部署前仍建议备份 `data/shared/bot-shared.db` 和 `data/daily-report-store.json`。

V2.0.2 升级到 V2.0.3 没有数据库迁移，也不会清理上下文。生产部署会保留后台编辑过的 Skill JSON；建议将它们放在持久化 `skills/` 目录并由版本目录链接使用。

## Linux 部署

生产环境推荐 `/opt/ai-project`，由 `ai-project.service` 管理。部署时只替换代码与依赖，不覆盖 `.env`、`data/` 或 `config/groups.json`。

```bash
sudo systemctl stop ai-project.service

# 部署新版代码后，在项目目录执行
npm ci
npm run build
npm test

sudo systemctl start ai-project.service
sudo systemctl status ai-project.service --no-pager
```

只有从 V2.0.0 或更早版本首次升级、且尚未执行过 V2.0.1 上下文迁移时，才需要运行上一节的 `migrate:context` 两条命令。V2.0.1 → V2.0.2 不运行它们。

服务启动脚本为 `scripts/start-prod.sh`，默认拉起 `ingress,worker,admin` 三个进程。若需要临时回退单进程模式，可设置 `BOT_ROLE=legacy` 后重启服务。

部署后检查：

```bash
systemctl is-active ai-project.service
ps -eo pid,ppid,args | grep '[n]ode dist/index.js'
curl -I https://bot.9958.uk/login
tail -n 100 data/logs/worker.log
```

预期是服务为 `active`、存在三个 Node 进程、登录页返回 HTTP 200，且 worker 日志中没有持续的 SQLite 或模型配置错误。

## Windows 打包

```powershell
npm run package:win
```

压缩包位于 `release/`，不包含本机 `.env`、群配置和运行数据。首次运行前填写 `.env`，并创建 `config/groups.json`。

## 发布

发布前：

```bash
npm run build
npm test
git diff --check
```

创建 GitHub Release 前先生成 Windows 包，再设置具有仓库 Contents/Release 写权限的 `GITHUB_TOKEN` 或 `GH_TOKEN`：

```powershell
npm run package:win
powershell -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1
```

发布脚本默认从 `package.json` 读取版本，并匹配 `RELEASE-v<version>.md` 与 `release/ubot-<version>-win.zip`。

## 回滚

停止服务后将 systemd 的工作目录或代码目录切回上一版本，再启动服务。V2.0.2 的两列 SQLite 变更是向后兼容的，回切 V2.0.1 时不要求删除新列。若需要恢复旧短期上下文，使用迁移前 `data/context-backups/` 中对应时间戳的备份；不要将旧短期会话表与 V2.0.1 的新路由表混合使用。

## 验证状态

V2.0.3 已通过完整测试套件、前后端生产构建，以及显式长文本解析、QQ 分段和多段回执链路测试。实际测试数量见 [V2.0.3 发布说明](RELEASE-v2.0.3.md)。
