# UBot V3.0.0-rc.2 Release Notes

发布日期：2026-08-26
发布类型：**重构第一阶段候选版（Release Candidate）**

> RC.2 包含 RC.1 的安全、可靠性、可解释性和迁移准备工作，并收口了生产验证中发现的 Outbox 重试上限。它仍不代表完整 V3 架构路线全部完成。请先在测试群或低风险群观察运行指标，再逐群提升参与强度。

## RC.2 修正：有限 Outbox 重试

- 生产 RC.1 验证发现 NapCat 对一个定时提醒持续返回 `retcode 1200`，旧逻辑会每约 2 秒重复尝试同一行，造成无意义日志噪声和潜在发送风暴。
- 新增 SQLite schema migration 4：为 Outbox 增加 `attempts` 计数。
- 每一条普通平台投递最多尝试 **3 次**（首次 claim 计入），第三次失败后保持 `failed` 且 `retry_after = NULL`；管理员必须明确新建消息后才会再次发送。
- `sending` 超时的投递歧义仍直接隔离，不可重试。
- RC.2 保持 RC.1 的所有安全、参与策略、隐私和迁移内容；只收口了重试上限。

## 本次重点

### 安全与隐私

- 关闭无身份验证的 viewer 登录。QQ 号只是标识符，不再作为后台认证凭据。
- 关闭公开画像分享链接；历史链接和相关 API 返回不可用/不存在，画像仅在受认证的后台中管理。
- Skill 原始素材默认不进入模型 prompt；遗留公开人物/私人资料型 Skill 不再出现在正常运行时 Skill 列表中。RC.1 / RC.2 release 会将审查后的 `itexpert.json` 替换进持久 skills 目录，以移除旧的 source-heavy 定义；其余 owner-managed Skill 保持不变。
- 系统设置 SQLite 影子快照二次脱敏，不保存 API Key、管理员密码哈希或群管理员密码哈希。

### 群参与与因果对话

- 新增 `ParticipationPolicy`，对每条消息记录 `ignore`、`observe`、`reply`、`task` 或 `admin_command` 决策、原因、分数和信号。
- 新增 `participationMode`：
  - `mentions_only`
  - `mentions_and_keywords`
  - `selected_members`
- RC.2 生产迁移将缺失配置补为 `mentions_only`：机器人只在 @ 或引用**已确认发送的机器人消息**时回复。
- 只有同群、真实 QQ 回执锚点才能允许无 @ 的引用追问；引用普通成员、未知消息、跨群消息不触发机器人。
- 旧单进程 `BOT_ROLE=legacy` 回退路径已与 Worker 采用相同的安全引用语义。
- 后台运行/健康页面可查看最近参与决策与聚合信息。

### 消息可靠性

- 修复速率限制：超限消息保留审计，但标记为不可处理，Worker 不会再调用模型或写 Outbox。
- Outbox `sending` 状态过期后隔离为终止失败；普通平台发送失败最多自动尝试 3 次，随后转为不可自动重试的 `failed`，避免重复 QQ 消息和无限 retcode 重试风暴。
- 保持 SQLite 消费水位、因果分支、撤回、去重、Outbox 回执绑定、熔断和并发控制。
- 生产发布前需将旧版本遗留的可重试 Outbox 行显式终止；RC.2 不会自动补发历史行。

### 跨进程状态准备

- 群配置和系统设置新增 SQLite shadow snapshot：JSON 仍是权威源，影子用于比较、脱敏校验和未来切库准备。
- 群配置、系统设置及主要 JSON Store 改为按文件版本刷新缓存，后台和 Worker 不再长期读取旧缓存。
- SQLite schema migration 采用加法版本化策略：
  1. 兼容旧 `messages` / `outbox` 列；
  2. 群配置影子快照；
  3. 系统设置脱敏影子快照；
  4. Outbox 投递尝试计数与有限重试。

### 模型与后台

- Anthropic 过渡 adapter 明确拒绝未支持的流式路径，处理图片 URL 输入并走受控非流式降级。
- 后台权限面收敛为超级管理员与群管理员角色模型；当前公共登录入口只发行超级管理员会话，群管理员网页登录等待可验证身份方案。
- 后台群配置增加参与方式控制，操作审计记录群行为设置更新。
- 管理员 smoke 脚本更新为新版安全 API：健康探测用 POST、成员同步用显式刷新接口，并验证未认证群管理员登录被拒绝。

## 升级 v3.0.0-rc.1 → v3.0.0-rc.2

### 必做事项

1. 在维护窗口停止服务并确认无新发送操作。
2. 备份 SQLite 与持久文件：
   - `data/shared/bot-shared.db`：使用 SQLite `VACUUM INTO` 创建一致性副本；
   - `.env`、`data/`、`skills/`、`config/groups.json`。
3. 检查 Outbox。任何 `sending`、`pending`、`preparing` 或可重试 `failed` 行都必须先人工处理。对确定不应补发的历史行，保留审计并设为终止失败：

```sql
UPDATE outbox
SET status = 'failed', retry_after = NULL, updated_at = <当前毫秒时间>
WHERE id IN (291, 292, 293, 294);
```

4. 先预览群参与方式迁移：

```bash
npm run migrate:participation
```

5. 确认后执行保守迁移；它会备份 `groups.json` 并只填充缺失值：

```bash
npm run migrate:participation -- --mode mentions_only --execute
```

6. 启动 RC.2 后确认 `schema_migrations` 包含版本 1–4，且后台可显示参与决策。
7. 仅在测试群验证：@ 回复、引用机器人回复、引用普通成员不插话、静音、后台登录与群参与审计。

### 不要执行

- 不要从 v2.0.3 或 RC.1 升级 RC.2 时运行 `migrate:context -- --execute`；该脚本用于更早版本的上下文切换，会清理短期上下文。
- 不要自动重试或删除历史 Outbox 行。
- 不要覆盖 `.env`、`data/`、`skills/`、真实 `config/groups.json`。
- 不要把私钥、API Key、管理员密码或真实群消息提交到 Git。

## 验证

本候选版本地验证通过：

- `npm test`：**576 tests / 575 passed / 1 skipped / 0 failed**，覆盖前后端生产构建与完整自动化测试。唯一跳过项是 Windows 上必须依赖 POSIX 符号链接语义的 Linux 部署执行测试；同一部署脚本已在目标 Ubuntu 主机的隔离临时目录完成真实 shell 演练。
- `node scripts/run-node22.cjs scripts/rollback-smoke.mjs`：通过。
- `node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs`：通过。
- `git diff --check`：通过。

## 已知限制与后续 V3 Gate

RC.2 仍未完成以下正式 V3 项目：

- `BotApplication` 领域服务拆分；
- 记忆、知识、提醒、画像和会话 JSON Store 的 SQLite 主库迁移；
- 独立 Character Profile / Knowledge Pack / Capability Policy 模型；
- 官方 Anthropic SDK 的原生 provider/capability 层；
- 三个独立 systemd unit、网络最小化和自动化 release/rollback；
- 至少一周的影子决策、测试群低频灰度与打扰率/成本验收。

因此本 tag 的语义是 `v3.0.0-rc.2`，而不是正式 `v3.0.0`。

## 回滚

- 将 systemd release drop-in 恢复指向 RC.1 或 v2.0.3，再 `daemon-reload` 和重启服务。
- 如果三进程问题阻塞恢复，可以临时设置 `BOT_ROLE=legacy` 使用单进程入口。
- 不删除新的 SQLite 列或 migration 记录；它们按加法兼容设计。
- 如需恢复数据，使用发布前的 SQLite 备份，不要从 Outbox 自动重放旧消息。
