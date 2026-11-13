#!/usr/bin/env python3
"""生成知识图谱的**静态坐标**（离线算一次，运行时只按坐标画 SVG）。

为什么不运行时算：力导向每刷新一次就换一个样子，用户会以为"图乱了"。
分层布局（Sugiyama）在 IETF 这种「谁引用谁」的有向图上天然可读：
同一列 = 同一个层次，箭头永远指向下一列，交叉数由 graphviz 的 dot 去最小化。

产物 app/data/layout.json：
  groups[acr] = { rank, cols: {rank: [[doc,…], …]}, links: [[a,b,norm,info]], nodes: {doc:{rank,row,order}} }
坐标系为网格单位（列 = rank，行 = 稀疏序号），前端按格子换算成像素，与屏幕无关。

依赖：graphviz(dot)。装不上就跳过，前端会自动退回按被引量算出的稳定坐标。
"""
import json, gzip, os, subprocess, collections, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = os.path.join(ROOT, 'app', 'data', 'snapshot.json.gz')
OUT = os.path.join(ROOT, 'app', 'data', 'layout.json')

# 组的关键词：用于挑「代表组」。只是给人看的示例，不影响数据
FEATURED = ['quic', 'httpbis', 'tls', 'dnsop', 'dnsext', 'netconf', 'netmod', 'emod', 'eman',
            'green', 'lsr', 'ospf', 'isis', 'idr', 'pim', 'mpls', 'teas', 'ccamp', 'pce',
            '6man', 'v6ops', 'ipv6', 'sidr', 'sidrops', 'oauth', 'httpapi', 'imas',
            'sipcore', 'sipping', 'core', 'ace', 'secevent', 'jose', 'cose', 'lamps', 'pkix']

REL = ['refnorm', 'refinfo']
DEAD = ('repl', 'expired', 'dead', 'withdrawn', 'deleted')

PICK = 32      # 每个领域最多画几份文稿：再多就成了一团麻，看不出"谁支持谁"
MAXD = 3       # 从种子出发最多走几步（引用链的"邻里半径"）


def live(row):
    st = (row[6] or '')
    return not any(x in st for x in DEAD)


def load():
    with gzip.open(SNAP) as f:
        d = json.load(f)
    pool = d['namePool']
    types = d['relTypes']
    docs = {r[0]: r for r in d['docs']}
    groups = {g[1]: g for g in d['groups']}
    rels = []
    for a, b, c in d['rels']:
        t = types[b]
        if t not in REL:
            continue
        na = pool[a] if a >= 0 else None
        nc = pool[c] if c >= 0 else None
        rels.append((na, t, nc))
    return docs, groups, rels


def doc_subgraph(docs, rels, acr, limit=PICK):
    """某组内的活跃文档 + 组内引用边。

    不是"取前 N 个节点"，而是**抽主干**：从组内被引最多的几份文稿出发，
    沿引用边双向各走 maxd 步，得到连接最密的那个核心子图。
    这样图里每一根线都有意义，而不是一片谁和谁都不挨着的散点。
    """
    mine = [n for n, r in docs.items() if r[3] == acr and live(r)]
    mset = set(mine)
    cited = collections.Counter()
    edges = collections.Counter()
    adj = collections.defaultdict(set)
    for s, t, g in rels:
        if s in mset and g in mset and s != g:
            edges[(s, g)] += 1
            cited[s] += 1
            cited[g] += 1
            adj[s].add(g)
            adj[g].add(s)
    if len(mine) <= limit:
        keep = mine
    else:
        # 种子：组内被引最多的若干份（含互相引用的成对）
        seeds = [n for n, _ in cited.most_common(6)]
        keep, frontier, d = set(seeds), set(seeds), 0
        while d < MAXD and len(keep) < limit and frontier:
            nxt = []
            for n in sorted(frontier, key=lambda x: -cited[x]):
                for m in adj[n]:
                    if m not in keep:
                        keep.add(m)
                        nxt.append(m)
                        if len(keep) >= limit:
                            break
                if len(keep) >= limit:
                    break
            frontier = set(nxt)
            d += 1
        # 还差得远（图太稀疏）就把剩下的按被引量补上
        if len(keep) < limit // 2:
            for n in sorted(mine, key=lambda x: (-cited[x], x)):
                if n not in keep:
                    keep.add(n)
                if len(keep) >= limit // 2:
                    break
    kset = set(keep)
    edges = collections.Counter({k: v for k, v in edges.items() if k[0] in kset and k[1] in kset})
    # 没有任何边的孤立文档不入图（它们只是列表，不是图）
    linked = set()
    for s, g in edges:
        linked.add(s); linked.add(g)
    return [n for n in mine if n in linked], edges


