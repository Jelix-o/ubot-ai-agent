# UBot V1.0.0

UBot 是基于 `NapCat + OneBot + Node.js 22 + TypeScript + Vue 3` 的 QQ 群聊机器人和群运营后台。V1.0.0 聚焦生产可用闭环：群聊回复、语音回复、唱歌、长期记忆、成员画像、FAQ 知识库、任务中心、模型健康、操作审计和公网后台运维。

## 核心能力

- 群聊对话：`@机器人 <内容>` 触发，按 `groupId:userId` 隔离上下文。
- 语音回复：支持 `#语音 <内容>`、群默认语音回复开关，以及 `#唱歌 <内容>`。
- MiMo TTS v2.5：目标文本放在 `assistant` 消息，自然语言风格指令放在 `user` 消息，音频标签放在 `assistant` 内容中。
- Skill 管理：每个 skill 可配置整体 TTS 风格提示、TTS 音色、方言和人设腔调；句子情绪、语调、语速和哭笑表达由系统按语义自动处理。
- 群配置：群开关、回复模型、管理员、实时对话、日报、节假日、定时任务、黑名单、记忆收集和默认语音回复。
- 成员管理：合并 NapCat 群成员、人工身份和记忆归属，可编辑备注，编辑时自动带出现有备注。
- 记忆系统：待处理候选记忆、长期记忆、成员画像、每日画像审查和记忆去重任务。
- 知识库：当前群 FAQ 按关键词检索注入回复上下文。
- 运维后台：公网管理台、模型健康历史、任务中心、操作日志、系统状态、静态资源缓存保护和后台路由预取保护。

## 目录结构

- `src/`：机器人、服务端和测试源码。
- `admin/src/`：Vue 3 管理后台。
- `skills/`：skill JSON 配置。
- `config/groups.json`：群配置和管理员配置。
- `data/`：生产运行数据，部署升级时必须保留。
- `dist/`：构建产物。
- `COMMANDS.md`：群内指令清单。
- `RELEASE-v1.0.0.md`：V1.0.0 发布说明。

## 本地开发

推荐 Node.js 22。

```bash
npm install
npm run dev
```

后台开发：

```bash
npm run dev:admin
```

构建和测试：

```bash
npm run build
npm test
```

Windows 本机可直接使用项目内的 Node 22 包装脚本；现代构建和测试不要使用旧 Node。

## 环境变量

复制模板后填写：

```powershell
Copy-Item .env.example .env
```

关键变量：

- `NAPCAT_MODE`：`forward` 或 `reverse`。
- `NAPCAT_WS_URL`：正向 WebSocket 地址。
- `NAPCAT_REVERSE_WS_HOST`、`NAPCAT_REVERSE_WS_PORT`、`NAPCAT_REVERSE_WS_PATH`：反向 WebSocket 监听配置。
- `NAPCAT_ACCESS_TOKEN`：NapCat 访问令牌。反向连接必须使用 `Authorization: Bearer <token>`，不要把 token 放在 URL query。
- `BOT_QQ`：机器人 QQ。
- `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`：普通回复模型。
- `PROFILE_AI_BASE_URL`、`PROFILE_AI_API_KEY`、`PROFILE_AI_MODEL`：画像、记忆、去重和总结模型。
- `TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`、`TTS_VOICE`、`TTS_AUDIO_FORMAT`：语音模型。
- `TTS_STYLE_HINT`：全局 TTS 风格提示。
- `TTS_ALLOW_NAPCAT_AI_FALLBACK`：普通语音失败时是否回退 NapCat AI 语音。
- `ADMIN_HTTP_ENABLED`、`ADMIN_HTTP_HOST`、`ADMIN_HTTP_PORT`：后台 HTTP 服务。
- `ADMIN_PUBLIC_BASE_URL`：公网后台地址。
- `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_GROUP_PASSWORD`、`ADMIN_SESSION_SECRET`：后台登录和会话。

## 群配置

配置文件默认是 `config/groups.json`。Windows 发布包只附带安全的 `config/groups.example.json`；首次运行 `run.cmd` 时如果没有 `config/groups.json`，会自动复制这个空白示例，生产升级时不要覆盖已有 `config/groups.json`。

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
          "names": ["前端哥"],
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
- `defaultVoiceReplyEnabled`：普通 AI 回复是否默认发送语音条；系统指令仍返回文字。
- `manualIdentities`：人工身份和备注，优先于群名片和昵称用于成员识别。
- `memoryDisabledUserIds`：禁用指定成员的记忆收集。

## MiMo TTS v2.5 规则

UBot 的 TTS 请求严格按 MiMo V2.5 文档组织：

