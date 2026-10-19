# 会仙 BT 搜索运行环境

本文件保留为 BT 运行环境参考资料；它不是发布包清单，也不包含 Cookie、缓存或任何凭据。当前运行和升级的权威入口是项目根目录 `README.md` 的 BT 与部署章节。

搜索引擎位于此独立 CommonJS 目录，保留 Mikan、Nyaa、BTBTLA、1LOU、KPkuang、Sukebei 六个适配器及离线解析回归。Node 主程序通过 `BtSearchService` 的子进程使用引擎；命令参数以数组传递，不启动 shell。

## 依赖安装

需要 Node.js 22+、Python 3.10+。固定 Python 依赖见 `requirements.txt`：`curl_cffi==0.16.3`、`scrapling[fetchers]==0.4.15`。浏览器依赖由 Scrapling 安装器安装。Python 环境和浏览器放入应用持久目录，不要放入用户主目录；systemd 使用 `ProtectHome=yes`。

Linux（首次安装浏览器系统依赖需要 sudo）：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv
sudo node scripts/install-bt-deps.mjs --runtime-root /opt/ai-project/bt-runtime --python python3
sudo chown -R root:root /opt/ai-project/bt-runtime
sudo chmod -R a+rX,go-w /opt/ai-project/bt-runtime
```

Windows（Python 和 Node 在 PATH 上）：

```powershell
node scripts/install-bt-deps.mjs --runtime-root D:\UBot\bt-runtime --python python
```

持久 `.env` 可配置：

```dotenv
UBOT_BT_PYTHON=/opt/ai-project/bt-runtime/venv/bin/python
UBOT_BT_BROWSER_PATH=/opt/ai-project/bt-runtime/browsers
UBOT_BT_PROXY=socks5h://127.0.0.1:1080
```

Windows 使用对应的 `venv\Scripts\python.exe` 和浏览器目录。只配置已验证可用的代理；直接联网环境可省略代理。发布包不包含 Python 环境、浏览器、Cookie 或搜索缓存。

## 持久状态及检查

运行状态位于 `data/bt/`：`cache/`、`state.json`、`cookies.json`、`kpkuang-cookies.json`。默认查找实际持久 `data/` 相邻的 `bt-runtime/`，支持发布目录的 `data` 软链接。该目录供 `ubot` 服务用户写入，权限宜为 `0700`。结果缓存默认 15 分钟，站点连续 3 次失败后熔断 5 分钟。

搜索子进程会将 Chromium 的 XDG 配置、缓存和数据放入 `data/bt/browser-state/`，避免 `ProtectHome` 下浏览器崩溃。`socks5h` 代理在浏览器层转换为 Chromium 支持的 `socks5`；curl 层仍使用远端 DNS。

```bash
sudo -u ubot env PLAYWRIGHT_BROWSERS_PATH=/opt/ai-project/bt-runtime/browsers \
  /opt/ai-project/bt-runtime/venv/bin/python -c "from scrapling.fetchers import StealthyFetcher; import curl_cffi; print('ready')"
```

群内命令和参数以项目根目录 `README.md` 为准。站点验证、网络限制或站点结构变化会在结果中提示；部分站点失败不影响其他来源返回。此功能只搜索资源索引及返回链接。
