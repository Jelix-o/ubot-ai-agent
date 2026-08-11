# UBot V2.0.0

UBot 是基于 `NapCat + OneBot + Node.js 22+ + TypeScript + Vue 3` 的 QQ 群聊机器人和群运营后台。**V2.0.0 完成服务化架构升级**：从单进程重构为多进程服务（Ingress / Worker / Admin），实现消息幂等去重、每 key 串行路由、真取消、话题隔离、图片两阶段识别、LLM 熔断与降级、全链路可观测指标。核心原则：**"用户等不起，模型不可靠，历史会串味"**。

## 核心能力

- **服务化架构**：NapCat 反向 WS 由 Ingress 单进程独占（幂等去重 + backlog 检测 + 撤回订阅 + 每群令牌桶）；Worker 按 `(群, 用户, 话题)` 三元组串行消费、跨 key 并行；Admin 独立进程承载管理后台。共享状态走 `data/shared/bot-shared.db`（SQLite WAL）。
- **防重复回复（核心 KPI）**：幂等键 `(self_bot_id, group_id, msg_id)` + in-flight registry；同 key 新消息覆盖旧任务（>20s 取消续跑 / <20s 追加合并 / 否则静默丢弃），`duplicate_reply_rate` 必须为 0。
- **真取消**：LLM 调用全链路 `AbortSignal` 透传，超时/取消触发底层 socket 断开，token 不空烧。
- **话题隔离**：reply_to 继承话题、字符 Jaccard + 关键词重叠归入活跃话题（30min 窗口）、无关提问绝不串味；群氛围只以脱敏摘要（L5）进入上下文，原文不进 prompt。
- **图片两阶段**：Stage1 本地化（NapCat 缓存 → 内部代理拉取）→ Stage2 识别；失败分级话术 L1-L4（"拿不到图"与"想不明白"日志可区分）。
- **LLM 熔断与降级**：连续 5 失败或 p95>40s 熔断 30s（期间零 quota 消耗），每级固定降级话术；分级超时（记忆 1.5s / 实时查询 8s / LLM 35s / 端到端 60s 静默）。
- **群聊对话**：`@机器人 <内容>` 触发，保留个人上下文；同群成员 10 分钟内可接续共享话题，引用消息 30 分钟内精确恢复主题。
- **语音回复**：`#语音`、`#唱歌`、群语音开关和默认语音回复。
- **记忆系统**：候选记忆、长期记忆（含 superseded_by 覆盖链 + 时间衰减）、成员画像、每日画像审查、记忆去重。
- **运维后台**：总览、群配置、成员、记忆、画像、知识库、任务中心、审计、系统状态、Skills、指令、系统设置；普通 QQ 用户只读登录。
- **模型管理**：按用途配置模型（reply/profile/memory/dedup/summary/tts），支持 OpenAI 兼容与 Anthropic 协议。

## 目录结构

- `src/`：机器人、多进程入口（`index-ingress.ts` / `index-worker.ts` / `index-admin.ts` / `index-legacy.ts`）、共享层（`shared/`）、服务与测试。
- `admin/src/`：Vue 3 管理后台。
- `skills/`：Skill JSON 配置。
- `config/groups.json`：生产群配置。
- `data/`：生产运行数据，部署升级时必须保留；`data/shared/` 为多进程共享状态（SQLite / 话题索引 / 氛围摘要 / 指标）。
- `dist/`：构建产物。
- `COMMANDS.md`：群内指令清单。
- `RELEASE-v2.0.0.md`：V2.0.0 发布说明。

## 多进程架构

