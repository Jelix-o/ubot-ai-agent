# UBot V1.1.0 Release Notes

发布状态：已完成全量测试、代码修复和生产部署。

## 发布目标

V1.1.0 专注于系统性能优化和资源消耗减少，通过定时器统一调度、对话存储延迟写入、缓存机制改进等手段，降低系统开销，提升运行效率。

## 重点更新

### 性能优化

- **定时器统一调度**：将 9 个独立 `setInterval` 合并为 1 个统一维护循环（10秒周期），减少系统资源开销。
- **对话存储延迟批量写入**：从每次操作立即写盘改为脏标记 + 5秒批量刷新，减少磁盘 I/O。
- **缓存 TTL 机制**：
  - 群配置缓存增加 30 秒 TTL，避免缓存永不刷新。
  - 系统设置新增 `invalidateCache()` 方法，支持手动失效。

### 可靠性提升

- **优雅停机支持**：监听 `SIGINT`/`SIGTERM` 信号，停机前自动刷新待写入数据。
- **对话存储 `flush()` 方法**：确保停机时数据落盘，防止数据丢失。

### 测试覆盖

- 新增 7 个测试用例，覆盖 roast 模式与各种交互方式的组合。
- 总测试数：377 个，全部通过。

## 验证结果

- `npm run build:admin`：通过。
- `npm run build:server`：通过。
- `npm test`：377/377 通过。
- 生产部署：服务正常运行，HTTP 200 响应。

## 已知限制

- 对话存储延迟写入最多可能丢失 5 秒数据（进程崩溃场景），这是有意的性能权衡。
- 定时器串行执行可能导致高频 tick（如 LiveChat 5秒周期）被低频但耗时的 tick 阻塞。

## 文件变更

| 文件 | 变更内容 |
|------|---------|
| `src/bot.ts` | 定时器统一调度，stop() 改为 async |
| `src/index.ts` | 优雅停机支持，main() 返回 BotApplication |
| `src/services/conversation-store.ts` | 延迟批量写入，新增 flush() 方法 |
| `src/services/group-config-service.ts` | 缓存 TTL 机制 |
| `src/services/system-settings-store.ts` | 新增 invalidateCache() 方法 |
| `src/bot.test.ts` | 新增 7 个测试用例 |
| `src/services/conversation-store.test.ts` | 测试适配 |
| `src/services/group-memory-candidate-service.test.ts` | 移除过时的语义去重测试 |

## 生产部署后验证清单

- [x] `ai-project.service` 为 `active`
- [x] 生产 `.env`、`data/`、`config/groups.json` 被保留
- [x] NapCat reverse WebSocket 正常重连
- [x] 管理后台首页可访问（HTTP 200）
- [x] 服务正常启动，无错误日志
