# UBot V1.0.0 Release Notes

发布日期：2026-06-07

## 发布目标

V1.0.0 是 UBot 的正式版基线，统一机器人、群管理后台、MiMo TTS v2.5、长期记忆、成员画像、任务中心和生产运维文档。旧 v3/v4 发布文档已清理，只保留本文件作为当前整体发布说明。

## 重点更新

- 总览页候选记忆和最新长期记忆面板增高，可稳定展示约 3 条记忆。
- 群配置新增“默认语音回复”开关，群管理员可用 `#语音回复 状态|开启|关闭` 管理。
- 成员管理编辑备注时，输入框自动带出现有备注。
- 任务中心增强陈旧任务判断：`model-check` 超过 10 分钟、其他 queued/running 任务超过 30 分钟会自动标记失败。
- Skills 管理新增每个 skill 的完整 MiMo TTS 配置：整体风格提示、音色、方言、人设腔调、基础情绪、复合情绪、整体语调、音色定位、语速节奏、情绪状态、语音特征和哭笑表达。
- TTS 请求严格按 MiMo V2.5 文档生成：
  - 目标文本在 `assistant` 消息；
  - 自然语言控制在 `user` 消息；
  - 音频标签在 `assistant` 文本；
  - `mimo-v2.5-tts` 支持预置音色和唱歌；
  - `mimo-v2.5-tts-voicedesign` 使用 `audio.optimize_text_preview=true`，不发送预置 `voice`；
  - 非唱歌模型会拒绝 `#唱歌` 并回退文字提示。
- 指令管理新增 `#唱歌`。
- 管理后台路由改为静态导入，缺失 hash 静态资源返回 `404 asset_not_found` 和 `Cache-Control: no-store`，避免旧 chunk 被 SPA fallback 误处理。
- 管理后台菜单响应优化：会话加载改为单次复用，侧边栏点击不再重复阻塞等待 `/api/session`。
- 管理后台预取缓存保护：后台 HTML、未登录 302 跳转和 `/api/*` 响应返回 `private, no-store`，源站提供空的 `/admin-speculation-rules.json`，避免 Cloudflare Speed Brain / 浏览器预取把 `/memories` 等后台路由缓存成 `503 Service Unavailable (from prefetch cache)`。
- 模型健康历史写入串行化，避免“检测全部模型”并发记录时触发 Windows atomic rename 冲突。

## MiMo TTS v2.5 支持范围

- 预置音色：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`
- 方言：`东北话`、`四川话`、`河南话`、`粤语`
- 人设腔调：`夹子音`、`御姐音`、`正太音`、`大叔音`、`台湾腔`
- 基础情绪：`开心`、`悲伤`、`愤怒`、`恐惧`、`惊讶`、`兴奋`、`委屈`、`平静`、`冷漠`
- 复合情绪：`怅然`、`欣慰`、`无奈`、`愧疚`、`释然`、`嫉妒`、`厌倦`、`忐忑`、`动情`
- 整体语调：`温柔`、`高冷`、`活泼`、`严肃`、`慵懒`、`俏皮`、`深沉`、`干练`、`凌厉`
- 音色定位：`磁性`、`醇厚`、`清亮`、`空灵`、`稚嫩`、`苍老`、`甜美`、`沙哑`、`醇雅`
- 语速与节奏：`吸气`、`深呼吸`、`叹气`、`长叹一口气`、`喘息`、`屏息`
- 情绪状态：`紧张`、`害怕`、`激动`、`疲惫`、`委屈`、`撒娇`、`心虚`、`震惊`、`不耐烦`
- 语音特征：`颤抖`、`声音颤抖`、`变调`、`破音`、`鼻音`、`气声`、`沙哑`
- 哭笑表达：`笑`、`轻笑`、`大笑`、`冷笑`、`抽泣`、`呜咽`、`哽咽`、`嚎啕大哭`

## 验证结果

- `node scripts/run-node22.cjs node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit`
- `npm test`
- 342 个 `node:test` 用例全部通过。

## 部署后验证清单

- `ai-project.service` 为 active。
- 生产端口保持 `6199/6200`。
- 日志出现 NapCat reverse WebSocket connected。
- `https://bot.9958.uk/login` 返回 200。
- 未登录访问受保护 API 返回 401。
- `https://bot.9958.uk/memories` 未登录返回 302 到 `/login`，并带 `Cache-Control: private, no-store` 与源站空 `Speculation-Rules`。
- `https://bot.9958.uk/admin-speculation-rules.json` 返回 `{"prefetch":[]}`。
- 公网后台可访问总览、群配置、成员管理、任务中心、系统状态、Skills 管理和指令管理。
- 任务中心不再长期保留陈旧 running 的“模型检测 环境语音模型”任务。

## 发布资产

- Git tag：`v1.0.0`
- Release 文档：`RELEASE-v1.0.0.md`
- 源码：GitHub `main`
