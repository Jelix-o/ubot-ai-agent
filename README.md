# UBot V3.0.0-rc.2

> **重构第一阶段候选版，不是完整 V3 架构的最终完成版。**
>
> 此版本用于在真实 QQ 群中以保守策略验证安全、可靠性与可解释性改造。请先在测试群观察，再逐群开启更积极的参与方式。

UBot 是基于 `NapCat + OneBot + Node.js 22+ + TypeScript + Vue 3` 的 QQ 群机器人和管理后台。运行时由 Ingress、Worker、Admin 三个角色协作，使用 SQLite WAL 保存消息总线、因果上下文、Outbox 回执和参与决策。

项目地址：[Jelix-o/ubot-ai-agent](https://github.com/Jelix-o/ubot-ai-agent)

当前版本：`v3.0.0-rc.2`。完整变更和已知边界见 [RELEASE-v3.0.0-rc.2.md](RELEASE-v3.0.0-rc.2.md)。

## RC.2 已完成内容

- **安全后台边界**：移除“仅凭 QQ 号”的 viewer 登录；管理后台只接受有效管理凭据。公开画像分享入口已关闭，画像只在受保护的后台内查看。
- **可解释的群参与决策**：每条可处理消息都会被分类为 `ignore`、`observe`、`reply`、`task` 或 `admin_command`，并写入 SQLite 审计；后台健康页可查看原因、信号与策略版本。
- **保守的默认说话策略**：`mentions_only` 只在 `@机器人` 或引用**已确认发送的机器人消息**时回复。关键词、复读和指定成员低频参与必须由管理员在群配置中显式开启。
- **真实 QQ 回执锚点**：Worker 只写 Outbox 草稿；Ingress 成功发送并回填真实 `platformMessageId` 后，后续同群引用才会续接因果链。引用普通成员不会让机器人擅自插话。
- **可靠消息链路**：SQLite 消费水位、去重、撤回、速率超限审计、Outbox 原子 claim 和发送歧义隔离均保留；过期 `sending` 行会转为不可自动重试的 `failed`，普通投递最多自动尝试 3 次，避免重复 QQ 消息和无限重试。
- **Skill 素材收敛**：原始素材不再默认进入模型 prompt；遗留公开人物/私人资料型 Skill 被隐藏或降级，IT 专家角色已改为短、可审计的实用风格。
- **跨进程配置一致性**：群配置、系统设置和主要 JSON Store 能发现文件版本变化；群配置与系统设置会写入 SQLite 的**脱敏影子快照**用于迁移核验，JSON 当前仍是权威源。
- **模型兼容性收口**：过渡 Anthropic adapter 明确拒绝不支持的流式路径，处理图片 URL 输入并走受控降级；OpenAI-compatible 模型仍是主路径。

## 当前架构

```text
NapCat / OneBot
  -> Ingress
       入站校验、去重、撤回、速率审计、Outbox 实际发送与 QQ 回执
  -> SQLite WAL (data/shared/bot-shared.db)
       messages / consumers / causal context / outbox / participation decisions
  -> Worker
       消费、因果路由、参与决策、LLM、Outbox 草稿、定时任务
  -> Admin
       认证后台、群行为设置、记忆/知识/诊断与审计
```

当前生产启动脚本仍由一个 `ai-project.service` 启动三个 Node 子进程；独立 systemd unit 是正式 V3 的后续目标。`BOT_ROLE=legacy` 可用于单进程回退。

## 已知架构边界

RC.2 **不宣称**已经完成以下路线图：

1. `BotApplication` 仍是核心聚合类，尚未拆为完整领域服务。
2. `ConversationStore` 与多数记忆、知识库、提醒、画像 JSON Store 仍在运行路径；SQLite 影子不是完整的业务主库迁移。
3. Character Profile、Knowledge Pack、Capability Policy 尚未成为独立持久化模型。
4. Anthropic 尚未替换为官方 SDK 的原生 provider/capability 层。
5. 独立 Ingress/Worker/Admin systemd unit、全面网络最小化和自动化发布回退尚未完成。

因此请将 RC.2 当作“安全与可靠性重构第一阶段候选版”，而不是完整 V3 最终版。

## 本地开发与验证

要求：Node.js `>=22`。

```bash
npm install
npm test
```

`npm test` 会执行前后端生产构建和完整测试套件。

附加验证：

```bash
node scripts/run-node22.cjs scripts/rollback-smoke.mjs
```

```bash
node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs
```

管理后台开发：

```bash
npm run dev:admin
```

服务端调试：

```bash
npm run dev
```

## 配置与数据边界

从模板创建本地配置：

```bash
cp .env.example .env
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `BOT_QQ` | 机器人 QQ 号 |
| `NAPCAT_REVERSE_WS_HOST` / `PORT` / `PATH` | NapCat 反向 WebSocket 配置 |
| `NAPCAT_ACCESS_TOKEN` | NapCat 访问令牌；公网监听时必须设置 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 默认回复模型兜底配置 |
| `ADMIN_HTTP_ENABLED` / `ADMIN_HTTP_HOST` / `ADMIN_HTTP_PORT` | 管理后台监听配置 |
| `ADMIN_PUBLIC_BASE_URL` | 对外后台地址 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` | 管理后台认证 |
| `BOT_ROLE` | `ingress`、`worker`、`admin` 或 `legacy`；留空时运行前三者 |

严禁提交 `.env`、`data/`、私钥、第三方 API Key、管理员密码或真实群聊原文。

## 群参与方式

每个群有明确的 `participationMode`：

| 值 | 说明 |
| --- | --- |
| `mentions_only` | 仅在 @ 机器人，或引用已确认的机器人消息时回复。RC.2 默认且最安全。 |
| `mentions_and_keywords` | @ / 引用之外，允许显式配置的关键词触发。 |
| `selected_members` | 在前项基础上，对指定成员允许受延迟和静音约束的低频参与。 |

RC.2 首次部署前应运行参与方式迁移。默认命令只预览，不改文件：

```bash
npm run migrate:participation
```

确认后将缺失字段补为保守模式，并自动备份 `groups.json`：

```bash
npm run migrate:participation -- --mode mentions_only --execute
```

该迁移只填充缺失的 `participationMode`，不会覆盖管理员已设置的模式。

## 对话与命令

- 普通对话：`@机器人 <内容>`。
- 引用机器人已确认回复后可直接追问，无需再次 @；引用其他成员不会触发机器人。
- `#功能` / `#帮助`：查看当前可用命令。
- `#状态`、`#健康`、`#闭嘴`、`#说话`、`#模型`、`#技能`、`#记忆`、`#知识库`、`#定时任务` 等由后台指令管理配置。

完整群内命令和权限说明见 [COMMANDS.md](COMMANDS.md)。

## 上下文迁移

V2.0.1 引入了新的因果上下文。仅当从 V2.0.0 或更早版本升级、并且尚未执行过上下文迁移时，才在**停止 Ingress 和 Worker、Outbox 已排空**后执行：

```bash
npm run migrate:context
```

```bash
npm run migrate:context -- --execute
```

该脚本会在 `data/context-backups/<timestamp>/` 创建 SQLite 和短期上下文备份，清空短期路由/话题/锚点，并保留长期记忆、知识库、系统设置、日报和消息审计表。

从 v2.0.3 升级到 RC.2 不运行上下文迁移。RC.2 运行时会以**加法方式**应用 SQLite schema migration 1–4：旧列兼容、群配置影子表、系统设置脱敏影子表和 Outbox 尝试计数；不会清空现有上下文或业务数据。

## Linux RC 部署

生产环境采用版本目录与持久数据目录：

```text
/opt/ai-project/                 # 持久 .env、data、skills、config
/opt/ai-project-releases/vX/     # 不可变代码与 dist
/etc/systemd/system/ai-project.service.d/
```

部署必须满足：

1. 先完成本地 `npm test`、rollback smoke、admin smoke 与 `git diff --check`。
2. 先停止 `ai-project.service`，再对 SQLite 执行 `VACUUM INTO` 备份并备份 `.env`、`data`、`skills`、`config`。
3. 旧 Outbox 的任何 `sending`、`pending` 或可重试 `failed` 行必须先人工隔离；不得自动重发历史 QQ 消息。
4. 新 release 只链接持久 `.env`、`data`、`skills`、`config`；不得覆盖真实群配置或模型密钥。RC.2 只会将随 release 附带、已审查的 `itexpert.json` 写入持久 skills 目录以移除旧的 source-heavy 定义；其余 owner-managed Skill 不会被替换。
5. 迁移参与方式为 `mentions_only` 后再启动，以便首次 RC 运行保持安静。
6. 修改 systemd release drop-in 后执行 `daemon-reload`、重启和健康检查；失败应立即恢复上一个 release drop-in。

部署后最小检查：

```bash
systemctl is-active ai-project.service
```

```bash
curl -I https://bot.9958.uk/login
```

```bash
ps -eo pid,ppid,args | grep '[n]ode dist/index.js'
```

预期：服务为 `active`，存在三个 UBot Node 进程，后台登录页返回 HTTP 200，`/api/health` 在未登录状态返回 401（这属于预期保护行为）。随后仅在测试群验证 @、引用机器人回复、静音和后台参与决策审计。

## Linux 发布包与受控部署

构建不含任何运行数据、密钥、Skill 或群配置的 Linux release archive：

```bash
npm run package:linux
```

它会在 `release/` 生成 `ubot-<version>-linux.tar.gz` 和 SHA-256 文件。archive 不含运行数据、群配置或 owner-managed Skill，仅包含用于替换旧 source-heavy 定义的已审查 `managed-skills/itexpert.json`。上传 archive 到服务器后，使用 release 内的部署脚本（脚本会停服务、备份、隔离已批准的旧 Outbox 行、迁移缺失参与方式、切换 systemd drop-in，并在失败时恢复旧 release）：

```bash
sha256sum -c ubot-3.0.0-rc.2-linux.tar.gz.sha256
```

```bash
mkdir -p /tmp/ubot-3.0.0-rc.2
```

```bash
tar -xzf /tmp/ubot-3.0.0-rc.2-linux.tar.gz -C /tmp/ubot-3.0.0-rc.2
```

```bash
bash /tmp/ubot-3.0.0-rc.2/scripts/deploy-linux-release.sh 3.0.0-rc.2 /tmp/ubot-3.0.0-rc.2-linux.tar.gz 291,292,293,294
```

在运行前检查脚本与目标目录是否符合本地部署策略；生产 `config/groups.json`、`.env`、`data/`、`skills/` 均不会从 archive 覆盖。

## Windows 打包与 GitHub 发布

```powershell
npm run package:win
```

压缩包位于 `release/`，不包含本机 `.env`、群配置和运行数据。打包脚本从 `package.json` 动态寻找同版本 `RELEASE-v<version>.md`。

GitHub Release 需要仓库写权限 Token：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1
```

发布脚本默认使用 `package.json` 版本、`RELEASE-v<version>.md` 和 `release/ubot-<version>-win.zip`。代理地址、Token 和私钥必须只存在于本机环境，不可写入仓库。

## 回滚

停止服务后，将 systemd release drop-in 恢复指向上一个版本，再执行 `daemon-reload` 和重启。若三进程启动异常，可临时设置 `BOT_ROLE=legacy` 以运行单进程回退入口。

不要通过回滚删除 SQLite 新列或新的 migration 记录；它们按加法兼容设计。恢复数据时使用发布前 `VACUUM INTO` 的备份，不要自动重发旧 Outbox 行。
