#!/usr/bin/env python3
"""拉取 datatracker 数据，生成 IETF 文稿地图的离线快照（精简版：skipped 状态不入库）。"""
import json, os, time, urllib.request, urllib.parse, gzip

BASE = "https://datatracker.ietf.org"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)
SKIP_STATES = {"expired", "replaced", "replaced documents", "dead", "withdrawn", "deleted", "draft withdrawn", "replaced ietf stream", "published"}
KEEP_TYPES = {"draft", "rfc"}


def get(url, retries=5):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ietf-atlas-build/1.0",
                                                       "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=150) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return json.loads(data)
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(2 + 3 * i)


def slug(uri):
    return uri.rstrip("/").split("/")[-1] if uri else None


def paged(path, params, keep=None, cap=1_000_000, label=""):
    params = dict(params)
    params.setdefault("limit", 1000)
    # 关键：固定排序键，避免服务端默认顺序在数据持续变化时漂移，导致 offset 翻页漏条
    params.setdefault("order_by", "id")
    offset, out, total = 0, [], None
    seen_ids, dups = set(), 0
    while offset < cap:
        params["offset"] = offset
        d = get(BASE + path + "?" + urllib.parse.urlencode(params))
        total = d["meta"]["total_count"]
        objs = d["objects"]
        for o in objs:
            oid = o.get("id")
            if oid is not None:
                if oid in seen_ids:
                    dups += 1
                seen_ids.add(oid)
        for o in objs:
            r = keep(o) if keep else o
            if r is not None:
                out.append(r)
        offset += len(objs)
        if offset % 50000 < 1000:
            print(f"  {label} {offset}/{total} kept={len(out)}", flush=True)
        if not objs or offset >= total:
            break
    flag = f"  !! 分页漂移：重复 {dups} 条" if dups else ""
    print(f"  {label} done {offset}/{total} kept={len(out)}{flag}", flush=True)
    return out


print("[0] enums", flush=True)
gstate = {o["slug"]: o["name"] for o in get(BASE + "/api/v1/name/groupstatename/?format=json&limit=100")["objects"]}
gtype = {o["slug"]: o["name"] for o in get(BASE + "/api/v1/name/grouptypename/?format=json&limit=100")["objects"]}
states = get(BASE + "/api/v1/doc/state/?format=json&limit=1000")["objects"]
st_map = {s["id"]: (s["slug"], slug(s["type"])) for s in states}

print("[1] groups", flush=True)
groups_raw = paged("/api/v1/group/group/", {}, label="groups")
gout = []
for g in groups_raw:
    gout.append({
        "id": g["id"], "acr": g["acronym"], "name": g["name"],
        "type": gtype.get(slug(g["type"]), slug(g["type"])),
        "state": gstate.get(slug(g["state"]), slug(g["state"])),
        "parent": int(g["parent"].rstrip("/").split("/")[-1]) if g["parent"] else None,
        "desc": "" if (g["description"] or "") == "No description available" else (g["description"] or ""),
        "charter": g["charter"], "list": g["list_email"], "archive": g["list_archive"],
    })
json.dump(gout, open(OUT + "/groups.json", "w"), ensure_ascii=False)
print("  groups", len(gout), flush=True)


def keep_doc(d):
    if slug(d["type"]) not in KEEP_TYPES:
        return None
    sts = []
    for s in d.get("states") or []:
        sid = int(s.rstrip("/").split("/")[-1])
        m = st_map.get(sid)
        if m:
            sts.append(m[0])
    if any(s.lower() in SKIP_STATES for s in sts):
        return None
    # 草稿只留有组归属的（个人稿太杂），RFC 全部保留
    if not d["group"] and not d["rfc_number"]:
        return None
    return {
        "n": d["name"], "t": d["title"], "ty": slug(d["type"]),
        "g": slug(d["group"]) if d["group"] else None,
        "rfc": d["rfc_number"], "rev": d["rev"] or "00",
        "st": sts, "lev": slug(d["std_level"]) if d["std_level"] else None,
        "stream": slug(d["stream"]) if d["stream"] else None,
        "time": (d["time"] or "")[:10], "pg": d["pages"],
        "kw": d.get("keywords") or [], "ab": (d["abstract"] or "")[:900],
    }


print("[2] documents", flush=True)
docs = paged("/api/v1/doc/document/", {}, keep=keep_doc, label="docs")
json.dump(docs, open(OUT + "/docs.json", "w"), ensure_ascii=False)
print("  docs", len(docs), flush=True)

KEEP_REL = {"updates", "obs", "refnorm", "refinfo", "replaces", "possibly-replaces",
            "became_rfc", "tohist", "tois", "tops", "tobcp", "toinf", "toexp", "conflrev"}


def keep_rel(r):
    rel = slug(r["relationship"])
    if rel not in KEEP_REL:
        return None
    tgt = slug(r["target"]) if r["target"] else r.get("originaltargetaliasname")
    return [slug(r["source"]), rel, tgt]


print("[3] relations", flush=True)
rels = paged("/api/v1/doc/relateddocument/", {}, keep=keep_rel, label="rels")
json.dump(rels, open(OUT + "/rels.json", "w"), ensure_ascii=False)
print("  rels", len(rels), flush=True)
print("DONE", flush=True)
