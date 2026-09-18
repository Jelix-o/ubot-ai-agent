# UBot V3.0.23

UBot 是一个基于 `NapCat + OneBot + Node.js 22 + TypeScript + Vue` 的 QQ 群机器人和管理后台。唯一人格是会仙：她以自然、成熟的聊天方式参与对话，可协助联网查询、提醒、日报、节日倒计时、静态网页预览和受限图片生成；日常不主动谈身份标签，涉及现实可核验的信息时不会编造或承诺事实。

项目地址：[Jelix-o/ubot-ai-agent](https://github.com/Jelix-o/ubot-ai-agent)。本版发布说明见 [RELEASE-v3.0.23.md](RELEASE-v3.0.23.md)，生产运维见 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md)，一次性数据切换与故障边界分别见 [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md) 和 [docs/ROLLBACK-v3.md](docs/ROLLBACK-v3.md)。

## V3 架构

```text
NapCat / OneBot
  -> Ingress                 接收、去重、Outbox 实际发送与 QQ 回执
  -> SQLite WAL              唯一业务权威源
  -> Worker                  对话、显式记忆、知识、提醒、日报和能力编排
  -> Admin                   账号、密码登录、群授权、审计和后台 API
```

Ingress、Worker、Admin 是独立进程。生产环境由 systemd 管理三个 unit，使用 `/opt/ai-project-releases/current` 原子切换软链接。

## 主要行为

- 会仙是唯一启用的人格，角色市场、旧人格选择和运行时 `skills/` 目录已退休。
- **后台登录**：管理员账号、密码（至少 12 位）和邀请码；无 TOTP/恢复码。敏感操作要求 10 分钟内密码复验。服务器可用 `npm run admin:reset-password -- --username <account>` 交互重置密码。
- **群内权限**：后台已绑定账号按角色与群授权继承；QQ 群主与群管理员自动获得本群群内管理指令权限，不能登录后台或管理其他群。
- 旧 `superAdminUserIds`、`switcherUserIds`、共享群密码与群内 `#管理员` 管理已退休，不再作为后台或 V3 授权来源。
- 只有 `#记忆`、`@机器人 请记住` / `请记忆` 和管理员明确操作才会保存记忆。普通聊天不会自动抽取、推断或进入候选审核。
- 导入时只接受 `admin`、`explicit_command`、`explicit_request` 来源的记忆。候选记忆、自动画像、旧人格和旧对话素材进入加密的七天回滚归档，不进入运行数据库。
- 原始群消息和附件元数据保留最多七天。日报保留结果，不依赖长期保存的原始内容。
- OpenAI-compatible provider 保留，Anthropic 使用官方 SDK 和明确的 capability 合约处理流式、视觉、超时与降级。
- `#网页 <需求>`、`#html <需求>` 或明确 `@会仙 生成网页/HTML/静态页面` 会创建一个独立、30 天有效的静态预览链接。页面允许自包含 HTML/CSS、浏览器端 JavaScript 和受限的内联 SVG/CSS 动画；主回复模型暂时不可用时可静默切换到严格绑定的 `ds` 回复模型。预览发布在 `https://preview.9958.uk`，绝不与后台 Cookie 或 API 共用 `bot.9958.uk` 域。
- `#画图 <提示词>` 和 `#生图 <提示词>` 仅允许绑定后台超级管理员账号的 QQ 使用；其他成员调用时静默，所有群统一可用且不提供群级开关。
- 语音、唱歌与 TTS 配置已退休；相关 API 返回 `voice_feature_retired`。
- 未授权访问 `/api/health` 返回 `401` 是预期行为，不是健康检查失败。

完整群内命令见 [COMMANDS.md](COMMANDS.md)。

## 本地开发

要求：Node.js `>=22`。

```bash
npm ci
npm test
npm run dev:admin
```

## 必要配置

| 配置 | 作用 |
| --- | --- |
| `BOT_QQ` | 机器人 QQ 号 |
| `NAPCAT_MODE` / `NAPCAT_REVERSE_WS_*` | NapCat reverse WebSocket |
| `NAPCAT_ACCESS_TOKEN` | 非本地 ingress 监听时必须设置 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 默认回复模型 |
| `ADMIN_HTTP_*` | 后台监听与公开 HTTPS 地址 |
| `HTML_PREVIEW_PUBLIC_BASE_URL` / `HTML_PREVIEW_ROOT` | 预览域与页面目录 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | **仅账户表为空时**导入第一个超管；密码至少 12 位 |
| `UBOT_STATE_ENCRYPTION_KEY` | V3 状态主密钥（32-byte，hex/base64url） |

`ADMIN_SESSION_SECRET` 与 `ADMIN_TOTP_ENCRYPTION_KEY` 已退休。运维恢复见 [docs/ADMIN-RECOVERY-v3.md](docs/ADMIN-RECOVERY-v3.md)。

## 打包与部署

发布前执行：

```bash
node scripts/run-node22.cjs scripts/test.cjs
node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs
npm run package:all
```

Linux 生产部署命令见既有运维文档；部署脚本版本号需与 `package.json` / Release 资产一致。
