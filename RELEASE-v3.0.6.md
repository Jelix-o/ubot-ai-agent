# UBot V3.0.6

发布日期：2026-08-28

## 本版更新

- 修复静态预览根链接的 Nginx 文件解析：`/p/<43 位 ID>/` 现在内部改写到唯一的 `/index.html` 文件路由，不再产生 `index.htmlindex.html` 和 HTTP 500。
- 保留原有公开 URL、无缓存响应头、CSP、iframe sandbox、随机令牌限制以及 `content.html` 隔离策略。
- 增加模板回归测试，禁止在尾斜杠正则 location 中重新使用文件型 `alias`。

## 兼容性

- 本版包含 V3.0.5 的 `.env` UTF-8 BOM 防回归修复。
- 不新增数据库迁移，SQLite schema 仍为 migration `10`。
- 不改变群命令、后台 API、认证、页面格式或生产端口边界。

## 发布后检查

1. 用真实发布流程创建临时页面，确认根链接返回 `200`，而不是只验证不存在令牌的 `404`。
2. 执行到期清理后确认记录为 `expired`、根链接返回 `404`，且未留下测试 Outbox 或页面目录。
3. 确认三个 UBot 服务、Nginx 与维护计时器均为 active，SQLite migration 保持 1–10。
