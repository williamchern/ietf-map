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

    def _json(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=60")
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

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

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
    socketserver.TCPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"ietf-atlas serving {ROOT} on 0.0.0.0:{port}", flush=True)
    # 发送前的钩子会往日志里打就绪行（见 Handler.log_request）
    httpd.serve_forever()


if __name__ == "__main__":
    main()
