#!/usr/bin/env python3
"""IETF Atlas 本地/发布服务。

做两件事：
1. 静态托管 app/ 目录（PWA 外壳 + 数据快照）。
2. 提供 /api/live/* 同源代理，转发到 IETF Datatracker 公开 API。
   —— 浏览器直连 datatracker 会被 CORS 拦住，必须走同源代理；
   —— 代理只做原样转发 + 短时缓存，不加工、不引入任何第三方来源。

用法：
    PORT=8080 python3 server.py
"""
import gzip
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import auth

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
DT = "https://datatracker.ietf.org/api/v1"
UA = "ietf-atlas/1.0 (+https://ietfmap.app)"
TTL = 300  # 秒
# 文档正文几乎不变，缓存一天：同一份草案反复下载/重装面板时不用再打上游
DOC_TTL = 86400
MAX_DOC = 12 * 1024 * 1024   # 单份正文上限 12MB，挡住异常大文件
_cache = {}
_lock = threading.Lock()
_ready_said = False

# 只允许官方正文，且名字/版本/格式都按白名单校验——代理绝不能变成任意 URL 的出口（SSRF）
NAME_RE = re.compile(r"^(rfc\d{1,5}|bcp\d{1,4}|std\d{1,4}|fyi\d{1,4}|draft-[a-z0-9][a-z0-9-]{0,90})$")
VER_RE = re.compile(r"^\d{2,3}$")
FMT_TYPES = {"txt": "text/plain; charset=utf-8", "html": "text/html; charset=utf-8", "pdf": "application/pdf"}

# 账号名：字母数字开头，允许 . _ -，3–24 位（不区分大小写）
USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,23}$")


def _name_error(name):
    if not USER_RE.match(name or ""):
        return "账号名 3–24 位，只能用字母、数字、点、下划线、连字符，且以字母或数字开头"
    return ""


def _pw_error(pw, name=""):
    if len(pw or "") < 8:
        return "密码至少 8 位"
    if len(pw) > 128:
        return "密码最长 128 位"
    if name and pw.lower() == name.lower():
        return "密码不能和账号名相同"
    if len(set(pw)) < 4:
        return "密码太简单，请至少用 4 种不同字符"
    return ""


