# UBot v3.0 Release Notes

发布日期：2026-06-03

## 概览

`v3.0` 将项目正式命名为 `UBot`，定位为 QQ 群聊机器人与群运营后台。这个版本重点解决后台卡顿、候选记忆难处理、长期记忆难维护、模型配置不清晰的问题。

## 主要更新

- 项目名更新为 `UBot`，npm 包名更新为 `ubot`，版本更新为 `3.0.0`。
- 公网后台继续使用轻量静态页面，不引入重型前端框架。
- 后台列表体验优化：分页、筛选摘要、URL 状态恢复、来源证据按需加载、候选记忆和长期记忆默认精简展示。
- 候选记忆和长期记忆详情改为按需展开，减少默认 DOM 和文字量，降低大列表卡顿。
- 长期记忆支持编辑类型、归属成员、标题、内容、置信度和启停状态。
- 候选记忆支持按群、类型、状态、归属和搜索词筛选，处理后自动从待审工作台移走。
- 成员管理合并 NapCat 群成员、人工身份表和记忆归属，支持维护系统备注和别名。
- 群记忆来源证据支持时间段、消息数、参与 QQ 和摘要，不保存完整原话。
- Mimo 画像分析模型独立于聊天回复模型，用于候选提炼、每日画像审查和画像查询汇总。
- 群聊回复支持 `#模型切换 mimo/gpt`，主回复模型失败时自动尝试备用模型。
- `#昨日画像` 和 `#群聊画像` 支持所有群成员查询任意成员。
- 自动运维告警不再主动推送 NapCat 恢复通知，恢复状态由管理员主动查询。

## 重要命令

- `#模型状态`
- `#模型切换 mimo/gpt`
- `#记忆 状态`
- `#知识库 状态`
- `#昨日画像 <备注/QQ号>`
- `#群聊画像 <备注/QQ号>`
- `#告警 状态`

完整指令见 `COMMANDS.md`。

## 部署说明

生产升级时必须保留：

- `.env`
- `.env.*`
- `data/`
- `config/groups.json`
- `node_modules/`
- `dist/`
- `.git/`
- `release/`
- `NUL`

NapCat 反向 WebSocket 生产配置不要被覆盖：

```env
NAPCAT_REVERSE_WS_HOST=0.0.0.0
NAPCAT_REVERSE_WS_PORT=6199
NAPCAT_REVERSE_WS_PATH=/onebot/ws
```

后台建议继续由 Nginx 反代：

```text
https://bot.9958.uk -> http://127.0.0.1:6200
```

## 验证

发布前验证命令：

```bash
npm run build
node --test --experimental-test-isolation=none dist/admin-http-server.test.js
node --test --experimental-test-isolation=none dist/**/*.test.js
```

Windows 本地 Node 22 可使用：

```powershell
& 'D:\environment\nvm\v22.17.0\node.exe' --test --experimental-test-isolation=none (Get-ChildItem -Recurse dist -Filter *.test.js | ForEach-Object { $_.FullName })
```
