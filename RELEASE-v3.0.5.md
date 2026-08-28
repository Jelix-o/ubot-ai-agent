# UBot V3.0.5

发布日期：2026-08-28

## 本版更新

- 修复 Linux systemd `EnvironmentFile` 兼容性：若持久 `.env` 以 UTF-8 BOM 开头，部署器会在停止服务前保存受限的逐字节备份，并通过同目录原子替换只移除 BOM。
- 无 BOM 的 `.env` 不会被重写；规范化会保留原文件属主和权限，备份冲突、并发修改或无法安全替换时部署立即中止。
- NapCat 网络配置器增加同样的单 BOM 防御，避免直接运行配置工具时重新留下 systemd 无法识别的首行。

## 兼容性

- 本版不新增数据库迁移，SQLite schema 仍为 migration `10`。
- 不改变群命令、后台 API、认证、静态网页预览格式或生产端口边界。
- V3.0.4 可直接使用正式 GitHub Release 的 Linux 资产原子升级至 V3.0.5。

## 发布后检查

1. 确认三个 UBot 服务均为 active，日志中不再出现 `Ignoring invalid environment assignment`。
2. 确认 `NAPCAT_MODE=reverse` 生效，`172.21.0.1:6199`、`127.0.0.1:6198` 和 `127.0.0.1:6200` 保持既有边界。
3. 确认 SQLite 完整性与 migration `1`–`10`，并验证主站、预览 404 和一次真实网页发布链路。