def dot_layout(nodes, edges):
    """用 graphviz dot 拿到分层坐标；失败返回 None"""
    ids = {n: 'n%d' % i for i, n in enumerate(nodes)}
    body = ['digraph G {', 'rankdir=TB; nodesep=0.16; ranksep=0.34; splines=true;']
    for n in nodes:
        body.append('%s [width=0.3,height=0.3];' % ids[n])
    for (s, g), w in edges.items():
        if s in ids and g in ids:
            body.append('%s -> %s;' % (ids[s], ids[g]))
    body.append('}')
    try:
        out = subprocess.run(['dot', '-Tplain'], input='\n'.join(body), text=True,
                             capture_output=True, timeout=60)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    pos = {}
    for line in out.stdout.splitlines():
        p = line.split()
        if len(p) >= 6 and p[0] == 'node':
            pos[p[1]] = (float(p[2]), float(p[3]))
        if len(p) >= 2 and p[0] == 'stop':
            break
    return {n: pos.get(ids[n]) for n in nodes}


def deterministic_layout(nodes, edges, docs):
    """没有 dot 时的兜底：按「有多少条出边」定层，层内按被引量排，坐标稳定可复现"""
    indeg = collections.Counter()
    for (s, g) in edges:
        indeg[g] += 1
    rank = {}
    for n in nodes:
        rank[n] = 0 if indeg[n] else 1
    cols = collections.defaultdict(list)
    for n in nodes:
        cols[rank[n]].append(n)
    pos = {}
    for r, arr in cols.items():
        arr.sort(key=lambda n: (-(docs[n][0].startswith('rfc')), n))
        for i, n in enumerate(arr):
            pos[n] = (r, i)
    return pos


def rows_from_pos(nodes, pos, docs, span=2.0):
    """把 x 按跨度归并成列（dot 的 x 是连续坐标，直接 round 会碎成几十个单节点列）"""
    xs = sorted({pos[n][0] for n in nodes})
    base = xs[0] if xs else 0
    # 列号取整：连续坐标直接 //span 会把同一层的点拆成两列，明明同层却错开一格
    cols = collections.defaultdict(list)
    for n in nodes:
        x, y = pos[n]
        cols[int(round((x - base) / span))].append((y, n))
    cols = {k: v for k, v in cols.items() if v}
    out = collections.defaultdict(list)
    order = {}
    for r, arr in cols.items():
        arr.sort()
        for i, (y, n) in enumerate(arr):
            out[r].append(n)
            # y 保留 dot 的原始垂直坐标：前端靠它把各层对齐到同一条行网格上
            order[n] = {'rank': r, 'row': i, 'y': round(y, 2)}
    return out, order


def main():
    docs, groups, rels = load()

    # ---- 组的全量跨组关系（只用于「组依赖」这幅图）----
    gstat = collections.defaultdict(lambda: {'in': 0, 'out': 0})
    gedge = collections.Counter()
    for s, t, g in rels:
        a = docs.get(s) if s else None
        b = docs.get(g) if g else None
        if not a or not b or not a[3] or not b[3] or a[3] == b[3]:
            continue
        gedge[(a[3], b[3])] += 1
        gstat[a[3]]['out'] += 1
        gstat[b[3]]['in'] += 1

    # ---- 代表组：优先 FEATURED 里数据量大的，再补几个「被很多组引用」的核心组 ----
    cand = []
    for acr in FEATURED:
        if acr in groups and gstat.get(acr):
            cand.append(acr)
    core = sorted(gstat.items(), key=lambda kv: -(kv[1]['in'] + kv[1]['out']))[:24]
    picked = []
    for acr, _ in core:
        if acr not in picked:
            picked.append(acr)
    ordered = [a for a in cand if a in gstat]
    for a in picked:
        if a not in ordered:
            ordered.append(a)
    ordered = ordered[:28]

    out = {'meta': {}, 'groups': {}}
    for acr in ordered:
        nodes, edges = doc_subgraph(docs, rels, acr)
        if len(nodes) < 2:
            continue
        pos = dot_layout(nodes, edges) or deterministic_layout(nodes, edges, docs)
        cols, order = rows_from_pos(nodes, pos, docs)
        # 只保留 columns 结构 + 每条边（带权重）
        out['groups'][acr] = {
            'name': groups.get(acr, [None, acr, '', '', ''])[2][:80],
            'docs': nodes,
            'cols': {str(k): v for k, v in sorted(cols.items())},
            'order': order,
            'links': [[s, g, w, 1] for (s, g), w in edges.items()],
        }
        print('%-10s docs=%3d edges=%3d ranks=%d' % (acr, len(nodes), len(edges), len(cols)))

    # ---- 组级依赖图：只用「被引最多」的组，按总引用量排名 ----
    top = [acr for acr, _ in sorted(gstat.items(), key=lambda kv: -(kv[1]['in'] + kv[1]['out']))[:40]]
    topset = set(top)
    gedges = [[a, b, n] for (a, b), n in gedge.items() if a in topset and b in topset]

    out['meta'] = {
        'generated': 'offline',
        'featured': list(out['groups'].keys()),
        'ranked': [{'acr': a, 'in': gstat[a]['in'], 'out': gstat[a]['out'], 'name': groups.get(a, [None, a, '', ''])[2][:60]}
                   for a in top],
        'groupLinks': gedges,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes; groups', len(out['groups']), 'ranked', len(top), 'gedges', len(gedges))


if __name__ == '__main__':
    main()
