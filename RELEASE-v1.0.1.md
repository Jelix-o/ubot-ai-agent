# UBot V1.0.1 Release Notes

发布状态：本地实现、构建、全量测试、本地后台截图验证、Windows 发布包和 GitHub Release dry-run 已完成。按用户确认恢复发布范围，V1.0.1 将上传 GitHub、更新 Release、推送 tag 并部署生产环境。

## 发布目标

V1.0.1 在 V1.0.0 正式版基线上补齐普通用户只读后台、群语音开关依赖关系、模型设置恢复能力和 V1.0.1 整体文档。

## 重点更新

- 新增后台普通用户登录模式：只输入 QQ 号即可进入后台。
- 普通用户后台会根据当前 NapCat 群成员数据动态计算可见群，只显示这个 QQ 当前所在的已启用群；同一 viewer 会话会随成员关系变化自动增减可见群。
- 普通用户只读模式可查看群管理员可查看的群内数据，包括总览、群配置、成员管理、候选记忆、长期记忆、画像记录、知识库、任务中心、操作日志、通知和群页面需要的模型选项。
- 普通用户只读模式不能修改任何系统设置或内容。除退出登录外，所有状态变更型 `/api/*` 请求统一返回 `readonly_session`。
- 画像摘要缓存可读；带 `refresh=1` 的画像刷新/生成请求会被禁止，避免只读用户触发新内容生成。
- 前端候选记忆、长期记忆、成员管理、画像记录、知识库和群配置页面均加入只读禁用状态，且后端有强制权限兜底。
- 群配置中“默认语音回复”调整为“语音功能”的子开关：
  - 关闭语音功能会同步关闭默认语音回复；
  - 语音功能关闭时默认语音回复不能保持开启；
  - 群内 `#语音回复 开启` 会同时开启语音功能和默认语音回复。
- 修复“新增模型增加不了”：当 `data/system-settings.json` 的 `commands` 段损坏时，系统会恢复默认指令并保留已有模型和 API Key。
- 本地运行态已按要求为非“对话回复”和非“TTS 语音”的用途配置 `gpt-5.5`：画像总结、记忆提取、去重处理、群聊总结、知识库处理。
- 版本号、README、Release 文档、Windows 打包脚本和 GitHub Release 脚本默认值均更新到 V1.0.1。

## 验证结果

已完成的本地验证：

- `node scripts/run-node22.cjs node_modules/tsx/dist/cli.mjs src/services/system-settings-store.test.ts`：13/13 通过。
- `npm run build`：通过。
- `node scripts/run-node22.cjs --test --experimental-test-isolation=none dist\admin-http-server.test.js`：2/2 通过，覆盖普通 QQ 只读登录、动态 NapCat 群成员范围、禁止跨群、禁止写操作和 `readonly_session`。
- `npm test`：359/359 通过。
- `git diff --check`：通过。
- `$env:ADMIN_SMOKE_SCREENSHOTS="1"; node scripts/run-node22.cjs scripts/visual-admin-smoke.mjs`：通过，生成 50 张后台截图和 contact sheet；本地验收脚本已加入截图像素 smoke。
- 敏感 key 片段扫描：未发现用户提供的 key 进入 Git diff。
- `npm run package:win`：生成 `release/ubot-1.0.1-win.zip`。
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -DryRun`：通过，目标 tag/name/附件均为 V1.0.1。
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-v1.0.1-local.ps1`：本地验收脚本可串联全量测试、打包、Release dry-run、包内容检查、敏感 key 检查和 `git diff --check`。

## 发布资产

- Git tag：`v1.0.1`
- Release 文档：`RELEASE-v1.0.1.md`
- Windows 发布包：`release/ubot-1.0.1-win.zip`
- GitHub 分支：`chatops/main`
- 本地截图目录：`release/admin-ui-smoke/`

生成 Windows 发布包：

```powershell
npm run package:win
```

GitHub Release dry-run：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -DryRun
```

一键本地验收：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-v1.0.1-local.ps1
```

恢复发布后上传 GitHub Release：

```powershell
$env:GITHUB_TOKEN="<token with Contents/Release write permission>"
npm run release:github
```

## 生产部署后验证清单

仅在用户明确恢复生产部署后执行：

- `ai-project.service` 为 active。
- 生产 `.env`、`data/`、`config/groups.json` 和 NapCat 运行态被保留。
- NapCat reverse WebSocket 正常重连。
- `https://bot.9958.uk/login` 返回 200。
- 未登录访问 `/api/session` 返回 401。
- 超级管理员可登录并访问所有后台模块。
- 普通 QQ 用户可进入只读后台，只显示所在群。
- 普通 QQ 用户写操作返回 `readonly_session`。
- 群配置中语音功能和默认语音回复依赖关系正常。
- 任务中心不会长期保留陈旧的 `model-check` running 任务。
