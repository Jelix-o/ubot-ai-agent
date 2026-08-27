# UBot V3.0.0

发布日期：2026-08-27

## 正式版变化

- SQLite 从消息链路与配置影子升级为 V3 的唯一业务权威源，新增 migration `5` 至 `8`，覆盖控制配置/会仙角色、内容与排程、管理员认证、留存与切换元数据。
- 会仙成为唯一 Character Profile；会仙资料、修订历史、Knowledge Pack 和 Capability Policy 持久化到 SQLite。旧人格市场、角色切换、候选记忆、自动记忆、自动画像与公开画像接口已退休。
- 仅导入成员或管理员明确保存的记忆来源：`admin`、`explicit_command`、`explicit_request`。旧候选、自动画像、历史人格、conversations/topics 和旧运行文件会被放入加密的七天受限回滚归档，切换后不再参与运行。
- 新增七天原始消息/附件元数据留存与每小时 maintenance timer；留存以接收时间为准，外部 OneBot 时间戳不能延长留存。日报继续保存产出结果，不长期保存过期群消息原文。
- 新增独立账号、密码、TOTP、一次性恢复码、可撤销服务器端会话、CSRF/Origin 防护、持久化登录限流和管理员审计。角色只有 `super_admin` 与按群授权的 `group_admin`。
- Anthropic provider 使用官方 SDK；provider capability 合约明确流式、视觉、超时和降级能力。OpenAI-compatible provider 保持可用。
- Linux 生产改为 `ubot-ingress`、`ubot-worker`、`ubot-admin` 三个独立 unit 和 `ubot.target`，用 `/opt/ai-project-releases/current` 原子选择 release。
- 发布流程同时生成 Windows ZIP、Linux tar.gz 和两个 SHA-256 文件；GitHub Actions 在双平台完整测试和摘要复核后创建 Release。
- 新增独立的 [V3 迁移说明](docs/MIGRATION-v3.md)、[管理员恢复说明](docs/ADMIN-RECOVERY-v3.md)、[生产运维说明](docs/OPERATIONS-v3.md) 和 [回滚边界说明](docs/ROLLBACK-v3.md)。

## 升级要求

1. 完整运行 `npm ci`、`npm test`、`npm run package:all` 和 `npm run verify:release`。
2. 在生产 `.env` 设置非空的 `UBOT_STATE_ENCRYPTION_KEY`；V3 以 HKDF 派生 TOTP 和回滚归档密钥。不要把该值写入发布资产或日志。
3. 确认可重试 Outbox 已排空，停止旧 `ai-project.service`，并使用 Linux 部署脚本执行一次性迁移。
4. 配置 NapCat Docker reverse WebSocket URL 为 `ws://172.21.0.1:6199/onebot/ws`。部署脚本在验证后更新指定 NapCat JSON 文件并保留其发布前副本；V3 三个进程就绪后会受控重启 `napcat` 容器，使其加载新 URL。
5. 切换后验证三个 unit、HTTPS 登录、TOTP 绑定，以及每个既有参与策略下的 `@机器人` 和可信机器人消息引用。

## 兼容性与回滚

- 此版本是一次性数据权威源切换。迁移前的部署失败可恢复 release 选择、systemd 模板和 NapCat 配置。
- 一旦 V3 cutover marker 已写入，部署程序不会自动恢复旧 SQLite、启动 `ai-project.service` 或重放任何 Outbox 行。此时按 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md) 的人工灾难恢复流程处理。
- 旧人格素材和自动数据只有 V3 加密七天归档可用于受控恢复；它们不会回到运行时。
