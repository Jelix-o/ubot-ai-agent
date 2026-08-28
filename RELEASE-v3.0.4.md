# UBot V3.0.4

发布日期：2026-08-28

## 本版更新

- 新增会仙静态网页预览。群成员可使用 `#网页 <需求>`、`#html <需求>`，或明确 `@会仙` 要求生成网页、HTML、静态页面；每次生成独立的 `https://preview.9958.uk/p/<43 位随机 ID>/` 地址，30 天后自动删除。
- 网页生成复用当前群回复模型，需求最多 4,000 字。模型只能输出自包含 HTML、内联 CSS 与浏览器端 JavaScript；系统净化并拒绝网络请求、外链、表单、嵌入对象、跳转、危险 URL、事件属性与路径穿越。
- 新增 SQLite migration `10` 和预览发布元数据。运行库不保存原始需求、模型思考或页面 HTML；同一 `group_id + source_message_id` 幂等，群内任务按提交顺序处理，Worker 重试不会重复发送预览链接。
- 新增后台“网页预览”页和受群授权的查看/删除 API。后台只显示元数据，不渲染生成 HTML；删除和开关操作被审计。
- 新增每小时清理：删除到期页面、失效租约、临时目录与孤儿文件。原始群消息仍保持七天留存，网页本体保留三十天。

## 隔离与部署

- 预览页只由独立 `preview.9958.uk` 静态 Nginx vhost 提供，不代理 `6200`，不暴露后台、Cookie 或 API，也不改写 `bot.9958.uk`、`sub.9958.uk`、UFW 或 AWS 安全组。
- vhost 仅允许 `GET`/`HEAD`，关闭目录列表和符号链接，限定随机页面路径，并设置 `no-store`、`noindex`、`nosniff`、Referrer-Policy、CSP 和 iframe sandbox 响应约束。
- 发布器把页面保留在 `/opt/ai-project/data/generated-pages`，不会写进 Release 包；切换时备份预览 Nginx 独立文件与持久页面状态。失败只恢复 release 指针和配置，不自动回滚 SQLite、网页状态或历史 Outbox。
- Cloudflare Origin 证书是首选。若无法取得 Origin 证书，可通过 `UBOT_PREVIEW_CERT_PATH` 与 `UBOT_PREVIEW_KEY_PATH` 指向匹配的宿主证书（例如 Let’s Encrypt），无需修改 Cloudflare 全局 SSL 模式；HTTP vhost 保留 `/.well-known/acme-challenge/` 以支持后续证书续期。

## 发布后检查

1. 确认 `ubot-ingress.service`、`ubot-worker.service`、`ubot-admin.service` 均为 active，`ai-project.service` 保持 disabled/inactive。
2. 确认 `https://preview.9958.uk/p/not-a-valid-token/` 返回 `404`，响应中没有 `Set-Cookie`；确认 `https://bot.9958.uk/` 和 `https://sub.9958.uk/` 保持原有服务。
3. 在已启用群执行一次 `#网页 做一个简单计时器`，确认 QQ 收到新链接、页面可打开，后台可看到元数据并可删除该页面。
