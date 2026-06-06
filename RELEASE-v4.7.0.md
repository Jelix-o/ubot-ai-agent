# UBot v4.7.0 Release Notes

发布日期：2026-06-06

## 概览

`v4.7.0` 聚焦管理端模型治理、模型健康巡检、后台交互稳定性和长期记忆去重收尾。版本号已与 `package.json` / `package-lock.json` 对齐为 `4.7.0`，延续现有运行数据兼容策略，不覆盖生产 `.env`、`data/` 和 `config/groups.json`。

## 主要更新

- 管理端升级到 UBot v4.7.0 标识，并补齐模型配置分类：对话回复、画像分析、去重处理、语音和自定义模型分开维护，回复模型才会进入群配置和 `#模型` 切换列表。
- 新增模型检测与模型健康历史能力：后台可按模型分类发起检测，记录检测来源、延迟、结果、缓存状态、服务地址、模型 ID 和完整错误详情。
- 强化系统设置页编辑体验：新增模型前先进入对应分类，保存前提示未生效状态，避免未保存模型误进入群配置。
- 修复后台顶部栏交互：分组下拉、用户菜单和其它弹层互斥关闭，系统设置页加载全部分组后不会污染顶部栏可选分组。
- 强化管理端接口与静态测试：模型健康、配置读写、NapCat 反向连接鉴权、JSON 写入、TTS 配置、画像记录和管理端静态约束均有回归覆盖。
- 优化长期记忆语义去重：去重任务的语义判定请求增加超时控制，避免定时去重被外部模型长时间挂起。
- 更新 Windows/Node 22 本地运行脚本：`npm run dev`、`npm run build` 和 `npm test` 会优先使用 `UBOT_NODE`，否则在 Windows 上回退到 `D:\environment\nvm\v22.17.0\node.exe`。

## 发布包

Windows 分享包由现有脚本生成：

```powershell
npm run package:win
```

输出路径：

```text
release/ubot-4.7.0-win/
release/ubot-4.7.0-win.zip
```

发布包会排除生产 `.env`、运行数据、生产群配置、`node_modules`、`dist`、`release` 和 `NUL` 等本地状态，避免覆盖线上配置和历史数据。

## 验证

本地发布收尾至少验证：

```powershell
npm test
```

管理端视觉巡检可按需运行：

```powershell
$env:ADMIN_SMOKE_SCREENSHOTS='1'; & 'D:\environment\nvm\v22.17.0\node.exe' scripts\visual-admin-smoke.mjs
```

截图输出目录：

```text
release/admin-ui-smoke
```

## 版本一致性

- `package.json`：`4.7.0`
- `package-lock.json`：`4.7.0`
- 关键发布提交：`a549721 Release v4.7.0 admin and model health fixes`
- 发布后收尾提交：`49d335b Fix admin topbar popover interactions`、`33d1beb Keep settings group list from polluting topbar`、`d8ca8e3 Avoid semantic judge timeouts in scheduled memory dedup`
