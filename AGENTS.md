# UBot Agent & Deployment Guidelines

## 服务器与部署环境 (gcp-admin)

- **主机别名**：`gcp-admin`（已配置在本地 `~/.ssh/config` 中，用户为 `codex-admin`，IP: `136.119.9.221`，公钥鉴权）。
- **常用 SSH 命令**：
  ```bash
  ssh gcp-admin "<command>"
  ```
- **服务器路径体系**：
  - 应用根目录：`/opt/ai-project`（存放持久化 `.env` 与 `data/` 目录）
  - 发布版本目录：`/opt/ai-project-releases/`
  - 当前运行软链：`/opt/ai-project-releases/current`
  - 前端静态文件目录：`/opt/ai-project-releases/current/dist/admin/`
- **核心 Systemd 服务**：
  - `ubot-admin.service`：后台 HTTP 服务（监听 `127.0.0.1:6200`，由 Nginx 反代在 `https://bot.9958.uk/`）
  - `ubot-ingress.service`：NapCat 反向 WebSocket 与入站服务（端口 `6199`、`6198`）
  - `ubot-worker.service`：会话处理、排程与模型编排核心
- **服务管理命令**：
  ```bash
  ssh gcp-admin "sudo systemctl status ubot-admin ubot-ingress ubot-worker --no-pager"
  ssh gcp-admin "sudo systemctl restart ubot-admin"
  ```

## Git 与发布账号规范

- **Git 账号**：`Jelix-o`
- **邮箱**：`yinzhixiu@qq.com`
- **GitHub 仓库**：`https://github.com/Jelix-o/ubot-ai-agent`
- **Release 流程**：
  1. 更新 `package.json`、锁文件与 `README.md` 的本版更新标记区域；运行 `node scripts/run-node22.cjs scripts/public-docs.mjs release-notes` 生成发布说明。只有已获批准的发布计划明确要求时，才随版本保留 `RELEASE-v<version>.md`；
  2. 本地执行 `npm run verify`、`npm run smoke:admin` 与 `npm run package:all`；
  3. 提交并打标签 `git tag -a v<version> -m "UBot v<version>"` 并推送到 GitHub；
  4. 标签推送只触发 GitHub Actions 校验和双平台构建。正式 GitHub Release 只能在匹配标签上手动触发工作流、显式设定 `publish=true`，并通过受保护的 `production-release` Environment 审批后创建。

- 使用、指令、部署与恢复说明统一维护在 README；除已批准的发布计划外不新增逐版本 Markdown。
- 公开文档和 Release 禁止包含真实群聊成员称呼、备注、QQ、群号、画像、聊天原文或定点修复对象。示例使用成员甲／成员乙及 `<USER_ID>`、`<GROUP_ID>`、`<BOT_QQ>`。
- 发布前必须运行文档检查并人工复核姓名与案例；检查失败不得绕过。旧 Release 脱敏原文仅备份在仓库外私有目录。