def dt_get(path):
    """带缓存的 GET，返回 (status, bytes, content_type)。"""
    now = time.time()
    with _lock:
        hit = _cache.get(path)
    if hit and now - hit[0] < TTL:
        return hit[1], hit[2], hit[3]

    url = f"{DT}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
            if body[:2] == b"\x1f\x8b":       # 上游无视协商仍然压了
                body = gzip.decompress(body)
            status, payload, ctype = r.status, body, r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        status, payload, ctype = e.code, e.read() or b'{"error":"not found"}', "application/json"
    except Exception:
        status, payload, ctype = 504, b'{"error":"upstream unreachable"}', "application/json"

    with _lock:
        _cache[path] = (now, status, payload, ctype)
    return status, payload, ctype


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def log_request(self, code='-', size='-'):
        super().log_request(code, size)
        # 发出第一份响应后才算真的"起来了"：容器/反代那边才有据可依
        global _ready_said
        if not _ready_said:
            _ready_said = True
            sys.stderr.write("ietf-atlas ready, listening on 0.0.0.0:%d\n" % self.server.server_port)
            sys.stderr.flush()

    def _json(self, status, payload, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(payload)

    def _serve_doc(self, url, fmt):
        """抓官方正文并原样返回。缓存一天；上游 404 就说"没有这一版"，不编内容。"""
        now = time.time()
        with _lock:
            hit = _cache.get(url)
        if hit and now - hit[0] < DOC_TTL:
            return self._send_bytes(hit[1], hit[2], hit[3])

        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read(MAX_DOC + 1)
                ctype = r.headers.get("Content-Type") or FMT_TYPES[fmt]
                status = r.status
        except urllib.error.HTTPError as e:
            return self._json(e.code, json.dumps({"error": "upstream " + str(e.code)}).encode())
        except Exception as e:
            return self._json(502, json.dumps({"error": str(e)[:120]}).encode())
        if len(data) > MAX_DOC:
            return self._json(413, b'{"error":"document too large"}')
        if status != 200:
            return self._json(status, b'{"error":"upstream error"}')
        with _lock:
            _cache[url] = (now, 200, data, ctype)
        return self._send_bytes(200, data, ctype)

    def _send_bytes(self, status, payload, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(payload)

    # ---------- 账号 / 会话 ----------

    def _cookies(self):
        out = {}
        for part in (self.headers.get("Cookie") or "").split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _current_user(self):
        return auth.read_token(self._cookies().get(auth.COOKIE) or "")

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if n <= 0 or n > auth.MAX_BODY:
            return {}
        try:
            obj = json.loads(self.rfile.read(n) or b"{}")
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}

    def _set_session(self, token, max_age=auth.SESSION_TTL):
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        secure = proto == "https" or host not in ("localhost", "127.0.0.1", "::1", "")
        bits = [f"{auth.COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if secure:
            bits.append("Secure")
        self.send_header("Set-Cookie", "; ".join(bits))

    def _same_origin(self):
        """写操作只接受同源：挡掉别的站点借用户浏览器发请求（配合 SameSite=Lax）。"""
        origin = self.headers.get("Origin")
        if not origin:
            return True                      # 非浏览器客户端（curl / 脚本）没有 Origin
        host = (self.headers.get("Host") or "").lower()
        try:
            o = urllib.parse.urlparse(origin)
            return (o.netloc or "").lower() == host
        except Exception:
            return False

    def _need(self, role=None):
        u = self._current_user()
        if not u:
            self._json(401, b'{"error":"unauthorized"}')
            return None
        if role == "admin" and u.get("role") != "admin":
            self._json(403, b'{"error":"forbidden"}')
            return None
        return u

    def _do_auth(self, path):
        body = self._body()
        ip = self.client_address[0]

        # 登录
        if path == "/api/auth/login":
            left = auth.throttle_left(ip)
            if left:
                return self._json(429, json.dumps({"error": f"尝试过多，{left} 秒后再试"}, ensure_ascii=False).encode())
            name = str(body.get("name") or "").strip()
            pw = str(body.get("password") or "")
            u = auth.find_user(name)
            if not u or not auth.check_password(u, pw):
                auth.note_fail(ip)
                auth.audit("login-fail", f"{ip} · {name or '(空)'}")
                time.sleep(0.35)             # 放慢撞库，不泄漏"是账号不存在还是密码错"
                return self._json(401, b'{"error":"\xe8\xb4\xa6\xe5\x8f\xb7\xe6\x88\x96\xe5\xaf\x86\xe7\xa0\x81\xe4\xb8\x8d\xe5\xaf\xb9"}')
            auth.note_ok(ip)
            auth.touch_login(u["name"])
            auth.audit("login", f"{ip} · {u['name']}")
            token = auth.make_token(u)
            payload = json.dumps({"user": auth.public_user(u)}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self._set_session(token)
            self.end_headers()
            return self.wfile.write(payload)

        # 退出
        if path == "/api/auth/logout":
            u = self._current_user()
            if u:
                auth.audit("logout", u["name"])
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self._set_session("", 0)
            self.end_headers()
            return self.wfile.write(payload)

        # 改自己的密码
        if path == "/api/auth/password":
            u = self._need()
            if not u:
                return
            old = str(body.get("old") or "")
            new = str(body.get("new") or "")
            if not auth.check_password(u, old):
                return self._json(400, b'{"error":"\xe5\xbd\x93\xe5\x89\x8d\xe5\xaf\x86\xe7\xa0\x81\xe4\xb8\x8d\xe5\xaf\xb9"}')
            err = _pw_error(new, u["name"])
            if err:
                return self._json(400, json.dumps({"error": err}, ensure_ascii=False).encode())
            fresh = auth.change_own_password(u["name"], new)
            token = auth.make_token(auth.find_user(u["name"]))
            payload = json.dumps({"user": fresh, "ok": True}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self._set_session(token)
            self.end_headers()
            return self.wfile.write(payload)

        # 管理员：新建账号
        if path == "/api/auth/users" and self.command == "POST":
            if not self._need("admin"):
                return
            name = str(body.get("name") or "").strip()
            pw = str(body.get("password") or "")
            role = str(body.get("role") or "user")
            note = str(body.get("note") or "")[:60]
            bad = _name_error(name) or _pw_error(pw, name)
            if bad:
                return self._json(400, json.dumps({"error": bad}, ensure_ascii=False).encode())
            try:
                u = auth.create_user(name, pw, role, note)
            except ValueError as e:
                return self._json(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
            return self._json(200, json.dumps({"user": u}, ensure_ascii=False).encode())

        # 管理员：重置别人密码
        if path == "/api/auth/users/reset":
            if not self._need("admin"):
                return
            name = str(body.get("name") or "").strip()
            pw = str(body.get("password") or "")
            bad = _pw_error(pw, name)
            if bad:
                return self._json(400, json.dumps({"error": bad}, ensure_ascii=False).encode())
            try:
                u = auth.reset_password(name, pw)
            except ValueError as e:
                return self._json(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
            return self._json(200, json.dumps({"user": u}, ensure_ascii=False).encode())

        # 管理员：删除账号
        if path == "/api/auth/users/delete":
            me = self._need("admin")
            if not me:
                return
            name = str(body.get("name") or "").strip()
            if name.lower() == me["name"].lower():
                return self._json(400, json.dumps({"error": "不能删除当前登录的账号（如需停用，请换另一个管理员来删）"}, ensure_ascii=False).encode())
            try:
                auth.delete_user(name)
            except ValueError as e:
                return self._json(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode())
            return self._json(200, b'{"ok":true}')

        return self._json(404, b'{"error":"not found"}')

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/auth/"):
            return self._json(404, b'{"error":"not found"}')
        if not self._same_origin():
            return self._json(403, b'{"error":"cross-origin request refused"}')
        try:
            return self._do_auth(path)
        except Exception as e:
            sys.stderr.write("auth error: %r\n" % (e,))
            return self._json(500, b'{"error":"internal error"}')

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/auth/me":
            u = self._current_user()
            if not u:
                return self._json(401, b'{"error":"unauthorized"}')
            return self._json(200, json.dumps({"user": auth.public_user(u)}, ensure_ascii=False).encode())

        if path == "/api/auth/audit":
            if not self._need("admin"):
                return
            return self._json(200, json.dumps({"events": auth.tail_audit(200)}, ensure_ascii=False).encode())

        if path == "/api/auth/list":
            me = self._need("admin")
            if not me:
                return
            return self._json(200, json.dumps({
                "users": auth.list_users(),
                "me": me["name"],
            }, ensure_ascii=False).encode())

        # /api/docfile?name=rfc9000&fmt=txt
        # /api/docfile?name=draft-ietf-quic-transport&ver=34&fmt=txt
        # 转发到 IETF 官方正文（rfc-editor.org / ietf.org/archive），只做原样搬运。
        if path == "/api/docfile":
            qs = urllib.parse.parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0].strip().lower()
            ver = (qs.get("ver") or [""])[0].strip()
            fmt = (qs.get("fmt") or ["txt"])[0].strip().lower()
            if not NAME_RE.match(name) or fmt not in FMT_TYPES:
                return self._json(400, b'{"error":"bad name or format"}')
            if name.startswith("draft-"):
                if not VER_RE.match(ver):
                    return self._json(400, b'{"error":"draft needs a 2-3 digit version"}')
                url = f"https://www.ietf.org/archive/id/{name}-{ver}.{fmt}"
            else:
                url = f"https://www.rfc-editor.org/rfc/{name}.{fmt}"
            return self._serve_doc(url, fmt)

        # /api/docmeta/<name>  → 版本信息（rev / rfc 号），给"选版本下载"用
        if path.startswith("/api/docmeta/"):
            name = urllib.parse.unquote(path[len("/api/docmeta/"):]).strip("/").lower()
            if not NAME_RE.match(name):
                return self._json(400, b'{"error":"bad name"}')
            status, body, _ = dt_get(f"/doc/document/{urllib.parse.quote(name)}/")
            if status != 200:
                return self._json(status, body)
            try:
                ob = json.loads(body)
                slim = {
                    "name": ob.get("name") or name,
                    "rev": ob.get("rev") or "",
                    "rfc": ob.get("rfc_number") or None,
                    "pages": ob.get("pages"),
                    "title": ob.get("title") or "",
                }
                return self._json(200, json.dumps(slim).encode())
            except Exception:
                return self._json(502, b'{"error":"bad upstream payload"}')

        # /api/live/doc/<draft-name>   → 单篇文档
        if path.startswith("/api/live/doc/"):
            name = urllib.parse.unquote(path[len("/api/live/doc/"):]).strip("/")
            if not name:
                return self._json(400, b'{"error":"missing name"}')
            status, body, _ = dt_get(f"/doc/document/{urllib.parse.quote(name)}/")
            return self._json(status, body)

        # /api/live/group/<acronym>    → 单个组（Datatracker 只支持数字 id 直取，故用 acronym 过滤）
        if path.startswith("/api/live/group/"):
            acr = urllib.parse.unquote(path[len("/api/live/group/"):]).strip("/")
            if not acr:
                return self._json(400, b'{"error":"missing acronym"}')
            status, body, _ = dt_get(f"/group/group/?acronym={urllib.parse.quote(acr)}")
            if status == 200:
                try:
                    objs = json.loads(body).get("objects") or []
                    if objs:
                        return self._json(200, json.dumps(objs[0]).encode())
                    return self._json(404, b'{"error":"group not found"}')
                except Exception:
                    pass
            return self._json(status, body)

        # /api/health
        if path == "/api/health":
            return self._json(200, json.dumps({"ok": True, "snapshot": _snapshot_meta()}).encode())

        # 静态资源；找不到就回落到 index.html（SPA 行为）
        fs_path = self.translate_path(path)
        if not os.path.exists(fs_path) or (os.path.isdir(fs_path) and not os.path.exists(os.path.join(fs_path, "index.html"))):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        # SW 与数据快照不缓存，外壳短缓存
        if self.path.startswith("/sw.js") or self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()


def _snapshot_meta():
    try:
        with open(os.path.join(ROOT, "data", "snapshot.json"), "rb") as f:
            head = f.read(400).decode("utf-8", "ignore")
        i = head.find('"generated":"')
        return head[i + 13:i + 33] if i > 0 else "unknown"
    except Exception:
        return "unknown"


def main():
    port = int(os.environ.get("PORT", "8080"))
    auth.ensure_seed()
    socketserver.TCPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"ietf-atlas serving {ROOT} on 0.0.0.0:{port}", flush=True)
    # 发送前的钩子会往日志里打就绪行（见 Handler.log_request）
    httpd.serve_forever()


if __name__ == "__main__":
    main()
