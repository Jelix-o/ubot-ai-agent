# UBot V1.0.2

UBot 是基于 `NapCat + OneBot + Node.js 22 + TypeScript + Vue 3` 的 QQ 群聊机器人和群运营后台。V1.0.2 聚焦可配置记忆置信度阈值、无人值守候选入库、深度记忆去重、嘴臭模式和 MiMo TTS 干净正文合成。

## 核心能力

- 群聊对话：`@机器人 <内容>` 触发，按 `groupId:userId` 隔离上下文。
- 语音回复：支持 `#语音 <内容>`、`#唱歌 <内容>`、群语音功能开关和普通 AI 回复默认语音条。
- 普通用户只读后台：普通 QQ 用户只输入 QQ 号即可登录，只能查看这个 QQ 所在群的后台数据，不能修改系统中任何设置或内容。
- 群配置：默认语音回复是语音功能的子开关；关闭语音功能会同步关闭默认语音回复。
- 记忆系统：待处理候选记忆、长期记忆、成员画像、每日画像审查、记忆去重任务，以及可配置候选阈值、自动入库阈值和无人值守候选入库策略。
- 知识库：FAQ 可按关键词检索并注入回复上下文。
- 运维后台：总览、群配置、成员管理、候选记忆、长期记忆、画像记录、知识库、任务中心、操作审计、系统状态、Skills、指令和系统设置。
- 模型管理：按用途配置系统模型；当 `data/system-settings.json` 的 `commands` 段损坏时，可恢复默认指令并保留已配置模型和 API Key。

## 目录结构

- `src/`：机器人、后端服务、管理后台 HTTP 服务和测试。
- `admin/src/`：Vue 3 管理后台。
- `skills/`：Skill JSON 配置。
- `config/groups.json`：生产群配置。
- `data/`：生产运行数据，部署升级时必须保留。
- `dist/`：构建产物。
- `COMMANDS.md`：群内指令清单。
- `RELEASE-v1.0.2.md`：V1.0.2 发布说明。

## 本地开发

项目要求 Node.js 22。构建和测试脚本会通过 `scripts/run-node22.cjs` 使用本机 Node 22。

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

V1.0.2 本地验收：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-v1.0.2-local.ps1
```

包含本地全系统截图的验收：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-v1.0.2-local.ps1 -WithScreenshots
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
- `NAPCAT_ACCESS_TOKEN`：NapCat 访问令牌。反向连接必须使用 `Authorization: Bearer <token>`。
- `BOT_QQ`：机器人 QQ。
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

生产目录示例：`/opt/ai-project`。

升级时必须保留：

- `.env`
- `data/`
- `config/groups.json`
- 生产 NapCat 登录状态和反向 WebSocket 配置

推荐流程：

```bash
git fetch --all
git checkout -B main chatops/main
git pull --ff-only chatops main
npm ci
npm run build
systemctl restart ai-project.service
```

部署后验证：

```bash
systemctl is-active ai-project.service
journalctl -u ai-project.service -n 100 --no-pager
curl -I https://bot.9958.uk/login
curl -i https://bot.9958.uk/api/session
```

期望：

- `ai-project.service` 为 `active`。
- 日志出现 NapCat reverse WebSocket connected。
- `/login` 返回 `200`。
- 未登录访问受保护 API 返回 `401`。
- 管理员后台可登录并访问主要页面。
- 普通 QQ 用户可进入只读后台，写操作返回 `readonly_session`。

## 发布

- 当前版本：`v1.0.2`
- npm 包名：`ubot`
- Node.js：`>=22.0.0`
- 发布说明：`RELEASE-v1.0.2.md`
- GitHub 分支：`main`
- GitHub Release tag：`v1.0.2`

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
