# UBot V3.0.19

V3.0.19 完成去 TTS / 简化鉴权重构的可发布收口，并统一后台页面表达。

## 改进与修复

- **语音退休**
  - 移除 TTS / 语音 / 唱歌运行链路与相关配置入口；写入时 `purpose=tts` 与 `voiceReplyEnabled` 返回已退休错误。
  - 历史模型健康数据仍可只读展示，新探测仅聊天模型。
- **后台鉴权**
  - 登录改为账号密码 + 邀请码注册；TOTP / 恢复码路由退休并返回 404。
  - 敏感操作仍要求 10 分钟内密码复验；新增 `npm run admin:reset-password` 服务器端改密（交互终端，改密后吊销该账号会话）。
  - 密码策略：新建、改密、邀请接受、bootstrap 与服务器重置均要求至少 12 位。
- **权限模型（文档与实现对齐）**
  - QQ 群主 / 群管自动获得本群群内管理指令权限，**不**授予后台登录。
  - 后台权限仅来自管理员账号；QQ 绑定用于群内指令继承。
- **后台页面**
  - 角色未加载时不按超级管理员展示入口；加载失败会提示。
  - 敏感操作 `recent_reauth_required` 等错误改为可操作的中文引导。
  - 群配置等页面去掉冗长说明小字，保留可操作信息。
- **测试与冒烟**
  - 单元测试与后台视觉冒烟与密码登录、无语音能力策略对齐。

## 验证

- 本地：`node scripts/run-node22.cjs scripts/test.cjs`
- 冒烟：`node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs`
- 构建：`node scripts/run-node22.cjs scripts/build.cjs`

## 升级注意

- `ADMIN_PASSWORD`（仅首次空库 bootstrap）必须至少 12 位。
- 若运维文档仍写 TOTP / 语音流程，以本版本 README、COMMANDS、ADMIN-RECOVERY 为准。
