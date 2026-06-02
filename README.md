# NapCat QQ 群聊 Skill AI 机器人

这是一个基于 `NapCat + OneBot + Node.js + TypeScript` 的 QQ 群聊机器人项目，适合和 NapCat 部署在同一台 Windows 机器上使用。

它已经支持：

- 群内 `@机器人` 才触发对话
- 支持把群聊回复/引用消息作为 AI 参考，不改变原有触发规则
- 多 skill 切换
- 图片理解
- MiMo TTS 语音回复
- 实时对话
- 群定时任务提醒
- 群聊日报
- 中国节假日倒计时
- 健康检查与管理员操作日志
- 自动运维告警
- 群管理员 / 超级管理员权限体系

## 功能概览

- 普通成员可直接使用：
  - `@机器人 <内容>`
  - `#语音 <内容>`
  - `@机器人 语音说 <内容>`
  - `#功能`
  - `#技能 列表`
  - `#对话 清空`
  - `#日报 状态`
  - `#节假日`
  - `#定时任务 列表`
- 群管理员可使用全部系统指令：
  - `#状态`
  - `#健康检查`
  - `#服务器`
  - `#告警`
  - `#操作日志`
  - skill 切换
  - 实时对话管理
  - 日报配置
  - 节假日倒计时配置
  - 查看管理员列表
- 超级管理员额外可使用：
  - `#管理员 添加 <QQ号>`
  - `#管理员 移除 <QQ号>`

## 目录结构

- `src/`：项目源码
- `skills/`：技能人格配置
- `config/groups.json`：群配置、管理员配置、超级管理员配置
- `data/conversations.json`：按 `groupId:userId` 保存的个人对话上下文
- `data/daily-report-store.json`：日报发送状态
- `data/holiday-countdown-store.json`：节假日倒计时发送状态
- `data/scheduled-reminders.json`：群定时任务
- `data/admin-operations.jsonl`：管理员操作日志
- `COMMANDS.md`：系统全部指令说明
- `.env.example`：通用环境变量模板
- `.env.server-2022.example`：Windows Server 2022 模板

## 安装依赖

```bash
pnpm install
```

如果你用 `npm` 也可以：

```bash
npm install
```

## 本地开发

```bash
pnpm run dev
```

## 构建与运行

```bash
pnpm run build
pnpm start
```

## 环境变量

先复制模板：

```bash
copy .env.example .env
```

或服务器环境：

```bash
copy .env.server-2022.example .env
```

然后按文件内注释填写。

重点变量：

- `NAPCAT_MODE`
  - `forward`：机器人主动连 NapCat
  - `reverse`：NapCat 主动连机器人
- `NAPCAT_WS_URL`
  - 正向 WebSocket 地址
- `NAPCAT_ACCESS_TOKEN`
  - NapCat 访问令牌
- `NAPCAT_REVERSE_WS_HOST`
  - 反向 WebSocket 监听地址
- `NAPCAT_REVERSE_WS_PORT`
  - 反向 WebSocket 监听端口
- `NAPCAT_REVERSE_WS_PATH`
  - 反向 WebSocket 路径
- `OPENAI_BASE_URL`
  - 文本模型兼容接口地址
- `OPENAI_API_KEY`
  - 文本模型密钥
- `OPENAI_MODEL`
  - 文本模型名
- `TTS_BASE_URL`
  - 语音合成接口地址
- `TTS_API_KEY`
  - 语音合成密钥
- `TTS_MODEL`
  - 默认语音模型
- `TTS_VOICE`
  - 默认音色
- `TTS_AUDIO_FORMAT`
  - 语音输出格式，默认 `wav`
- `TTS_STYLE_HINT`
  - 全局附加语音风格提示，可留空
- `TTS_ALLOW_NAPCAT_AI_FALLBACK`
  - TTS 失败时是否允许回退 NapCat AI 语音
- `BOT_QQ`
  - 机器人自己的 QQ 号

## 群配置文件

配置文件路径：

- [`config/groups.json`](/D:/development/AI-Project/config/groups.json)

示例结构：

```json
{
  "superAdminUserIds": ["1569671790"],
  "groups": [
    {
      "groupId": "866209871",
      "currentSkillId": "zxp",
      "allowedSkillIds": ["leijun", "zxp", "jackma"],
      "switcherUserIds": ["1569671790"],
      "liveChatUserIds": ["2684837849"],
      "liveChatDelayMinutes": 1,
      "dailyReportEnabled": true,
      "dailyReportTime": "17:59",
      "dailyReportTopUserCount": 5,
      "holidayCountdownEnabled": true,
      "holidayCountdownTime": "09:00",
      "manualIdentities": [
        {
          "userIds": ["1967410653"],
          "names": ["小菜鸡", "前端哥"]
        },
        {
          "userIds": ["927345463", "1551925371"],
          "names": ["渣渣辉"]
        }
      ]
    }
  ]
}
```

