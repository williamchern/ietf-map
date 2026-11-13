#!/usr/bin/env python3
"""把 scripts/out/*.json 合并压缩为 app/data/snapshot.json（PWA 运行时消费）。

用法：
    python3 scripts/fetch.py        # 拉取草案/组/关系 → scripts/out/
    python3 scripts/fetch_rfcs.py   # 拉取全部 RFC → scripts/out/rfcs.json（可低频更新）
    python3 scripts/pack.py         # 合并 → app/data/snapshot.json
"""
import json, os, gzip, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'out')
DST = os.path.abspath(os.path.join(HERE, '..', 'app', 'data', 'snapshot.json'))

GSTATE = {
    'Active': 'active', 'Concluded': 'concluded', 'BOF': 'bof', 'BOF Requested': 'bof',
    'Proposed': 'proposed', 'Dormant': 'dormant', 'Replaced': 'replaced',
}

groups = json.load(open(os.path.join(SRC, 'groups.json')))
for g in groups:
    g['state'] = GSTATE.get(g['state'], g['state'].lower())
    g['type'] = (g['type'] or '').lower()          # WG / Area / RG → wg / area / rg
gid2acr = {str(g['id']): g['acr'] for g in groups}

def kw_parse(v):
    if isinstance(v, list):
        return v
    try:
        r = json.loads(v)
        return r if isinstance(r, list) else []
    except Exception:
        return []

docs = json.load(open(os.path.join(SRC, 'docs.json')))
rfcs_path = os.path.join(SRC, 'rfcs.json')
if os.path.exists(rfcs_path):
    have = {d['n'] for d in docs}
    docs += [r for r in json.load(open(rfcs_path)) if r['n'] not in have]

# 文稿的 group 字段在 API 里是组 ID，转成 acronym；未知则置空
for d in docs:
    gid = str(d.get('g') or '')
    acr = gid2acr.get(gid)
    d['g'] = None if acr in (None, '', 'none') else acr

# 丢弃无组归属的草案（Individual Submissions，个人稿，与工作组地图无关）
_before = len(docs)
docs = [d for d in docs if d.get('g') or d.get('ty') == 'rfc']
print(f'drop {_before - len(docs)} ungrouped drafts')

names = {d['n'] for d in docs}
# 关系：优先用批量抓取的结果（围绕本地文档集合，双方向，无深分页漏条）
rels_src = os.path.join(SRC, 'rels2.json')
if not os.path.exists(rels_src):
    rels_src = os.path.join(SRC, 'rels.json')
rels = json.load(open(rels_src))
_before = len(rels)
# 任一端在本地即可保留：source 在本地 → 断链分析；target 在本地 → 被引计数
rels = [r for r in rels if r[0] in names or (r[2] and r[2] in names)]
print(f'rels {_before} → {len(rels)} (relation source: {os.path.basename(rels_src)})')

# ---- 关系表压缩：名字池 + 整数索引 ----
RELS = sorted({r[1] for r in rels})
REL_IDX = {t: i for i, t in enumerate(RELS)}
pool, pool_idx = [], {}
local = names

def nid(n):
    if not n:
        return -1
    i = pool_idx.get(n)
    if i is None:
        i = len(pool)
        pool.append(n)
        pool_idx[n] = i
    return i

packed = []
for src, rel, tgt in rels:
    # 外部 source 丢掉（断链分析用不到；被引计数只需 target）
    s_i = nid(src) if src in local else -1
    t_i = nid(tgt)
    if s_i < 0 and t_i < 0:
        continue
    packed.append([s_i, REL_IDX[rel], t_i])

payload = {
    'meta': {
        'generated': datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC'),
        'source': 'https://datatracker.ietf.org/api/',
        'groups': len(groups), 'docs': len(docs), 'rels': len(packed), 'bytes': 0,
    },
    'groups': [
        [g['id'], g['acr'], g['name'], g['type'], g['state'], g['parent'],
         (g['desc'] or '')[:500], g['list']]
        for g in groups
    ],
    'docs': [
        [d['n'], d['t'], d['ty'], d['g'], d['rfc'], d['rev'], '|'.join(d['st']),
         d['lev'], d['stream'], d['time'], d['ab'][:320], '|'.join(kw_parse(d.get('kw')))]
        for d in docs
    ],
    'relTypes': RELS,
    'namePool': pool,
    'rels': packed,
}

raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
payload['meta']['bytes'] = len(raw.encode('utf-8'))
raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))

os.makedirs(os.path.dirname(DST), exist_ok=True)
open(DST, 'w', encoding='utf-8').write(raw)
with gzip.open(DST + '.gz', 'wb', 9) as f:
    f.write(raw.encode('utf-8'))
print(f'{DST}  {len(raw)/1048576:.2f} MB  (gz {os.path.getsize(DST + ".gz")/1048576:.2f} MB)')
print(f'groups={len(groups)} docs={len(docs)} rels={len(packed)} namePool={len(pool)}')
