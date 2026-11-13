/* IETF Atlas — 关联分析：组级聚合、路径发现、桥梁节点 */

/**
 * 计算组级关联图。
 * 只统计「跨组」引用：同一组的文稿互相引用属于组内消化，不构成组间知识流。
 * 每条边记录：条数、规范/信息性占比、代表性文稿对、证据边列表。
 */
export function buildGroupGraph(idx, opts = {}) {
  const { minWeight = 1, onlyTouched = null } = opts;
  const edges = new Map();   // "a|b" -> {a,b,count,norm,info,evidences[]}
  const nodeStat = new Map(); // acr -> {out,in,norm,info}

  for (const [src, rel, tgt] of idx.snap.rels) {
    if (!src || !tgt) continue;
    if (!['refnorm', 'refinfo', 'updates', 'obs', 'replaces'].includes(rel)) continue;
    const a = idx.docs.get(src), b = idx.docs.get(tgt);
    if (!a || !b) continue;
    const ga = a.g, gb = b.g;
    if (!ga || !gb || ga === gb) continue;
    if (onlyTouched && !onlyTouched.has(ga) && !onlyTouched.has(gb)) continue;

    const key = `${ga}|${gb}`;
    let e = edges.get(key);
    if (!e) {
      e = { a: ga, b: gb, count: 0, norm: 0, info: 0, other: 0, evidences: [] };
      edges.set(key, e);
    }
    e.count++;
    if (rel === 'refnorm') e.norm++;
    else if (rel === 'refinfo') e.info++;
    else e.other++;
    // 证据只留最有价值的若干条（规范性优先，靠后由排序挑）
    if (e.evidences.length < 60) {
      e.evidences.push({ from: src, to: tgt, rel });
    }
    const sa = nodeStat.get(ga) || { out: 0, in: 0 };
    sa.out++; nodeStat.set(ga, sa);
    const sb = nodeStat.get(gb) || { out: 0, in: 0 };
    sb.in++; nodeStat.set(gb, sb);
  }

  const list = [...edges.values()].filter(e => e.count >= minWeight);
  // 证据排序：规范性在前，再按被引
  for (const e of list) {
    e.evidences.sort((x, y) => {
      const w = r => (r === 'refnorm' ? 2 : r === 'refinfo' ? 1 : 3);
      return w(y.rel) - w(x.rel) || (idx.cited.get(y.to) || 0) - (idx.cited.get(x.to) || 0);
    });
    e.evidences = e.evidences.slice(0, 12);
  }
  list.sort((x, y) => (y.norm * 2 + y.info) - (x.norm * 2 + x.info));
  return { edges: list, nodeStat };
}

/** 某个组的「知识根基」与「知识输出」 */
export function groupProfile(idx, acr) {
  const uses = new Map();   // 我依赖谁
  const usedBy = new Map(); // 谁依赖我
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, { group: k, count: 0, norm: 0, items: [] });
    const o = m.get(k);
    o.count++; if (v.rel === 'refnorm') o.norm++;
    if (o.items.length < 8) o.items.push(v);
  };
  for (const [src, rel, tgt] of idx.snap.rels) {
    if (!src || !tgt) continue;
    if (!['refnorm', 'refinfo'].includes(rel)) continue;
    const a = idx.docs.get(src), b = idx.docs.get(tgt);
    if (!a || !b) continue;
    if (a.g === acr && b.g && b.g !== acr) push(uses, b.g, { from: src, to: tgt, rel });
    if (b.g === acr && a.g && a.g !== acr) push(usedBy, a.g, { from: src, to: tgt, rel });
  }
  const rank = arr => arr.sort((x, y) => (y.norm * 2 + y.count) - (x.norm * 2 + x.count));
  return {
    uses: rank([...uses.values()]),
    usedBy: rank([...usedBy.values()]),
  };
}

/**
 * 文档级最短路径（无向，超过 maxDepth 就放弃）。
 * 返回 { nodes:[name], edges:[{from,to,rel}], depth } 或 null。
 */
export function shortestPath(idx, from, to, maxDepth = 4) {
  if (from === to) return { nodes: [from], edges: [], depth: 0 };
  if (!idx.docs.has(from) || !idx.docs.has(to)) return null;

  // 邻接表（只走引用边，双向）
  const adj = new Map();
  const add = (a, b, rel) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, rel });
  };
  for (const [src, rel, tgt] of idx.snap.rels) {
    if (!src || !tgt) continue;
    if (!['refnorm', 'refinfo', 'updates', 'obs', 'replaces'].includes(rel)) continue;
    add(src, tgt, rel);
    add(tgt, src, rel);
  }

  let frontier = [from];
  const prev = new Map([[from, null]]);
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of (adj.get(cur) || [])) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, rel: e.rel });
        if (e.to === to) {
          // 回溯
          const nodes = [to];
          const edges = [];
          let p = to;
          while (prev.get(p)) {
            const step = prev.get(p);
            edges.unshift({ from: step.from, to: p, rel: step.rel });
            nodes.unshift(step.from);
            p = step.from;
          }
          return { nodes, edges, depth: edges.length };
        }
        next.push(e.to);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return null;
}

/** 组之间的最短路径（把组当作聚合节点） */
export function shortestGroupPath(idx, fromG, toG, gg, maxDepth = 3) {
  if (fromG === toG) return { groups: [fromG], hops: [] };
  const adj = new Map();
  for (const e of gg.edges) {
    (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push({ to: e.b, edge: e });
    (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push({ to: e.a, edge: e });
  }
  let frontier = [fromG];
  const prev = new Map([[fromG, null]]);
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of (adj.get(cur) || [])) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, edge: e.edge });
        if (e.to === toG) {
          const groups = [toG], hops = [];
          let p = toG;
          while (prev.get(p)) {
            const s = prev.get(p);
            hops.unshift(s.edge);
            groups.unshift(s.from);
            p = s.from;
          }
          return { groups, hops };
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return null;
}

/** 桥梁节点：连接不同组最多的文稿（介数近似） */
export function bridgeNodes(idx, limit = 20) {
  const score = new Map();
  for (const [src, rel, tgt] of idx.snap.rels) {
    if (!src || !tgt) continue;
    if (!['refnorm', 'refinfo'].includes(rel)) continue;
    const a = idx.docs.get(src), b = idx.docs.get(tgt);
    if (!a || !b || !a.g || !b.g || a.g === b.g) continue;
    for (const n of [src, tgt]) {
      score.set(n, (score.get(n) || 0) + 1);
    }
  }
  return [...score.entries()]
    .map(([n, v]) => ({ n, doc: idx.docs.get(n), score: v, cited: idx.cited.get(n) || 0 }))
    .map(x => ({ ...x, value: x.score * Math.log2(2 + x.cited) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
