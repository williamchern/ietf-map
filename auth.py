"""账号与会话（服务端，标准库实现）。

设计取舍：
- 用户存 `state/users.json`（在 app/ 之外，静态托管碰不到），密码用 PBKDF2-HMAC-SHA256 加盐散列；
- 会话是**签名 Cookie**，服务端不存 session 表——进程重启不掉线，也不怕多线程抢写；
- 首次启动自动建 `admin / admin`，登录后强制改密码；
- 会话里带 `pv`（密码版本），改密码 / 重置密码会让旧 Cookie 立即失效。

这不是"加密保险箱"：应用数据本来就存在各人浏览器里，这里的账号是**门禁**，
决定谁能打开这个实例、谁能建账号。
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
USERS_FILE = os.path.join(STATE_DIR, "users.json")
SECRET_FILE = os.path.join(STATE_DIR, "secret")
AUDIT_FILE = os.path.join(STATE_DIR, "auth.log")

ITER = 210_000
SESSION_TTL = 12 * 3600          # 12 小时
COOKIE = "atlas_sess"
NAME_RE = None                    # 由 server 复用的白名单风格：3-24 位字母数字 _ . -
MAX_BODY = 64 * 1024

_lock = threading.Lock()

# 登录失败节流：ip → [连续失败次数, 解禁时间]
_FAILS = {}
_FAIL_WINDOW = 15 * 60
_MAX_FAILS = 6


# ---------- 文件 ----------

def _ensure_dir():
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        os.chmod(STATE_DIR, 0o700)
    except OSError:
        pass


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, data):
    _ensure_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def _secret():
    _ensure_dir()
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "rb") as f:
            raw = f.read().strip()
            if len(raw) >= 32:
                return raw
    raw = secrets.token_bytes(32)
    with open(SECRET_FILE, "wb") as f:
        f.write(raw)
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return raw


# ---------- 密码 ----------

def hash_password(password, salt=None, iterations=ITER):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return {"salt": salt, "hash": dk.hex(), "iter": iterations}


def check_password(user, password):
    try:
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(user["salt"]), int(user.get("iter", ITER))
        )
        return hmac.compare_digest(dk.hex(), user["hash"])
    except Exception:
        return False


# ---------- 用户 ----------

def load_users():
    data = _read_json(USERS_FILE, None)
    if not isinstance(data, dict) or not isinstance(data.get("users"), list):
        return {"version": 1, "users": []}
    return data


def save_users(data):
    _write_json(USERS_FILE, data)


def ensure_seed():
    """首次启动：建 admin / admin，并要求登录后立即改密码。"""
    with _lock:
        data = load_users()
        if data["users"]:
            return
        pw = hash_password("admin")
        data["users"].append({
            "name": "admin",
            "role": "admin",
            "salt": pw["salt"],
            "hash": pw["hash"],
            "iter": pw["iter"],
            "pv": 1,
            "must_change": True,
            "created": int(time.time() * 1000),
            "last_login": 0,
            "note": "初始管理员，请登录后修改密码",
        })
        save_users(data)
        _audit("seed", "创建初始管理员 admin（初始密码 admin，待修改）")


def find_user(name):
    data = load_users()
    for u in data["users"]:
        if u.get("name", "").lower() == str(name or "").lower():
            return u
    return None


def public_user(u):
    return {
        "name": u.get("name"),
        "role": u.get("role", "user"),
        "must_change": bool(u.get("must_change")),
        "created": u.get("created", 0),
        "last_login": u.get("last_login", 0),
        "note": u.get("note", ""),
    }


def list_users():
    return [public_user(u) for u in load_users()["users"]]


def create_user(name, password, role="user", note=""):
    with _lock:
        data = load_users()
        if any(u.get("name", "").lower() == name.lower() for u in data["users"]):
            raise ValueError("同名账号已存在")
        if role not in ("admin", "user"):
            raise ValueError("角色只能是 admin 或 user")
        pw = hash_password(password)
        data["users"].append({
            "name": name,
            "role": role,
            "salt": pw["salt"],
            "hash": pw["hash"],
            "iter": pw["iter"],
            "pv": 1,
            "must_change": True,
            "created": int(time.time() * 1000),
            "last_login": 0,
            "note": note or "",
        })
        save_users(data)
        _audit("user-create", f"{name}（{role}）")
        return public_user(data["users"][-1])


def reset_password(name, password):
    with _lock:
        data = load_users()
        for u in data["users"]:
            if u.get("name", "").lower() == name.lower():
                pw = hash_password(password)
                u.update(salt=pw["salt"], hash=pw["hash"], iter=pw["iter"])
                u["pv"] = int(u.get("pv", 1)) + 1      # 旧会话立即失效
                u["must_change"] = True
                save_users(data)
                _audit("user-reset", name)
                return public_user(u)
        raise ValueError("账号不存在")


def change_own_password(name, password):
    """自己改密码：不强制下次再改，但旧会话全部失效（本机拿到新 Cookie 继续用）。"""
    with _lock:
        data = load_users()
        for u in data["users"]:
            if u.get("name", "").lower() == name.lower():
                pw = hash_password(password)
                u.update(salt=pw["salt"], hash=pw["hash"], iter=pw["iter"])
                u["pv"] = int(u.get("pv", 1)) + 1
                u["must_change"] = False
                save_users(data)
                _audit("password-change", name)
                return public_user(u)
        raise ValueError("账号不存在")


def delete_user(name):
    with _lock:
        data = load_users()
        target = None
        for u in data["users"]:
            if u.get("name", "").lower() == name.lower():
                target = u
                break
        if not target:
            raise ValueError("账号不存在")
        admins = [u for u in data["users"] if u.get("role") == "admin"]
        if target.get("role") == "admin" and len(admins) <= 1:
            raise ValueError("至少要保留一个管理员")
        data["users"].remove(target)
        save_users(data)
        _audit("user-delete", name)
        return True


def touch_login(name):
    with _lock:
        data = load_users()
        for u in data["users"]:
            if u.get("name", "").lower() == name.lower():
                u["last_login"] = int(time.time() * 1000)
        save_users(data)


# ---------- 会话 ----------

def _b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def make_token(user, ttl=SESSION_TTL):
    payload = json.dumps({
        "u": user["name"],
        "pv": int(user.get("pv", 1)),
        "exp": int(time.time()) + ttl,
    }, separators=(",", ":")).encode()
    body = _b64(payload)
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).digest()
    return body + "." + _b64(sig)


def read_token(token):
    """验签 + 过期 + 密码版本，返回用户 dict；任何一项不对都返回 None。"""
    try:
        body, sig = token.split(".", 1)
        want = hmac.new(_secret(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, _unb64(sig)):
            return None
        payload = json.loads(_unb64(body))
        if int(payload.get("exp", 0)) < time.time():
            return None
        u = find_user(payload.get("u"))
        if not u or int(u.get("pv", 1)) != int(payload.get("pv", -1)):
            return None
        return u
    except Exception:
        return None


# ---------- 登录节流 ----------

def throttle_left(ip):
    rec = _FAILS.get(ip)
    if not rec:
        return 0
    left = int(rec[1] - time.time())
    return max(0, left)


def note_fail(ip):
    rec = _FAILS.setdefault(ip, [0, 0])
    rec[0] += 1
    if rec[0] >= _MAX_FAILS:
        # 失败越多等越久：30s → 60s → 120s …上限 15 分钟
        wait = min(900, 30 * (2 ** (rec[0] - _MAX_FAILS)))
        rec[1] = time.time() + wait
        rec[0] = 0
        _audit("login-lock", f"{ip} 连续失败，锁定 {wait}s")


def note_ok(ip):
    _FAILS.pop(ip, None)


# ---------- 审计 ----------

def _audit(action, detail):
    try:
        _ensure_dir()
        line = json.dumps({
            "ts": int(time.time() * 1000),
            "action": action,
            "detail": detail,
        }, ensure_ascii=False)
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        try:
            os.chmod(AUDIT_FILE, 0o600)
        except OSError:
            pass
    except Exception:
        pass


def audit(action, detail):
    _audit(action, detail)


def tail_audit(n=200):
    try:
        with open(AUDIT_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()[-n:]
        return [json.loads(l) for l in lines if l.strip()]
    except Exception:
        return []


# ---------- 命令行运维（服务器上只剩一个管理员、密码又忘了时用） ----------

def _cli():
    import argparse
    ap = argparse.ArgumentParser(
        prog="auth.py",
        description="IETF Atlas 账号运维。服务不用停，改完立刻生效（旧会话全部失效）。",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("reset", help="强制重设某人密码，并要求其下次登录先改密码")
    p.add_argument("user")
    p.add_argument("password")

    p = sub.add_parser("list", help="列出账号")
    p.add_argument("--with-hash", action="store_true", help="连散列一起打印（一般不需要）")

    p = sub.add_parser("add", help="新建账号")
    p.add_argument("user")
    p.add_argument("password")
    p.add_argument("--role", choices=["admin", "user"], default="user")
    p.add_argument("--note", default="")

    p = sub.add_parser("rm", help="删除账号（至少保留一个管理员）")
    p.add_argument("user")

    a = ap.parse_args()

    if a.cmd == "list":
        rows = list_users()
        if not rows:
            print("（还没有账号，启动一次服务会自动播种 admin/admin）")
        for u in rows:
            flag = "待改密" if u["must_change"] else "正常"
            ts = int(u.get("last_login") or 0) / 1000
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) if ts else "从未"
            print(f"{u['name']:<20} {u['role']:<6} {flag:<4} 最近登录 {when}"
                  + (f"  {u['hash']}" if a.with_hash else ""))
        return

    try:
        if a.cmd == "reset":
            reset_password(a.user, a.password)
            print(f"已重设 {a.user} 的密码；对方下次登录会被要求再改一次。")
        elif a.cmd == "add":
            create_user(a.user, a.password, a.role, a.note)
            print(f"已创建 {a.user}（{a.role}），初始密码需在首次登录时修改。")
        elif a.cmd == "rm":
            delete_user(a.user)
            print(f"已删除 {a.user}。")
    except ValueError as e:
        print(f"失败：{e}")


if __name__ == "__main__":
    ensure_seed()
    _cli()
