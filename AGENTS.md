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
  1. 更新 `package.json` 版本号与 `RELEASE-v<version>.md`；
  2. 本地执行全量测试 `node scripts/run-node22.cjs scripts/test.cjs` 与冒烟测试 `node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs`；
  3. 提交并打标签 `git tag -a v<version> -m "UBot v<version>"` 并推送到 GitHub；
  4. GitHub Actions 会自动构建双平台发布物并创建正式 GitHub Release。
