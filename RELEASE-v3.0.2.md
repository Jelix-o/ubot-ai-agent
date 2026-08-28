# UBot V3.0.2

发布日期：2026-08-28

## 修复

- 修复 `bot.9958.uk` 在 Cloudflare Flexible 回源模式下的 HTTPS 重定向循环。Nginx 仅在请求来自 Cloudflare 已公布边缘网段，且 `CF-Visitor` 明确表示浏览器使用 HTTPS 时，才接受其到源站的 HTTP 回源；直连 HTTP 和伪造头仍会重定向到 HTTPS。
- Cloudflare Flexible 回源分支保留后台安全响应头和敏感路径拦截，不会因解决重定向循环而暴露状态、配置、文档或部署文件。
- 修复超级管理员通过通用群配置接口修改成员隐私退出列表时可绕过近期 MFA 重验的问题。涉及 `memoryDisabledUserIds` 的修改现在与专用隐私退出接口一样要求近期 TOTP 验证。

## 验证

- Linux release deployer 测试覆盖 Cloudflare IPv4/IPv6 边缘网段、`CF-Visitor` HTTPS 判断、直连 HTTP 重定向、固定 HTTPS 转发头和双入口敏感路径拦截。
- 在生产服务器的临时非运行 Nginx 配置上执行 `nginx -t` 通过；没有 reload 或修改线上配置。

## 部署

从 GitHub Release 下载匹配的 Linux 包与 SHA-256 文件，并按 [docs/OPERATIONS-v3.md](docs/OPERATIONS-v3.md) 执行：

```bash
UBOT_NAPCAT_CONFIG=/opt/napcat/config/onebot11_428881701.json \
  UBOT_NGINX_CONFIG=/etc/nginx/sites-available/bot-9958 \
  bash deploy-linux-release.sh 3.0.2 ubot-3.0.2-linux.tar.gz
```

部署会先验证 Release 摘要和 Nginx 配置，再原子安装 `bot.9958.uk` 的站点配置并 reload Nginx。完成后确认：

```bash
curl -I https://bot.9958.uk/api/health
```

未登录时预期为 `401`，且不应发生重定向循环。本版本不修改 `sub.9958.uk`、Cloudflare 模式、UFW 或 AWS 安全组。
