#!/usr/bin/env python3
"""按文档集合批量抓取关系（避免 /relateddocument/ 深分页超时）。

Datatracker 的 relateddocument 全量约 59 万条，用 offset 深分页会逐渐变慢甚至超时。
这里改成：拿本地文档名单，用 source__name__in / target__name__in 分批查询，
每批结果都远小于单页上限，既快又不会漏。
"""
import concurrent.futures as cf
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://datatracker.ietf.org"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
UA = "ietf-atlas-build/1.0"
BATCH = 50
WORKERS = 4
KEEP_REL = {"updates", "obs", "refnorm", "refinfo", "replaces", "possibly-replaces",
            "became_rfc", "tohist", "tois", "tops", "tobcp", "toinf", "toexp", "conflrev"}


def get(url, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                if body[:2] == b"\x1f\x8b":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {"objects": [], "meta": {"total_count": 0}}
            if i == retries - 1:
                raise
            time.sleep(1 + i)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(1 + i * 2)


def slug(u):
    return u.rstrip("/").split("/")[-1] if u else None


def fetch_chunk(args):
    field, names = args
    out = []
    offset = 0
    while True:
        q = urllib.parse.urlencode({field: ",".join(names), "limit": 1000, "offset": offset, "order_by": "id"})
        d = get(f"{BASE}/api/v1/doc/relateddocument/?{q}")
        objs = d.get("objects") or []
        for r in objs:
            rel = slug(r["relationship"])
            if rel not in KEEP_REL:
                continue
            tgt = slug(r["target"]) if r["target"] else r.get("originaltargetaliasname")
            out.append([slug(r["source"]), rel, tgt])
        offset += len(objs)
        if not objs or offset >= d["meta"]["total_count"] or len(objs) < 1000:
            break
    return out


def main():
    names = []
    for f in ("docs.json", "rfcs.json"):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            names += [x["n"] for x in json.load(open(p))]
    names = sorted(set(names))
    print(f"documents: {len(names)}", flush=True)

    tasks = []
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        tasks.append(("source__name__in", chunk))
        tasks.append(("target__name__in", chunk))
    print(f"batches: {len(tasks)}", flush=True)

    rows, done = [], 0
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for res in ex.map(fetch_chunk, tasks):
            rows += res
            done += 1
            if done % 60 == 0:
                print(f"  {done}/{len(tasks)}  rels={len(rows)}", flush=True)

    # 去重（source, rel, target 三元组）
    uniq = list({(r[0], r[1], r[2]) if r[2] else (r[0], r[1], "") for r in rows})
    out = [[a, b, c or None] for a, b, c in uniq]
    json.dump(out, open(os.path.join(OUT, "rels2.json"), "w"), ensure_ascii=False)
    print(f"rels {len(rows)} → uniq {len(out)}", flush=True)


if __name__ == "__main__":
    main()
