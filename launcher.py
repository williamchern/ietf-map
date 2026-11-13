#!/usr/bin/env python3
"""IETF Atlas 启动器（给发布环境用）。

发布环境里端口是动态注入的 $PORT，而且有个探针会在服务起来之前就开始敲端口：
被拒的连接会让 Python 的 HTTPServer 直接退出，于是探针永远打不通。
这里把"端口没开"当成常态：先占住端口再立刻重试，探针每次都能拿到响应。

    python3 launcher.py            # 读 $PORT，默认 8080
"""
import errno
import os
import socket
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as app  # noqa: E402


class ResilientServer(app.ThreadingHTTPServer):
    # 关键：句柄出错（如探针在 accept 后立刻断开）时不要退出进程
    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError, socket.timeout)):
            return
        super().handle_error(request, client_address)


def bind(port):
    while True:
        try:
            return ResilientServer(("0.0.0.0", port), app.Handler)
        except OSError as e:
            if e.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL, errno.EACCES):
                print(f"ietf-atlas: 端口 {port} 暂时不可用（{e.strerror}），0.5 秒后重试", flush=True)
                threading.Event().wait(0.5)
                continue
            raise


def main():
    port = int(os.environ.get("PORT", "8080"))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = bind(port)
    print(f"Serving IETF Atlas on http://0.0.0.0:{port}/ (local: http://localhost:{port}/)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
