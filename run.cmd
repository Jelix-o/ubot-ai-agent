@echo off
rem ============================================================
rem UBot 多进程启动器
rem
rem   BOT_ROLE=ingress  → Ingress 进程（NapCat WS / 去重 / 发送）
rem   BOT_ROLE=worker   → Worker 进程（话题路由 / LLM / 回复生成）
rem   BOT_ROLE=admin    → Admin 进程（管理后台 HTTP）
rem   BOT_ROLE=legacy   → 旧版单进程模式（回滚路径）
rem
rem 通过 BOT_ROLE 环境变量控制。默认以 BOT_ROLE=ingress,worker,admin
rem 并行拉起三个进程；设置 BOT_ROLE=legacy 则退回单进程。
rem ============================================================
setlocal

if "%BOT_ROLE%"=="legacy" (
  node dist/index.js
  exit /b %errorlevel%
)

set "ROLE=%BOT_ROLE%"
if "%ROLE%"=="" set "ROLE=ingress,worker,admin"

for %%r in (%ROLE%) do (
  start "ubot-%%r" cmd /c "set BOT_ROLE=%%r&& node dist/index.js >> data\logs\%%r.log 2>&1"
)

echo UBot processes launched: %ROLE%
echo Logs: data\logs\<role>.log
endlocal
