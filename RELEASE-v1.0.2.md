# UBot V1.0.2 Release Notes

发布状态：本地实现、构建、全量测试、Windows 发布包和 GitHub Release dry-run 已完成。本版本将上传 GitHub、更新 `v1.0.2` Release 并部署生产环境。

## 发布目标

V1.0.2 在 V1.0.1 基线上补齐可配置记忆入库策略，并合并近期后台体验、群配置和语音合成改进，降低人工审核压力，同时保留中文化和成员归属安全保护。

## 重点更新

- 系统设置新增记忆置信度策略：
  - 候选记忆阈值，默认 `60%`。
  - 长期记忆自动入库阈值，默认 `80%`。
  - 无人值守候选入库开关，默认关闭。
- 后端保存系统设置时校验两个阈值必须是 `0-100` 的整数，且候选阈值必须低于长期记忆阈值。
- 记忆候选服务改为读取系统设置：
  - 低于候选阈值的 AI 提取结果不入候选、不入长期。
  - 候选阈值到长期阈值之间进入待审核。
  - 达到长期阈值自动入长期记忆。
  - 无人值守开启后，达到候选阈值且通过中文和归属保护的候选直接入库。
  - 中文化失败、成员画像归属不明确或不属于当前发言人集合的候选仍不会直接入长期记忆。
- AI 记忆提取 prompt 会按当前阈值动态说明，不再使用固定 `0.65-0.79` 和 `>=0.85` 文案。
- 后台“系统设置 / 记忆与画像策略”新增两个阈值输入和无人值守开关，并在前端保存前提示非法范围或大小关系。
- 记忆去重后台任务增加快速检测和深度检测模式，深度检测可调用模型语义判断，并在任务中心展示更细的进度。
- 群配置新增“嘴臭模式 QQ”名单。名单内成员的主动接话会保留当前 skill 人格，但以更尖锐的群聊反击口吻回复，同时避免不可验证身份攻击和现实伤害威胁。
- MiMo TTS 输入改为干净正文合成：语气、情绪、舞台提示和自动推断风格放入风格指令，不再混入 assistant 正文被读出；唱歌模式只保留必要 `(唱歌)` 标签。
- 管理端 API fetch 失败时返回更明确的网络连接错误提示。

## 验证结果

- `npm run build:admin`：通过。
- `npm run build:server`：通过。
- `npm test`：369/369 通过。
- `node scripts/run-node22.cjs node_modules/tsx/dist/cli.mjs --test src/services/group-memory-candidate-service.test.ts`：13/13 通过。
- `git diff --check`：无空白错误，仅 Windows CRLF 转换提示。
- `npm run package:win`：生成 `release/ubot-1.0.2-win.zip`。
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -DryRun`：通过，目标 tag/name/附件均为 V1.0.2。

## 发布资产

- Git tag：`v1.0.2`
- Release 文档：`RELEASE-v1.0.2.md`
- Windows 发布包：`release/ubot-1.0.2-win.zip`
- GitHub 分支：`main`

生成 Windows 发布包：

```powershell
npm run package:win
```

GitHub Release dry-run：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -DryRun
```

本地验收：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-v1.0.2-local.ps1
```

上传 GitHub Release：

```powershell
$env:GITHUB_TOKEN="<token with Contents/Release write permission>"
npm run release:github
```

## 生产部署后验证清单

- `ai-project.service` 为 `active`。
- 生产 `.env`、`data/`、`config/groups.json` 和 NapCat 运行态被保留。
- NapCat reverse WebSocket 正常重连。
- 管理后台首页可访问。
- 未登录访问管理 API 返回 `401`。
- `/api/system-settings` 返回 V1.0.2 新增的记忆阈值和无人值守字段。
- 合法阈值可保存，候选阈值大于等于长期阈值时返回 `invalid_memory_confidence_thresholds`。
- 候选记忆服务按系统设置跳过、待审或自动入库。