字段说明：

- `superAdminUserIds`
  - 全局超级管理员 QQ 列表
  - 超级管理员拥有所有系统权限
  - 只有超级管理员可以增删群管理员
- `groupId`
  - 机器人允许工作的群号
- `currentSkillId`
  - 当前群默认 skill
- `allowedSkillIds`
  - 本群允许切换的 skill 列表
- `switcherUserIds`
  - 本群管理员 QQ 列表
  - 这是历史字段名，现在语义上等同“群管理员”
- `liveChatUserIds`
  - 开启实时对话跟踪的 QQ 列表
- `liveChatDelayMinutes`
  - 机器人最后一次发言后，需要安静多久才允许实时对话触发
- `dailyReportEnabled`
  - 是否开启日报
- `dailyReportTime`
  - 工作日自动发送日报的时间
- `dailyReportTopUserCount`
  - 日报里统计的活跃用户数量
- `holidayCountdownEnabled`
  - 是否开启节假日倒计时
- `holidayCountdownTime`
  - 每天自动发送节假日倒计时的时间
- `manualIdentities`
  - 本群人工维护的身份记忆，用于 AI 对话时按 QQ 号识别成员
  - `userIds` 支持一个身份绑定多个 QQ，`names` 支持多个常用称呼或外号
  - AI 会以 QQ 号为准，昵称和群名片只作参考，减少冒充误判

## NapCat 接入

### 正向 WebSocket

适合机器人主动去连 NapCat：

```env
NAPCAT_MODE=forward
NAPCAT_WS_URL=ws://127.0.0.1:3001
```

### 反向 WebSocket

适合 NapCat 主动连接机器人，推荐你现在这种部署方式：

```env
NAPCAT_MODE=reverse
NAPCAT_REVERSE_WS_HOST=127.0.0.1
NAPCAT_REVERSE_WS_PORT=6199
NAPCAT_REVERSE_WS_PATH=/onebot/ws
NAPCAT_ACCESS_TOKEN=你的token
```

NapCat 里对应填写：

- URL：`ws://127.0.0.1:6199/onebot/ws`
- Token：和 `NAPCAT_ACCESS_TOKEN` 保持一致

注意：

- 不要把 NapCat WebUI 调试页的 `/api/Debug/ws` 当正式运行地址
- WebUI 调试页只适合手工联调，不适合作为机器人长期接入地址

## Skill 配置

每个 skill 位于 `skills/*.json`

至少需要这些字段：

- `id`
- `name`
- `systemPrompt`
- `styleRules`
- `knowledge`
- `temperature`
- `maxContextTurns`

可选增强字段：

- `ttsStyleHint`
- `exampleExchanges`
- `maxReplyCharsPerMessage`
- `maxTotalReplyChars`
- `maxReplyMessages`
- `preferredMaxReplyMessages`
- `allowBurstOnHighEmotion`
- `highEmotionKeywords`

## 系统指令

完整指令清单请看：

- [COMMANDS.md](COMMANDS.md)

常用指令速览：

- `#功能`
- `#技能 列表`
- `#技能 切换 <skillId>`
- `#语音 <内容>`
- `#对话 清空`
- `#clear`
- `#实时对话 列表`
- `#实时对话 添加 <QQ号>`
- `#状态`
- `#健康检查`
- `#服务器`
- `#告警 状态`
- `#操作日志`
- `#记忆 状态`
- `#知识库 状态`
- `#日报 状态`
- `#节假日`
- `#管理员 列表`
- `#闭嘴` / `#说话`
- `#拉黑 <QQ号>`

## Windows Server 2022 部署

推荐流程：

1. 安装 Node.js 22
2. 安装 NapCat，并确认 QQ 已登录
3. 上传或解压本项目到固定目录
4. 复制环境变量模板为 `.env`
5. 填写 `.env`
6. 修改 `config/groups.json`
7. 安装依赖并构建
8. 启动项目

示例：

```bat
cd /d D:\apps\napcat-qq-skill-bot
pnpm install
pnpm run build
pnpm start
```

## Windows 打包

```bash
pnpm run package:win
```

输出位置：

- `release/<项目名>-<版本>-win/`
- `release/<项目名>-<版本>-win.zip`

## 开机自启

注册：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-startup-task.ps1
```

取消：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\unregister-startup-task.ps1
```

## 测试

```bash
pnpm test
```

## 对话与引用规则

