# UBot 自我迭代 V1.0.0

## 更新内容

- 新增 `#迭代` 运行时命令：群管理员可提交反馈、查看状态，超级管理员可生成 `/goal` 开发计划。
- 新增后台“自我迭代”页面：支持反馈录入、反馈筛选、计划生成、计划审批/拒绝、复制 `/goal` 执行稿和低风险完成标记。
- 新增自我迭代后端 API 与持久化文件：`data/iteration-feedback.json`、`data/iteration-plans.json`。
- 计划生成会汇总反馈、群配置、待审记忆、知识库、技能、模型健康和操作日志；线上只做规划和状态流转，不直接修改源码或部署。
- 任务中心支持展示 `self-iteration-analyze`、`self-iteration-apply`、`dev-plan-generate` 类型任务。

## 验证

- `npm run build`
- `npm test`

## 生产部署注意

- 升级时保留生产 `.env`、`data/`、`config/groups.json`、`node_modules/`、`dist/` 和日志目录。
- 部署后验证 `ai-project.service` 正常运行、NapCat 反向 WebSocket 仍连接、后台 `/iteration` 页面可访问且未绕过登录鉴权。
