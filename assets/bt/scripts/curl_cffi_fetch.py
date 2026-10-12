#!/usr/bin/env python3
"""curl_cffi fetch helper - impersonate Chrome TLS fingerprint to bypass Cloudflare.

Supports:
1) SNI/Host split for domains where www SNI is blocked but apex SNI works
2) Optional homepage warmup + cookie jar (for CF soft-challenge sites like KPkuang)
"""
import os
import sys
import json
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse


def detect_warp_proxy():
    warp_proxy = os.environ.get("WARP_PROXY", "")
    if warp_proxy:
        return warp_proxy
    for port in (40000, 1080):
        try:
            s = socket.socket()
            s.settimeout(0.3)
            s.connect(("127.0.0.1", port))
            s.close()
            return f"socks5://127.0.0.1:{port}"
        except OSError:
            pass
    return ""


def is_challenge(html: str) -> bool:
    text = html or ""
    lowered = text.lower()
    return (
        "just a moment" in lowered
        or "performing security verification" in lowered
        or "cf-browser-verification" in lowered
        or "challenge-platform" in lowered
        or "turnstile" in lowered
    )


def load_cookie_jar(session, jar_path: str) -> dict:
    if not jar_path:
        return {}
    path = Path(jar_path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        cookies = data.get("cookies") if isinstance(data, dict) else data
        if isinstance(cookies, dict):
            session.cookies.update(cookies)
        extra_headers = data.get("headers") if isinstance(data, dict) else {}
        if isinstance(extra_headers, dict):
            return extra_headers
    except Exception:
        pass
    return {}


def try_scrapling_turnstile_solve(url: str, jar_path: str) -> bool:
    python_bin = sys.executable
    if not os.path.exists(python_bin) or not jar_path:
        return False
    script = f"""
from scrapling.fetchers import StealthyFetcher
import json, time
from pathlib import Path

try:
    page = StealthyFetcher.fetch({json.dumps(url)}, headless=True, solve_cloudflare=True, proxy={json.dumps(detect_warp_proxy().replace('socks5h://', 'socks5://', 1))} or None)
    cookies = {{}}
    for c in page.cookies:
        n, v = c.get('name'), c.get('value')
        if n and v:
            cookies[n] = v
    req_headers = dict(page.request_headers)
    data = {{
        'savedAt': int(time.time()),
        'cookies': cookies,
        'headers': {{
            'user-agent': req_headers.get('user-agent', ''),
            'sec-ch-ua': req_headers.get('sec-ch-ua', ''),
            'sec-ch-ua-mobile': req_headers.get('sec-ch-ua-mobile', '?0'),
            'sec-ch-ua-platform': req_headers.get('sec-ch-ua-platform', '"Linux"')
        }}
    }}
    p = Path({json.dumps(jar_path)})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print('OK')
except Exception as e:
    print('ERR', e)
"""
    try:
        res = subprocess.run([python_bin, "-c", script], capture_output=True, text=True, timeout=30)
        return "OK" in res.stdout
    except Exception:
        return False


def save_cookie_jar(session, jar_path: str, headers: dict | None = None):
    if not jar_path:
        return
    path = Path(jar_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        cookies = {}
        try:
            cookies = dict(session.cookies)
        except Exception:
            try:
                cookies = session.cookies.get_dict()
            except Exception:
                cookies = {}

        existing_headers = {}
        if path.exists():
            try:
                old_data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(old_data, dict) and "headers" in old_data:
                    existing_headers = old_data["headers"]
            except Exception:
                pass

        out_headers = headers if headers else existing_headers
        payload = {
            "savedAt": int(time.time()),
            "cookies": cookies,
        }
        if out_headers:
            payload["headers"] = out_headers

        path.write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        print(
            "Usage: curl_cffi_fetch.py <url> [referer] [resolve_ip] [resolve_host] [sni_host] [warmup_url] [cookie_jar]",
            file=sys.stderr,
        )
        sys.exit(1)

    url = sys.argv[1]
    referer = sys.argv[2] if len(sys.argv) > 2 else ""
    resolve_ip = sys.argv[3] if len(sys.argv) > 3 else ""
    resolve_host = sys.argv[4] if len(sys.argv) > 4 else ""
    sni_host = sys.argv[5] if len(sys.argv) > 5 else ""
    warmup_url = sys.argv[6] if len(sys.argv) > 6 else os.environ.get("OPENCLAW_BT_WARMUP_URL", "")
    cookie_jar = sys.argv[7] if len(sys.argv) > 7 else os.environ.get("OPENCLAW_BT_COOKIE_JAR", "")
    timeout_sec = float(sys.argv[8]) if len(sys.argv) > 8 and sys.argv[8] else 8.0

    try:
        from curl_cffi import requests
        from curl_cffi.const import CurlOpt
    except ImportError:
        print(json.dumps({"error": "curl_cffi not installed"}), file=sys.stderr)
        sys.exit(1)

    warp_proxy = detect_warp_proxy()
    proxies = {"https": warp_proxy, "http": warp_proxy} if warp_proxy else None

    try:
        parsed = urlparse(url)
        original_host = parsed.hostname or ""
        host_header = resolve_host or original_host
        effective_sni = sni_host or original_host

        request_url = url
        if effective_sni and original_host and effective_sni != original_host:
            netloc = effective_sni
            if parsed.port:
                netloc = f"{effective_sni}:{parsed.port}"
            request_url = urlunparse((
                parsed.scheme,
                netloc,
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment,
            ))

        headers = {
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        if referer:
            headers["Referer"] = referer
        if host_header:
            headers["Host"] = host_header

        session = requests.Session()
        jar_headers = load_cookie_jar(session, cookie_jar)
        if jar_headers:
            headers.update(jar_headers)

        curl_options = {}
        resolve_entries = []
        if resolve_ip:
            for host in {h for h in (effective_sni, host_header, original_host, resolve_host) if h}:
                resolve_entries.append(f"{host}:443:{resolve_ip}")
        if resolve_entries:
            curl_options[CurlOpt.RESOLVE] = resolve_entries
        if curl_options:
            session.curl_options = curl_options

        allow_redirects = not (sni_host and resolve_host and sni_host != resolve_host)

        # Warmup homepage in the same session to obtain CF cookies when needed.
        if warmup_url:
            try:
                warm_headers = {
                    "Accept-Language": headers["Accept-Language"],
                    "Accept": headers["Accept"],
                }
                session.get(
                    warmup_url,
                    impersonate="chrome",
                    headers=warm_headers,
                    timeout=min(timeout_sec, 10.0),
                    allow_redirects=True,
                    proxies=proxies,
                    verify=False,
                )
                save_cookie_jar(session, cookie_jar)
            except Exception:
                # Warmup failure should not block the main request.
                pass

        r = session.get(
            request_url,
            impersonate="chrome",
            headers=headers,
            timeout=timeout_sec,
            allow_redirects=allow_redirects,
            proxies=proxies,
            verify=False,
        )

        body_text = ""
        try:
            body_text = r.content.decode("utf-8", "replace")
        except Exception:
            body_text = ""

        # If challenged, try scrapling turnstile solver first, or fallback to warmup.
        if (r.status_code == 403 or is_challenge(body_text)) and cookie_jar:
            if try_scrapling_turnstile_solve(request_url, cookie_jar):
                jar_headers = load_cookie_jar(session, cookie_jar)
                retry_headers = dict(headers)
                if jar_headers:
                    retry_headers.update(jar_headers)
                r = session.get(
                    request_url,
                    impersonate="chrome",
                    headers=retry_headers,
                    timeout=timeout_sec,
                    allow_redirects=allow_redirects,
                    proxies=proxies,
                    verify=False,
                )
                try:
                    body_text = r.content.decode("utf-8", "replace")
                except Exception:
                    body_text = ""
            elif warmup_url:
                try:
                    session.get(
                        warmup_url,
                        impersonate="chrome",
                        headers={
                            "Accept-Language": headers["Accept-Language"],
                            "Accept": headers["Accept"],
                        },
                        timeout=min(timeout_sec, 10.0),
                        allow_redirects=True,
                        proxies=proxies,
                        verify=False,
                    )
                    retry_headers = dict(headers)
                    if not retry_headers.get("Referer"):
                        retry_headers["Referer"] = warmup_url
                    r = session.get(
                        request_url,
                        impersonate="chrome",
                        headers=retry_headers,
                        timeout=timeout_sec,
                        allow_redirects=allow_redirects,
                        proxies=proxies,
                        verify=False,
                    )
                    save_cookie_jar(session, cookie_jar)
                except Exception:
                    pass

        # Manual same-path redirect rewrite for SNI split mode.
        if (
            not allow_redirects
            and r.status_code in (301, 302, 303, 307, 308)
            and r.headers.get("location")
        ):
            loc = r.headers.get("location")
            if loc.startswith("/"):
                loc = f"{parsed.scheme}://{host_header}{loc}"
            loc_parsed = urlparse(loc)
            if loc_parsed.hostname in {host_header, original_host, resolve_host, effective_sni}:
                rewritten = urlunparse((
                    loc_parsed.scheme or parsed.scheme,
                    effective_sni,
                    loc_parsed.path,
                    loc_parsed.params,
                    loc_parsed.query,
                    loc_parsed.fragment,
                ))
                r = session.get(
                    rewritten,
                    impersonate="chrome",
                    headers=headers,
                    timeout=25,
                    allow_redirects=False,
                    proxies=proxies,
                    verify=False,
                )

        save_cookie_jar(session, cookie_jar)

        if r.status_code >= 400:
            print(json.dumps({"error": f"http_{r.status_code}", "status": r.status_code}), file=sys.stderr)
            sys.exit(1)
        sys.stdout.buffer.write(r.content)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