```
NapCat (反向 WS)
   │  仅 Ingress 进程连接
   ▼
[ingress] 反向 WS → backlog 检测 → 幂等去重 → 撤回订阅 → 令牌桶 → 写消息总线
   │
   ▼  data/shared/bot-shared.db（SQLite WAL，consumer 水位轮询）
[worker]  (群,用户,话题) 三元组路由 → 每 key 串行 → in-flight registry
   ├── 上下文分层装配（L0 人设 / L1 记忆 / L2 话题链 / L3 个人 / L4 实时 / L5 氛围摘要）
   ├── 图片两阶段（本地化 → 识别，失败分级话术）
   └── LLM 调用（信号量 → 熔断器 → AbortSignal 真取消）
   │
   ▼  outbox 表
[ingress/emitter] 幂等回执 → NapCat → QQ
```

进程启动方式（`run.cmd` / `scripts/start-prod.sh`）：

```bash
# 默认三进程
run.cmd                      # Windows
scripts/start-prod.sh        # Linux (systemd)

# 单角色
BOT_ROLE=ingress node dist/index.js
BOT_ROLE=worker  node dist/index.js
BOT_ROLE=admin   node dist/index.js

# 回滚：旧版单进程
BOT_ROLE=legacy  node dist/index.js
```

## 本地开发

项目要求 Node.js 22+（`node:sqlite` 内置，无需额外依赖）。构建和测试脚本会通过 `scripts/run-node22.cjs` 使用本机 Node 22+。

```bash
npm install
npm run dev
```

后台开发：

```bash
npm run dev:admin
```

构建和全量测试：

```bash
npm run build
npm test
```

V2.0.0 本地验收：

```powershell
npm run build
npm test
git diff --check
```

本地后台全系统截图验证：

```powershell
npm run build
$env:ADMIN_SMOKE_SCREENSHOTS="1"
node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs
```

截图输出目录：`release/admin-ui-smoke/`。

## 环境变量

复制模板后填写：

```powershell
Copy-Item .env.example .env
```

关键变量：

- `NAPCAT_MODE`：`forward` 或 `reverse`。
- `NAPCAT_WS_URL`：正向 WebSocket 地址。
- `NAPCAT_REVERSE_WS_HOST`、`NAPCAT_REVERSE_WS_PORT`、`NAPCAT_REVERSE_WS_PATH`：反向 WebSocket 监听配置。
- `INGRESS_READ_API_PORT`：Ingress 只读 API 端口（Worker/Admin 访问 NapCat 只读动作，默认 6198）。
- `NAPCAT_ACCESS_TOKEN`：NapCat 访问令牌。反向连接必须使用 `Authorization: Bearer <token>`。
- `BOT_QQ`：机器人 QQ。
- `BOT_ROLE`：进程角色（`ingress` / `worker` / `admin` / `legacy`），由启动脚本按逗号分隔拉起。
- `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`：普通回复模型。
- `PROFILE_AI_BASE_URL`、`PROFILE_AI_API_KEY`、`PROFILE_AI_MODEL`：画像、记忆、去重和总结模型兜底。
- `TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`、`TTS_VOICE`、`TTS_AUDIO_FORMAT`：语音模型。
- `ADMIN_HTTP_ENABLED`、`ADMIN_HTTP_HOST`、`ADMIN_HTTP_PORT`：后台 HTTP 服务。
- `ADMIN_PUBLIC_BASE_URL`：公网后台地址。
- `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_GROUP_PASSWORD`、`ADMIN_SESSION_SECRET`：后台登录和会话配置。

## 群配置

配置文件默认是 `config/groups.json`。Windows 发布包只附带安全的 `config/groups.example.json`；首次运行 `run.cmd` 时如果没有 `config/groups.json`，才会复制空白示例。

```json
{
  "superAdminUserIds": ["1569671790"],
  "groups": [
    {
      "groupId": "866209871",
      "currentSkillId": "assistant",
      "allowedSkillIds": ["assistant"],
      "switcherUserIds": ["1569671790"],
      "liveChatUserIds": [],
      "voiceReplyEnabled": true,
      "defaultVoiceReplyEnabled": false,
      "dailyReportEnabled": true,
      "dailyReportTime": "18:00",
      "holidayCountdownEnabled": true,
      "holidayCountdownTime": "09:00",
      "manualIdentities": [
        {
          "userIds": ["1967410653"],
          "names": ["前端同学"],
          "note": "项目成员"
        }
      ]
    }
  ]
}
```

