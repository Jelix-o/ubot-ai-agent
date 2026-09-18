# UBot V3 Administrator Recovery

V3 后台使用独立管理员账号与密码。敏感操作（创建邀请、账号启停、群授权、QQ 绑定、全局设置等）要求 **10 分钟内密码复验**。

TOTP、恢复码与 `ADMIN_TOTP_ENCRYPTION_KEY` 已退休。旧文档中的 TOTP 流程不再适用。

## 首个管理员（bootstrap）

1. 设置非空 `UBOT_STATE_ENCRYPTION_KEY`；若账户表为空，再设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（**密码至少 12 位**）到持久化 `/opt/ai-project/.env`。
2. 在 `https://bot.9958.uk` 使用 bootstrap 账号密码登录。
3. 在「账号与安全」创建额外的超级管理员，并妥善保存各账号密码。
4. 将 bootstrap 账号视为应急账号，日常使用独立超管账号。

## 账号恢复

- **忘记密码 / 丢失后台登录**：在服务器交互终端执行：

  ```bash
  cd /opt/ai-project-releases/current
  npm run admin:reset-password -- --username <account> --data-dir /opt/ai-project
  ```

  脚本要求 TTY 输入并确认新密码（至少 12 位），改密后会吊销该账号全部会话，并写入审计 `password_reset_from_server_terminal`。

- 超级管理员可在后台停用账号、撤销会话、签发邀请、调整群授权。
- 不要手工改 SQLite 中的账号、会话或审计表，否则会破坏会话吊销与审计。
- 若所有超管均无法登录，优先使用服务器端改密脚本，而不是回退旧版本或恢复旧 JSON 鉴权数据。

## 权限边界

- `group_admin` 只能操作明确授予的群；不能查看 provider 密钥、健康诊断、其他管理员或全局安全设置。
- 群管理员可新增成员隐私退出，但不能重新启用；只有 `super_admin` 可恢复。
- QQ 群主/群管的自动权限**仅**覆盖其所在群的群内管理指令，不能代替网页登录。
- 会话是服务端不透明记录；改密、停用账号、撤销会话立即生效。
