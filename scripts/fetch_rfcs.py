
import json, os, time, urllib.request, urllib.parse, gzip
BASE = "https://datatracker.ietf.org"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

def get(url, retries=5):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ietf-atlas-build/1.0", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=150) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return json.loads(data)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 + 3 * i)

def slug(u):
    return u.rstrip("/").split("/")[-1] if u else None

states = get(BASE + "/api/v1/doc/state/?format=json&limit=1000")["objects"]
st_map = {s["id"]: s["slug"] for s in states}
STATES_OF_INTEREST = {"rfc", "ps", "is", "bcp", "exp", "inf", "hist", "exp-hist", "dyngc", "gc", "norm-ref"}
out, offset = [], 0
while True:
    d = get(BASE + "/api/v1/doc/document/?format=json&limit=1000&offset=%d&type=rfc" % offset)
    objs = d["objects"]
    for x in objs:
        sts = []
        for s in x.get("states") or []:
            m = st_map.get(int(s.rstrip("/").split("/")[-1]))
            if m: sts.append(m)
        out.append({"n": x["name"], "t": x["title"], "ty": "rfc",
            "g": slug(x["group"]) if x["group"] else None,
            "rfc": x["rfc_number"], "rev": "", "st": ["rfc"] + sts,
            "lev": slug(x["std_level"]) if x["std_level"] else None,
            "stream": slug(x["stream"]) if x["stream"] else None,
            "time": (x["time"] or "")[:10], "pg": x["pages"],
            "kw": x.get("keywords") or [], "ab": (x["abstract"] or "")[:900]})
    offset += len(objs)
    print(offset, "/", d["meta"]["total_count"], flush=True)
    if not objs or offset >= d["meta"]["total_count"]:
        break
os.makedirs(OUT, exist_ok=True)
json.dump(out, open(os.path.join(OUT, "rfcs.json"), "w"), ensure_ascii=False)
print("rfcs", len(out))