说明：

- `superAdminUserIds`：全局超级管理员。
- `switcherUserIds`：当前群管理员。
- `voiceReplyEnabled`：当前群是否允许语音功能。
- `defaultVoiceReplyEnabled`：普通 AI 回复是否默认发送语音条；只有 `voiceReplyEnabled=true` 时有效。
- `manualIdentities`：人工身份和备注，优先用于成员识别。
- `memoryDisabledUserIds`：禁止指定成员的记忆收集。

## 普通用户只读后台

普通用户在登录页选择普通用户模式，只输入 QQ 号即可登录。后端通过当前 NapCat 群成员数据判断这个 QQ 所在的已启用群，并创建 `viewer` 会话；会话返回和后续访问都会重新按当前群成员关系计算可见群。

只读用户可以查看群管理员能看到的群内数据：

- 总览
- 群配置
- 成员管理
- 候选记忆
- 长期记忆
- 画像记录
- 知识库
- 任务中心
- 操作日志
- 通知
- 群页面需要的模型选项

只读用户不能执行任何会改变状态的 `/api/*` 请求，退出登录除外。写请求会返回：

```json
{ "error": "readonly_session" }
```

画像摘要的缓存读取允许；带 `refresh=1` 的刷新/生成会被禁止，因为它会产生新内容。

## 多进程部署（服务化拆分）

`run.cmd` 默认按三个角色并行拉起进程：

| 角色 | 入口 | 职责 |
| ---- | ---- | ---- |
| `ingress` | `dist/index-ingress.js` | NapCat 反向 WS、幂等去重、backlog 检测、撤回订阅、每群令牌桶、回复发送（Emitter） |
| `worker` | `dist/index-worker.js` | 消息消费、话题分配、in-flight 合并/取消、LLM 调用、回复生成 |
| `admin` | `dist/index-admin.js` | 管理后台 HTTP（通过 Ingress 只读 API 访问 NapCat 成员等数据） |

共享状态位于 `data/shared/`（SQLite `bot-shared.db`、话题索引、群氛围摘要、指标目录）。三个进程间零网络依赖（除本机回环只读 API）。

```powershell
# 默认启动三个进程
run.cmd

# 只启动 worker
set BOT_ROLE=worker
run.cmd

# 回滚到旧版单进程模式
set BOT_ROLE=legacy
run.cmd
```

回滚：`BOT_ROLE=legacy` 时 `run.cmd` 直接运行 `dist/index.js` 的旧版单进程入口（`index-legacy.ts`），数据文件路径不变。

## MiMo TTS V2.5 规则

UBot 的 TTS 请求按 MiMo V2.5 组织：

- 目标合成文本只放在 `role: "assistant"` 消息里。
- 自然语言风格、导演提示和整体控制放在 `role: "user"` 消息里，不会被读出。
- `assistant` 文本保持干净正文，避免语气、情绪或舞台提示被读出。
- `#唱歌` 只在 `assistant` 文本前保留必要的 `(唱歌)` 标签。
- 基础情绪、整体语调、音色定位、语速与节奏、情绪状态、语音特征和哭笑表达按正文语义自动判断后写入 `user` 风格指令。
- 旧版 TTS 提示字段不再作为手工控制项参与句子级生成。
- `mimo-v2.5-tts` 支持预置音色和唱歌标签。
- `mimo-v2.5-tts-voicedesign` 使用 `audio.optimize_text_preview = true`，不发送预置 `audio.voice`。
- `mimo-v2.5-tts-voiceclone` 使用音频样本克隆，不支持唱歌和预置音色。

## 常用指令

完整清单见 [COMMANDS.md](COMMANDS.md)。

