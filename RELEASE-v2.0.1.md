# UBot V2.0.1 Release Notes

发布日期：2026-08-13

## 重点修复

### 会仙上下文隔离

- 使用持久化 `ConversationRoute` 统一 Worker 队列、Bot 处理和 SQLite 上下文来源。
- 上下文按 `(群号, 因果分支)` 串行，并只沿父链读取；同一用户的新话题不再回退到旧个人历史。
- 1 小时内的明确引用精确恢复被引用消息的因果链；引用非末端消息会创建独立分支，兄弟分支互不可见。
- 无引用时只允许同群同用户在 10 分钟内按追问前缀或相似度规则续聊；空消息和纯图片不会自动续聊。
- 普通会仙问答不再把最近群聊原文送入模型。仅使用当前因果链、显式引用、长期记忆和脱敏群氛围摘要。

### 真实 QQ 回执与恢复

- `deliveryId` 与真实 `platformMessageId` 分离，`outbox:<id>` 不再伪装成 QQ 消息 ID。
- Ingress 发送成功后回填真实 QQ ID，并以 `(groupId, platformMessageId)` 建立消息锚点；多段回复共享同一 assistant turn。
- Outbox 草稿在 assistant turn 落库前不可发送；Worker 重试会只清理同一源消息遗留的未发布草稿。
- 消费进度按 SQLite 自增 ID 推进，失败消息可重试，不会因为时间戳乱序或已完成消息阻塞后续批次。

### 模型配置热刷新

- Admin、Worker 与 Legacy 进程会检测 `system-settings.json` 文件变化，模型更新无需重启 Worker。
- `#模型` 显示上游实际模型字段，例如 `deepseek-v4-pro`，不再显示未同步的 `shortName`。
- 配置中的 `#ds` 别名会与 `#模型` 使用同一份实时配置。

## 迁移与兼容性

首次部署 V2.0.1 时运行：

```bash
npm run migrate:context
npm run migrate:context -- --execute
```

默认命令仅预检。`--execute` 会创建 `data/context-backups/<timestamp>/` 备份，并清空短期会话、路由、消息锚点、inflight 与氛围缓存。以下数据保留：消息审计表、长期记忆、画像、知识库、系统设置、群配置和日报。

回滚时使用迁移前备份恢复短期上下文，并将 systemd 服务切回上一版本目录；不应把旧短期上下文与 V2.0.1 路由表混用。

## 验证

- `npm test`：512 项通过。
- `npm run build`：管理后台与服务端构建通过。
- 组件级链路覆盖：Ingress -> Worker -> Outbox -> QQ 真实回执 -> 引用恢复因果链。
- 迁移预检验证 outbox 已排空，且长期数据不在清理范围内。