- 目标合成文本只放在 `messages` 中 `role: "assistant"` 的内容里。
- 自然语言风格、导演模式、整体提示只放在 `role: "user"` 的内容里，不会被读出。
- 音频标签写在 assistant 文本里；系统会按句子生成 `(基础情绪 复合情绪 整体语调 音色定位)[语速节奏 情绪状态 语音特征 哭笑表达]正文`，例如 `(开心 欣慰 活泼 清亮)[激动]今天状态不错！`。
- `mimo-v2.5-tts` 使用预置音色，支持 `(唱歌)` 标签。
- `mimo-v2.5-tts-voicedesign` 使用文本音色设计，设置 `audio.optimize_text_preview = true`，不发送预置 `audio.voice`，不支持唱歌。
- `mimo-v2.5-tts-voiceclone` 用音频样本复刻音色，不支持唱歌和预置音色。

预置音色：

- `mimo_default`
- `冰糖`
- `茉莉`
- `苏打`
- `白桦`
- `Mia`
- `Chloe`
- `Milo`
- `Dean`

Skill 可手工配置的稳定风格维度：

- 方言：`东北话`、`四川话`、`河南话`、`粤语`
- 人设腔调：`夹子音`、`御姐音`、`正太音`、`大叔音`、`台湾腔`

基础情绪、复合情绪、整体语调、音色定位、语速节奏、情绪状态、语音特征和哭笑表达不再作为 skill 手工设置项；TTS 生成时按每句话语义自动匹配，避免固定配置压过自然表达。

## 群内指令

完整清单见 [COMMANDS.md](COMMANDS.md)。

常用指令：

- `#功能`
- `#技能 列表`
- `#技能 切换 <skillId>`
- `#模型状态`
- `#模型切换 <modelId|gpt|mimo>`
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

## 公网后台

启用：

```env
ADMIN_HTTP_ENABLED=true
ADMIN_HTTP_HOST=127.0.0.1
ADMIN_HTTP_PORT=6200
ADMIN_PUBLIC_BASE_URL=https://bot.9958.uk
```

生产建议：

- Nginx 只反代后台 HTTP 服务，不暴露 NapCat 反向 WebSocket。
- 静态资源 hash 缺失时返回 `404 asset_not_found` 且 `Cache-Control: no-store`，避免旧 chunk 回退到 SPA 造成 503 或白屏。
- 登录后用 CSRF 会话保护管理 API；未登录访问管理 API 应返回 `401`。
- 后台 HTML、302 登录跳转和 `/api/*` 响应返回 `Cache-Control: private, no-store`；源站提供空的 `/admin-speculation-rules.json`，避免 Cloudflare Speed Brain 或浏览器预取把 `/memories`、`/groups` 等后台路径缓存成 `503 Service Unavailable (from prefetch cache)`。
- 侧边栏导航复用已加载的会话状态，避免每次点击菜单都重复等待 `/api/session`。

后台模块：

- 总览：候选记忆、长期记忆、系统状态和知识库概览。
- 群配置：群开关、模型、技能、语音、日报、节假日、提醒和权限。
- 成员管理：成员搜索、备注编辑、画像记录、记忆收集开关和成员记忆跳转。
- 候选记忆：审核、批量批准、拒绝和证据查看。
- 长期记忆：启停、编辑、删除、成员筛选和去重任务。
- 画像记录：昨日画像、整体画像和公开链接管理。
- 知识库：FAQ 增删改查和导入预览。
- 任务中心：后台任务列表、详情、时间线、结果和失败原因。
- 操作审计：管理员操作日志。
- 系统状态：模型检测、NapCat、服务器和模型健康历史。
- Skills 管理：skill JSON、导入导出、备份恢复和 MiMo TTS 风格配置。
- 指令管理：内置指令文案、别名和启停。

## 任务中心

任务数据保存在 `data/admin-tasks.json`。

V1.0.0 会在读取任务列表或任务详情时自动判断陈旧任务：

- 普通 queued/running 任务超过 30 分钟未更新会标记失败。
- `model-check` 任务超过 10 分钟未更新会标记失败。
- 当前进程内正在执行的任务不会被误判。
- 失败任务会写入 `finishedAt`、`durationMs`、`progress: 100` 和自动失败原因。

这用于处理生产中残留的“模型检测 环境语音模型”长期执行中状态。

## 部署升级

生产目录示例：`/opt/ai-project`。

升级时必须保留：

- `.env`
- `data/`
- `config/groups.json`
- 生产 NapCat 登录态和反向 WebSocket 配置

Windows 发布包不会携带本机真实 `config/groups.json`，只带 `config/groups.example.json`；首次运行时缺少 `groups.json` 才会复制示例。不要用发布包覆盖上述运行数据。推荐流程：

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
- 日志存在 NapCat reverse WebSocket connected。
- `/login` 返回 `200`。
- 未登录访问受保护 API 返回 `401`。
- 公网后台可登录并访问总览、任务中心、系统状态、群配置和 Skills 管理。

## 发布

- 当前版本：`v1.0.0`
- npm 包名：`ubot`
- Node.js：`>=22.0.0`
- 发布说明：`RELEASE-v1.0.0.md`
- GitHub 分支：`chatops/main`
- GitHub Release tag：`v1.0.0`
- 若 `v1.0.0` tag 已存在，发布前必须确认它指向包含当前 V1.0.0 变更的最终提交。

发布前必须通过：

```bash
npm test
git diff --check
```