- `#功能`
- `#技能 列表`
- `#技能 切换 <skillId>`
- `#模型 状态`
- `#模型 切换 <modelId|gpt|mimo>`
- `#语音 <内容>`
- `#语音回复 状态|开启|关闭`
- `#唱歌 <内容>`
- `#对话 清空`
- `#实时对话 列表|添加|移除|间隔`
- `#状态`
- `#健康检查`
- `#服务器`
- `#告警 状态|开启|关闭`
- `#操作日志`
- `#记忆 状态`
- `#知识库 状态`
- `#昨日画像 <备注/QQ号>`
- `#群聊画像 <备注/QQ号>`
- `#日报 状态|发送|开启|关闭|时间`
- `#节假日 状态|发送|开启|关闭|时间`
- `#定时任务 列表|添加|删除|状态|开启|关闭`
- `#管理员 列表|添加|移除`
- `#闭嘴` / `#说话`
- `#拉黑 <QQ号>` / `#拉黑 解除 <QQ号>`

## 任务中心

任务数据保存在 `data/admin-tasks.json`。

陈旧任务判断：

- 普通 `queued` 或 `running` 任务超过 30 分钟未更新会标记失败。
- `model-check` 任务超过 10 分钟未更新会标记失败。
- 当前进程内正在执行的任务不会被误判。
- 自动失败任务会写入 `finishedAt`、`durationMs`、`progress: 100` 和失败原因。

这用于处理生产中残留的“模型检测 环境语音模型”等长期执行中任务。

## 部署升级

生产目录示例：`/opt/ai-project`（Linux，systemd 服务 `ai-project.service`）。

升级时必须保留：

- `.env`
- `data/`（含 `data/shared/` 多进程共享状态）
- `config/groups.json`
- 生产 NapCat 登录状态和反向 WebSocket 配置

推荐流程：

```bash
# 1. 更新代码（保留 data/ config/ .env）
rsync -av --exclude node_modules --exclude data --exclude config/groups.json --exclude .env ./ ubuntu@<server>:/opt/ai-project/

# 2. 服务器上
cd /opt/ai-project
npm ci --omit=dev
npm run build

# 3. 重启（多进程：ingress + worker + admin）
sudo systemctl restart ai-project.service

# 4. 验证三进程
ps aux | grep "index-" | grep -v grep
tail -f data/shared/metrics/metrics-*.json
```

部署后验证：

```bash
systemctl is-active ai-project.service
curl -I https://bot.9958.uk/login
curl -i https://bot.9958.uk/api/session
```

期望：

- `ai-project.service` 为 `active`，且 `ingress` / `worker` / `admin` 三进程都在。
- Ingress 日志出现 NapCat reverse WebSocket connected。
- `/login` 返回 `200`；未登录访问受保护 API 返回 `401`。
- `data/shared/bot-shared.db` 存在；`data/shared/metrics/` 每 30s 落盘指标。
- 管理员后台可登录并访问主要页面；普通 QQ 用户只读后台正常。

回滚（V2.0.0 → V1.x，30 秒内）：

```bash
# 服务器保留旧版 release 包 + data 快照；把 systemd ExecStart 切回单进程
sudo systemctl stop ai-project
# 恢复旧版 dist（或 BOT_ROLE=legacy 入口）
sudo systemctl start ai-project
```

## 发布

- 当前版本：`v2.0.0`
- npm 包名：`ubot`
- GitHub：`https://github.com/Jelix-o/ubot-ai-agent`
- 发布说明：`RELEASE-v2.0.0.md`
- Node.js：`>=22.0.0`
- 发布说明：`RELEASE-v2.0.0.md`
- GitHub 分支：`main`
- GitHub Release tag：`v2.0.0`

发布前必须通过：

```bash
npm test
git diff --check
```

本地后台截图验证：

```powershell
$env:ADMIN_SMOKE_SCREENSHOTS="1"
node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs
```

生成 Windows 发布包：

```bash
npm run package:win
```

更新 GitHub Release 正文并上传 Windows zip 附件：

```powershell
$env:GITHUB_TOKEN="<token with Contents/Release write permission>"
npm run release:github
```

Dry-run：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -DryRun
```