- 普通 `@机器人` 对话不自动 `@` 发言人，也不会自动 `@` 用户消息里提到的第三方。
- 实时对话主动回复只会 `@` 被跟踪的发言人；如果该发言人消息里 `@` 了第三方，第三方只作为 AI 语义上下文。
- `866209871` 群里普通消息包含“乘风”时会触发主动对话，机器人只会 `@` 发言人。
- 群聊回复/引用消息会尝试通过 NapCat `get_msg` 读取原消息、发送者和图片概况，传给 AI 作为参考；读取失败不影响当前回复。
- AI 正文里的第三方 `@QQ`、`@名字` 或 CQ at 会被降级成普通 QQ/名字，避免误触发第三方提醒。
- `manualIdentities` 优先于群名片和昵称，用于识别被提到或被引用的人；回复时优先使用配置里的第一个名字，找不到配置时再使用群名片/昵称。
- 配置了 `manualIdentities` 的群里，普通 `@机器人` 对话可触发受控 `@`：机器人先按人格决定是否愿意叫人，程序再按身份表唯一命中后最多 CQ `@` 1 人。
- 同一个群最多并发处理 10 条消息；超过 10 条会排队，不再发送忙碌提示。

## 定时任务

- `@机器人 设置定时任务一个小时提醒群友喝水` 会在当前群创建每小时提醒任务。
- `#定时任务 列表` 查看当前群任务。
- `#定时任务 添加 每30分钟提醒群友站起来活动` 创建任务。
- `#定时任务 删除 <任务ID>` 删除任务。
- `#定时任务 关闭` 暂停当前群全部定时任务触发，不删除任务。
- `#定时任务 开启` 恢复当前群全部定时任务触发。
- `#定时任务 状态` 查看当前群定时任务总开关。
- 定时提醒持久化在 `data/scheduled-reminders.json`，每次提醒会优先让 AI 换一种说法，失败时使用本地兜底文案。

## 闭嘴模式

- 群管理员或超级管理员可用 `#闭嘴` 让当前群机器人停止普通对话、语音、复读、乘风触发和实时对话。
- 闭嘴后仍保留聊天总结、日报、节假日倒计时、定时任务提醒及这些功能的管理命令。
- `#说话` 恢复当前群普通对话能力；闭嘴状态按群保存，不影响其他群。

## 状态与运维

- 群管理员或超级管理员可用 `#状态` 查看当前群机器人总览。
- `#健康检查` / `#健康` 会检查 NapCat 连接、当前技能、允许技能、定时任务、日报和节假日配置。
- `#服务器` 查看机器人进程所在服务器的主机、Node、运行时长、负载、内存、工作目录和 NapCat 连接状态。
- `#记忆 状态` 查看当前群长期记忆和待审核候选数量。
- `#知识库 状态` 查看当前群 FAQ 数量和关键词检索状态。
- `#告警 状态 / 开启 / 关闭` 管理当前群是否接收自动运维告警；告警覆盖服务启动、NapCat 断连/恢复、连续发送失败和内存过高。
- `#操作日志` 查看当前群最近 10 条管理员操作，包括闭嘴、黑名单、实时对话、技能切换、定时任务和管理员变更。
- 这些命令在闭嘴模式下仍可使用；被拉黑用户仍保持静默。

## V2 后台、群记忆和知识库

- 设置 `ADMIN_HTTP_ENABLED=true` 后会启动独立后台服务，默认监听 `127.0.0.1:6200`。
- 生产建议通过 Nginx 将 `https://bot.9958.uk` 反代到 `http://127.0.0.1:6200`，不要暴露 NapCat 反向 WebSocket。
- 后台登录使用 `.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，会话由 `ADMIN_SESSION_SECRET` 签名。
- 群记忆长期数据保存在 `data/group-memory.json`；自动提炼候选保存在 `data/group-memory-candidates.json`，候选必须在后台批准后才会进入 AI 上下文。
- 文本 FAQ 知识库保存在 `data/knowledge-base.json`，机器人对话前会按关键词检索当前群启用 FAQ，最多注入 Top 3 条。
- `manualIdentities` 仍然是身份识别最高优先级；群记忆只补充偏好、稳定事实、群规则和固定梗，不覆盖 QQ 身份表。
- 后台“成员管理”会合并 NapCat 群成员、`manualIdentities` 和已有记忆归属，展示 QQ、群名片、昵称、系统备注、长期记忆数和待审候选数。
- 成员备注和别名仍写入当前群 `manualIdentities`；成员画像候选必须选择具体 QQ 后才能按成员画像批准，也可以转为群事实后批准。

## 黑名单

- 群管理员或超级管理员可用 `#拉黑 <QQ号>` 拉黑当前群指定成员。
- `#拉黑 解除 <QQ号>` 解除拉黑；黑名单按群保存，不影响其它群。
- 被拉黑成员的发言仍进入日报和聊天总结统计，但机器人不会回复他的普通对话、语音、实时对话、关键词、复读或其它命令。

## 分享项目给别人

如果你要把项目发给别人，建议不要直接发正在运行的目录。

推荐发脱敏分享包：

- [分享包目录](/D:/development/AI-Project/share/napcat-qq-skill-bot-share)
- [分享包压缩文件](/D:/development/AI-Project/share/napcat-qq-skill-bot-share.zip)

这样不会带上你的真实 `.env`、API Key、对话历史和生产群配置。
