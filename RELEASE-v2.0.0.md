# UBot V2.0.0 Release Notes

发布状态：服务化架构升级完成，已通过全量测试（464 项）与回归审计。发布流：构建 → 全量测试 → Windows 发布包 → GitHub Release → 生产部署。

## 发布目标

V2.0.0 按《QQ 群机器人服务化升级方案》完成架构重构，核心原则 **"用户等不起，模型不可靠，历史会串味"**。从单进程重构为多进程服务（Ingress / Worker / Admin），落地三条不可妥协的底线：**真取消、话题隔离、图片失败分级**，并补齐幂等去重、熔断、降级、可观测指标等支撑机制。

## 架构升级

### 多进程服务化

```
NapCat (反向 WS) → [ingress] 幂等去重/backlog/撤回/令牌桶 → SQLite 消息总线
    → [worker] 三元组路由 → 每 key 串行 → 上下文分层 → 图片两阶段 → LLM(信号量+熔断)
    → outbox → [ingress/emitter] → QQ
```

- Ingress 独占反向 WS：幂等去重 `(self, group, msg)`、backlog 60s 检测、撤回订阅、每群令牌桶 6 条/10s。
- Worker 按持久化的 `(群, 因果分支)` 串行消费，跨分支并行；in-flight registry + 可取消 token。
- Admin 独立进程承载管理后台；共享状态走 `data/shared/bot-shared.db`（SQLite WAL，Node 22 内置）。
- 回滚：`BOT_ROLE=legacy` 一行切换回单进程模式，数据路径不变。

### 真取消（直击风险 1）

- LLM 调用全链路 `AbortSignal` 透传，超时/取消触发底层 socket 断开，token 不空烧。
- 同 key 新消息覆盖旧任务：>20s 取消续跑（回执"合并了你刚才和这条"）、<20s 追加合并、否则静默丢弃。
- 撤回的消息任务自动取消，回复不会发出。

### 话题隔离（直击风险 3）

- 1 小时内 reply_to 精确恢复因果父链，引用非末端消息自动创建独立分支；无引用只允许同群同用户在 10 分钟内按追问或相似度规则续聊。
- 不同用户没有明确引用时不共享上下文；路由异常只使用当前消息创建隔离分支，不回退旧个人历史。
- 群氛围只以**脱敏摘要**（L5，去人名/情绪极性/敏感词模糊化）进入上下文，原文不进 prompt。
- 长期记忆覆盖链：新事实打 `superseded_by` 标记，检索时旧事实置信度 ×0.3，防止过时记忆污染新话题。

### 图片两阶段与失败分级（直击风险 2）

- Stage1 本地化（NapCat 缓存 800ms → 内部代理 4s）→ Stage2 识别（视觉模型 / 纯文本模型 OCR 兜底）。
- 失败分级话术 L1-L4 固定："拿不到图"与"想不明白"日志可一眼区分，绝不说成"思考超时"。

### LLM 熔断与降级

- 连续 5 失败或 p95>40s 熔断 30s，期间零 LLM quota 消耗，直接返回轻量话术。
- 分级超时：记忆检索 1.5s / 实时查询 8s / LLM 35s / 端到端 60s 静默（迟到 = 错误答案）。
- 固定降级话术表（熔断/超时/限流/鉴权/图片分级/实时查询），禁止临场生成。

### 可观测指标

`data/shared/metrics/` 每 30s 落盘：`msg_ingress_qps`、`llm_latency_p95`、`llm_error_rate`、`end_to_end_reply_latency_p95`、`per_key_queue_depth_max`、`dedup_hit_rate`、`image_stage1_failure_rate`、`cancelled_task_rate`、`bot_self_trigger_blocked`；`duplicate_reply_rate` 以审计日志标记，必须为 0。

## 重点更新

- **消息幂等**：重复推送/重连重推只入一次，群友连发同样内容不误吞。
- **NapCat 重连 backlog**：断线重连积压消息（>60s）只入历史不触发回复，防刷屏被踢。
- **并发控制**：全局 LLM 信号量 8 并发（等待 ≤2s 降级）、每群令牌桶、每 key 串行。
- **实时查询语义校验**：工具返回"访问受限/空 JSON"等脏数据不灌入 prompt，明确"没查到实时数据"。

## 保留能力（V1.1.0 延续）

- 群聊对话 / 语音 / 唱歌 / 定时任务 / 日报 / 节假日倒计时 / 记忆系统 / 知识库 / 只读后台 / 模型管理 / Token 消耗控制 / Skill 扩展。

## 验证

- 全量测试：`npm test` 464 项通过（含服务化、熔断、话题、图片、并发等新增测试）。
- 回滚演练：`scripts/rollback-smoke.mjs` 验证 legacy 模式 200ms 启动 + admin HTTP 正常。
- 三进程联调：消息入总线 → worker 消费（话题分配）→ LLM → outbox 全链路验证通过。

## 回滚

- 旧版 Release 包 + `data/` 快照保留 30 天。
- `BOT_ROLE=legacy` 一行切换回 V1.x 单进程（数据路径不变）。
- 部署后 7 天双人值班，P0 指标 15min 内响应。

## 已知限制

- 多 bot 抢占锁（§8.3）：`msg_lock` 表已建，单 bot 部署未启用。
- LLM Gateway HTTP 端口（18080）与服务器现有 Docker 网关冲突时，进程内熔断模式不受影响（默认不监听端口）。
