# UBot V3.0.19

UBot 是基于 `NapCat + OneBot + Node.js 22 + TypeScript + Vue` 的 QQ 群机器人和管理后台。V3 唯一人格是会仙：自然、成熟的聊天方式，可协助联网查询、提醒、日报、节日倒计时和静态网页预览；日常不主动谈身份标签，涉及现实可核验的信息时不会编造或承诺事实。

项目地址：[Jelix-o/ubot-ai-agent](https://github.com/Jelix-o/ubot-ai-agent)。本版说明见 [RELEASE-v3.0.19.md](RELEASE-v3.0.19.md)，生产运维见 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md)。

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

- 会仙是唯一启用的人格；旧人格市场与运行时 `skills/` 目录已退休。
- **后台登录**：管理员账号 + 密码（至少 12 位）+ 邀请码；无 TOTP/恢复码。敏感操作要求 10 分钟内密码复验。服务器可用 `npm run admin:reset-password -- --username <account>` 交互重置密码。
- **群内权限**：后台已绑定账号按角色/群授权继承；同时 QQ 群主与群管理员自动获得**本群群内管理指令**权限，不能登录后台。
- 旧 `superAdminUserIds`、`switcherUserIds`、共享群密码与群内 `#管理员` 管理已退休，不再作为后台或 V3 授权来源。
- 只有 `#记忆`、`@机器人 请记住` / `请记忆` 和管理员明确操作才会保存记忆。
- 语音、唱歌与 TTS 配置已退休；相关 API 返回 `voice_feature_retired`。
- `#网页` / `#html` 生成独立静态预览，发布在 `https://preview.9958.uk`，与后台域隔离。
- 未授权访问 `/api/health` 返回 `401` 是预期行为。

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
