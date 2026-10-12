#!/usr/bin/env python3
"""Persistent curl_cffi worker for BT skill.

Keeps per-host sessions in-process so warmup/cookies are reused across requests
inside a single bt.js run.

Protocol (newline-delimited JSON):
  request:  {"id":1,"url":"...","referer":"...","resolve_ip":"...","resolve_host":"...","sni_host":"...","warmup_url":"...","cookie_jar":"...","timeout":25,"out":"/path/to/body"}
  response: {"id":1,"ok":true,"status":200,"bytes":123,"via":"curl_cffi","error":""}
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

try:
    from curl_cffi import requests
    from curl_cffi.const import CurlOpt
except ImportError:
    sys.stdout.write(json.dumps({"id": None, "ok": False, "error": "curl_cffi not installed"}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


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
    text = (html or "").lower()
    return (
        "just a moment" in text
        or "performing security verification" in text
        or "cf-browser-verification" in text
        or "challenge-platform" in text
        or "turnstile" in text
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


class HostSession:
    def __init__(self):
        self.session = requests.Session()
        self.warmed = set()
        self.proxy = detect_warp_proxy()
        self.proxies = {"https": self.proxy, "http": self.proxy} if self.proxy else None


SESSIONS = {}


def get_host_session(host: str) -> HostSession:
    key = host or "default"
    if key not in SESSIONS:
        SESSIONS[key] = HostSession()
    return SESSIONS[key]


def build_request_url(url, resolve_host, sni_host):
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
    return parsed, original_host, host_header, effective_sni, request_url


def apply_resolve(session_obj: HostSession, resolve_ip, hosts):
    if not resolve_ip:
        return
    entries = [f"{host}:443:{resolve_ip}" for host in sorted({h for h in hosts if h})]
    if entries:
        session_obj.session.curl_options = {CurlOpt.RESOLVE: entries}


def do_get(session_obj: HostSession, url, headers, timeout, allow_redirects):
    return session_obj.session.get(
        url,
        impersonate="chrome",
        headers=headers,
        timeout=timeout,
        allow_redirects=allow_redirects,
        proxies=session_obj.proxies,
        verify=False,
    )


def handle_request(req: dict) -> dict:
    req_id = req.get("id")
    url = req.get("url") or ""
    if not url:
        return {"id": req_id, "ok": False, "status": 0, "bytes": 0, "error": "missing url"}

    referer = req.get("referer") or ""
    resolve_ip = req.get("resolve_ip") or ""
    resolve_host = req.get("resolve_host") or ""
    sni_host = req.get("sni_host") or ""
    warmup_url = req.get("warmup_url") or ""
    cookie_jar = req.get("cookie_jar") or ""
    timeout = float(req.get("timeout") or 25)
    out_path = req.get("out") or ""

    try:
        parsed, original_host, host_header, effective_sni, request_url = build_request_url(
            url, resolve_host, sni_host
        )
        session_key = host_header or original_host or effective_sni or "default"
        host_sess = get_host_session(session_key)
        jar_headers = load_cookie_jar(host_sess.session, cookie_jar)
        apply_resolve(
            host_sess,
            resolve_ip,
            [effective_sni, host_header, original_host, resolve_host],
        )

        headers = {
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        if jar_headers:
            headers.update(jar_headers)
        if referer:
            headers["Referer"] = referer
        if host_header:
            headers["Host"] = host_header

        # Warmup once per host session.
        if warmup_url and warmup_url not in host_sess.warmed:
            try:
                do_get(
                    host_sess,
                    warmup_url,
                    {
                        "Accept-Language": headers["Accept-Language"],
                        "Accept": headers["Accept"],
                    },
                    min(timeout, 20),
                    True,
                )
                host_sess.warmed.add(warmup_url)
                save_cookie_jar(host_sess.session, cookie_jar)
            except Exception:
                pass

        allow_redirects = not (sni_host and resolve_host and sni_host != resolve_host)
        r = do_get(host_sess, request_url, headers, timeout, allow_redirects)

        body = r.content or b""
        body_text = ""
        try:
            body_text = body.decode("utf-8", "replace")
        except Exception:
            body_text = ""

        # If challenged, try scrapling turnstile solver first, or fallback to warmup.
        if (r.status_code == 403 or is_challenge(body_text)) and cookie_jar:
            if try_scrapling_turnstile_solve(request_url, cookie_jar):
                jar_headers = load_cookie_jar(host_sess.session, cookie_jar)
                retry_headers = dict(headers)
                if jar_headers:
                    retry_headers.update(jar_headers)
                r = do_get(host_sess, request_url, retry_headers, timeout, allow_redirects)
                body = r.content or b""
                try:
                    body_text = body.decode("utf-8", "replace")
                except Exception:
                    body_text = ""
            elif warmup_url:
                try:
                    do_get(
                        host_sess,
                        warmup_url,
                        {
                            "Accept-Language": headers["Accept-Language"],
                            "Accept": headers["Accept"],
                        },
                        min(timeout, 20),
                        True,
                    )
                    host_sess.warmed.add(warmup_url)
                    retry_headers = dict(headers)
                    if not retry_headers.get("Referer"):
                        retry_headers["Referer"] = warmup_url
                    r = do_get(host_sess, request_url, retry_headers, timeout, allow_redirects)
                    body = r.content or b""
                    save_cookie_jar(host_sess.session, cookie_jar)
                except Exception:
                    pass

        # Manual redirect rewrite for SNI split.
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
                r = do_get(host_sess, rewritten, headers, timeout, False)
                body = r.content or b""

        save_cookie_jar(host_sess.session, cookie_jar)

        if out_path:
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_bytes(body)

        return {
            "id": req_id,
            "ok": 200 <= int(r.status_code or 0) < 400 and len(body) > 0,
            "status": int(r.status_code or 0),
            "bytes": len(body),
            "via": "curl_cffi",
            "error": "" if 200 <= int(r.status_code or 0) < 400 else f"http_{r.status_code}",
        }
    except Exception as e:
        return {
            "id": req_id,
            "ok": False,
            "status": 0,
            "bytes": 0,
            "via": "curl_cffi",
            "error": str(e),
        }


def main():
    # ready signal
    sys.stdout.write(json.dumps({"id": None, "ok": True, "ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"id": None, "ok": False, "error": f"bad_json:{e}"}) + "\n")
            sys.stdout.flush()
            continue

        if req.get("cmd") == "quit":
            sys.stdout.write(json.dumps({"id": req.get("id"), "ok": True, "bye": True}) + "\n")
            sys.stdout.flush()
            break

        resp = handle_request(req)
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
