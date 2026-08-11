# UBot V1.1.0 Release Notes

发布状态：本地实现完成，已纳入 V1.1.0 发布流。发布前需完成构建、全量测试、Windows 发布包、GitHub Release 和生产部署验证。

## 发布目标

V1.1.0 聚焦非对话 Token 消耗削减、记忆压缩、系统性能优化和 Skill 扩展。对话回复链路保持不变，重点降低后台自动画像、总结、去重、日报、提醒润色和模型健康探测等非对话模型调用成本。

## 重点更新

### Token 消耗控制

- 系统设置新增“Token 消耗控制”，集中管理非对话 AI 调用开关。
- 默认只保留候选记忆提取，其余高耗自动能力默认关闭或可一键关闭。
- 开关覆盖候选记忆中文化、语义去重、自动昨日画像、日报/倒计时 AI 文案、群聊总结 AI、定时提醒 AI 润色和模型健康自动探测。
- 模型健康页在自动探测关闭时展示跳过状态，手动检测仍可用。

### 画像压缩长期记忆

- `/api/memories/summarize` 从“手动记忆汇总”升级为“压缩为长期画像记忆”。
- 接口先生成成员群聊画像，成功后物理删除该成员旧 `member_profile` 长期记忆。
- 新画像以 `source: "profile_compaction"`、`confidence: 1` 写入长期记忆。
- 画像生成失败时不删除旧记忆，并返回原有错误语义。

### Skill 扩展

- 新增 `skills/youmi.json`：悠米·群聊人格操作系统。
- 基于「职场咸鱼帮」悠米相关 QQ 聊天记录提炼，覆盖发图社交货币、外包/软通/工资、AI/豆包/页面生成、瑞幸/生椰、地域出游、保密、低俗玩笑边界、性别自证和群友关系网。
- 明确悠米是女生，群友把她说成男生、兄弟、哥们时按群聊玩笑处理。

### 性能与可靠性

- 定时器统一调度，减少多个独立 `setInterval` 带来的运行开销。
- 对话存储支持延迟批量写入和 `flush()`，降低磁盘 I/O。
- 群配置缓存增加 TTL，系统设置支持缓存失效。
- 停机流程刷新待写入数据，降低异常退出时的数据丢失风险。

## 验证计划

- `JSON.parse("skills/youmi.json")`：通过。
- `npm run build` / `scripts/build.cjs`：发布前执行。
- `npm test` / `scripts/test.cjs`：期望 385/385 通过。
- `git diff --check`：发布前执行。
- `npm run package:win`：生成 `release/ubot-1.1.0-win.zip`。
- `scripts/publish-github-release.ps1 -DryRun`：目标 tag/name/notes/asset 均应为 V1.1.0。

## 发布信息

- npm 版本：`1.1.0`
- Git tag：`v1.1.0`
- Release 名称：`UBot V1.1.0`
- Release 文档：`RELEASE-v1.1.0.md`
- Windows 发布包：`release/ubot-1.1.0-win.zip`

## 生产部署后验证清单

- [ ] `ai-project.service` 为 `active`
- [ ] 生产 `.env`、`data/`、`config/groups.json` 被保留
- [ ] NapCat reverse WebSocket 正常重连
- [ ] 管理后台 `/login` 返回 HTTP 200
- [ ] 未登录 `/api/session` 返回 401 或现有未登录语义
- [ ] 服务启动日志无错误
