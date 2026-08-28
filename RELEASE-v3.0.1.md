# UBot V3.0.1

发布日期：2026-08-28

## 修复与运维更新

- 增加已完成 V3 cutover 的安全升级模式。补丁 Release 只运行新增 SQLite migration、核验 `state_cutover=v3`，不会读取、重导入、归档或删除任何旧 JSON；部署失败时可恢复到此前的 V3 target。
- 新增 SQLite migration `9`，持久化已发送的日报结果。原始日报消息仍受七天留存限制，且使用 ingress 接收时间，延迟 worker 不会延长留存。
- 正式退休旧 QQ 管理员权限链：`superAdminUserIds`、`switcherUserIds`、共享群密码和 `#管理员` 不再产生或管理 V3 权限。存量 V3 SQLite 配置会在本次升级时清理；管理操作只通过后台账号、TOTP 和按群授权完成。
- 恢复码不再直接创建后台会话。成功验证后会撤销旧会话、旧 TOTP、恢复码和挑战，并强制完成新的 TOTP 绑定。TOTP 限流改为按账号持久化，不能用新的登录 token 绕过。
- 修复 hourly maintenance 的持久应用根，确保七天回滚归档可按期清理；补充迁移中断后未登记加密归档的清理。

## 部署

从 GitHub Release 下载匹配的 Linux 包与 SHA-256 文件，并按 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md) 执行：

```bash
UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json \
  UBOT_NGINX_CONFIG=/etc/nginx/sites-available/bot-9958 \
  bash deploy-linux-release.sh 3.0.1 ubot-3.0.1-linux.tar.gz
```

该操作只更新 `bot.9958.uk` 的 UBot release、NapCat reverse URL、相关 systemd unit 和该站点的 Nginx 配置；不修改 `sub.9958.uk`、Cloudflare 模式、UFW 或 AWS 安全组。
