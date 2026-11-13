/* IETF Atlas — 「我的文稿」关系模型
 *
 * 只回答四个能在手边用上的问题：
 * 1. 我收藏的文稿之间，有没有关系？是什么关系？（直接引用）
 * 2. 它们是不是经某个共同的 RFC / 草案间接相连？（两跳桥接，比最短路径更常出现）
 * 3. 我的收藏在跨组层面依赖谁、被谁依赖？（组，才是 IETF 的知识分工单位）
 * 4. 我引用了哪些还没收进地图的文稿 / 标准？技术域是什么？
 */

export const REL_TEXT = {
  refnorm: '规范引用',
  refinfo: '信息性引用',
  updates: '更新',
  obs: '废弃',
  replaces: '替代',
  'possibly-replaces': '可能替代',
  became_rfc: '转为 RFC',
  tois: '升至 IS',
  tops: '升至 PS',
  tobcp: '转为 BCP',
  tohist: '转为 Historic',
  conflrev: '冲突评审',
};

// 只有这些关系对「文稿间的技术关联」有意义
const KEEP = new Set(['refnorm', 'refinfo', 'updates', 'obs', 'replaces', 'possibly-replaces',
  'became_rfc', 'tois', 'tops', 'tobcp', 'tohist']);

/** 被这么多文稿引用的，基本是"样板规范"（RFC 2119 / 8174 那一类），不是真正的技术依赖 */
export const BOILERPLATE = 800;

/** 显示名：draft-ietf-foo → foo；rfc2119 → RFC 2119；bcp14 → BCP 14 */
export function shortName(name, max = 0) {
  let s = String(name || '').replace(/^draft-ietf-/, '').replace(/^draft-/, '');
  let m = s.match(/^rfc0*(\d+)$/i);
  if (m) s = 'RFC ' + m[1];
  else if ((m = s.match(/^(bcp|std|fyi)0*(\d+)$/i))) s = m[1].toUpperCase() + ' ' + m[2];
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** 是否是 RFC 子系列（BCP/STD/FYI），这些条目在快照里没有单独标题 */
export function isSubseries(name) {
  return /^(bcp|std|fyi)\d+$/i.test(String(name));
}

export function relShort(rel) {
  if (rel === 'refnorm') return '规范';
  if (rel === 'refinfo') return '信息';
  return REL_TEXT[rel] || rel;
}

/* ---------- 技术域：把一堆 RFC 号变成一眼能懂的技术栈 ----------
 * 只看标题关键词。够用就好：这里的目标是"这一坨依赖到底在依赖什么技术"，
 * 不是精确分类学。一个都匹配不上就归"其他"，不会被吞掉。
 */
const DOMAINS = [
  ['YANG 数据模型', /YANG|tree diagram|data model/i],
  ['NETCONF / RESTCONF', /NETCONF|RESTCONF|call home|\bNACM\b/i],
  ['MIB / SNMP 管理', /\bMIB\b|SMIv|SNMP|management information base/i],
  ['安全与传输', /\(TLS\)|\bTLS\b|\bQUIC\b|\bIPsec\b|\bSSH\b|\bTCP\b|\bUDP\b|OAuth|HMAC|credential|authentication/i],
  ['标识与注册表', /UUID|Universally Unique|IANA|registry/i],
  ['流程与指南', /considerations|guidelines|template|naming/i],
];
export function domainOf(doc) {
  const t = (doc && doc.t) || '';
  for (const [k, re] of DOMAINS) if (re.test(t)) return k;
  return '其他';
}

/** 组的角色：从「我的收藏 → 这个组」的引用方向看知识流向 */
const ROLE_TEXT = {
  uses: '你依赖它',
  usedBy: '它依赖你',
  both: '互相依赖',
  none: '同组',
};

/**
 * @param idx  数据索引
 * @param assets 用户资产
 */
export function buildMine(idx, assets) {
  const byName = new Map();
  for (const a of assets) {
    if (a.kind !== 'doc') continue;
    const d = idx.docs.get(a.key) || (a.meta ? { ...a.meta, n: a.meta.n || a.key } : null);
    if (d) byName.set(a.key, { ...d, n: a.key, asset: a });
  }

  const pairs = new Map();          // "a|b" → 直接关系
  const outExt = new Map();         // name → [{to, rel}]
  const inbound = new Map();        // name → [{from, rel}]
  const inboundUnknown = new Map(); // name → {norm, info, other}

  // 两跳桥接：收藏A → X ← 收藏B（或 X 只连一边，另一篇经 X 反向连）
  // 同一份外部文稿被我的多篇收藏引用，就是"共同技术前提"。
  const extIn = new Map();          // X → Set(收藏名)
  const extRel = new Map();         // "c|X" → 最强关系

  for (const [s, rel, t] of idx.snap.rels) {
    if (!KEEP.has(rel) || !t) continue;
    const hasS = !!s && byName.has(s);
    const hasT = byName.has(t);
    if (hasS && hasT) {
      if (s === t) continue;
      const [a, b] = s < t ? [s, t] : [t, s];
      const key = a + '|' + b;
      let p = pairs.get(key);
      if (!p) { p = { key, a, b, count: 0, norm: 0, info: 0, other: 0, rels: new Map(), ab: 0, ba: 0 }; pairs.set(key, p); }
      p.count++;
      p.rels.set(rel, (p.rels.get(rel) || 0) + 1);
      if (rel === 'refnorm') p.norm++; else if (rel === 'refinfo') p.info++; else p.other++;
      if (s === a) p.ab++; else p.ba++;
      continue;
    }
    if (hasS && !hasT) {
      (outExt.get(s) || outExt.set(s, []).get(s)).push({ to: t, rel });
      const set = extIn.get(t) || extIn.set(t, new Set()).get(t);
      set.add(s);
      // 记住"哪篇收藏以哪种关系指向这个外部文稿"，用于展示方向
      const kk = s + '|' + t;
      const cur = extRel.get(kk);
      if (!cur || (cur !== 'refnorm' && rel === 'refnorm')) extRel.set(kk, rel);
    } else if (!hasS && hasT) {
      if (s) {
        (inbound.get(t) || inbound.set(t, []).get(t)).push({ from: s, rel });
        const set = extIn.get(s) || extIn.set(s, new Set()).get(s);
        set.add('~' + t);            // ~ 前缀表示反向：外部文稿引用了我的收藏
      } else {
        const o = inboundUnknown.get(t) || { norm: 0, info: 0, other: 0 };
        if (rel === 'refnorm') o.norm++; else if (rel === 'refinfo') o.info++; else o.other++;
        inboundUnknown.set(t, o);
      }
    }
  }

  // 关系清单排序：规范性多的、条数多的在前
  const pairList = [...pairs.values()].sort((x, y) => (y.norm * 2 + y.info) - (x.norm * 2 + x.info) || y.count - x.count);

  // 每份文稿的"直接关系"
  const relsOf = new Map();
  const push = (n, v) => (relsOf.get(n) || relsOf.set(n, []).get(n)).push(v);
  for (const p of pairList) {
    push(p.a, { other: p.b, dir: 'both', pair: p });
    push(p.b, { other: p.a, dir: 'both', pair: p });
  }

  const linked = new Set();
  for (const p of pairList) { linked.add(p.a); linked.add(p.b); }
  const isolated = [...byName.keys()].filter(n => !linked.has(n));

  // 外部引用按"规范优先 + 被引量"排序
  for (const [, arr] of outExt) {
    arr.sort((x, y) => {
      const w = r => r === 'refnorm' ? 0 : r === 'refinfo' ? 1 : 2;
      return w(x.rel) - w(y.rel) || (idx.cited.get(y.to) || 0) - (idx.cited.get(x.to) || 0);
    });
  }
  for (const [, arr] of inbound) {
    arr.sort((x, y) => (y.rel === 'refnorm' ? 1 : 0) - (x.rel === 'refnorm' ? 1 : 0));
  }

  /* ---------- 桥：被 ≥2 篇收藏共同引用（或一边引用、一边被引）的外部文稿 ---------- */
  const bridges = [];
  for (const [x, set] of extIn) {
    const mine = [...set].filter(v => !v.startsWith('~'));
    const back = [...set].filter(v => v.startsWith('~')).map(v => v.slice(1));
    const touch = new Set([...mine, ...back]);
    if (touch.size < 2) continue;
    const d = idx.docs.get(x);
    bridges.push({
      n: x,
      t: d?.t || (isSubseries(x) ? 'RFC 子系列（BCP / STD / FYI）' : '（快照外的文稿）'),
      g: d?.g || null,
      cited: idx.cited.get(x) || 0,
      domain: domainOf(d),
      boiler: (idx.cited.get(x) || 0) >= BOILERPLATE,
      users: mine.map(c => ({ c, rel: extRel.get(c + '|' + x) || 'refnorm' })),
      sources: back,               // 反过来引用我收藏的外部文稿
      label: mine.length > 1 ? '共被 ' + mine.length + ' 篇收藏引用' : '连接 ' + touch.size + ' 篇收藏',
    });
  }
  // 打分：共被引越多越靠前；样板规范降权（RFC 2119 谁都在用，说明不了关联）
  const bScore = b => (b.users.length * 3 + b.sources.length) / (b.boiler ? 12 : 1) + Math.log2(2 + b.cited) * 0.15;
  bridges.sort((a, b) => bScore(b) - bScore(a));

  /* ---------- 组层面：跨组依赖 ---------- */
  const mineGroups = new Set([...byName.values()].map(d => d.g || '—'));
  const gUse = new Map();    // 组 → {acr, use, usedBy, useNorm, usedByNorm, samples}
  const touchG = acr => {
    if (!gUse.has(acr)) gUse.set(acr, { acr, use: 0, usedBy: 0, useNorm: 0, usedByNorm: 0, samples: [] });
    return gUse.get(acr);
  };
  const domOf = new Map();   // 组 → Map(domain → count)，靠它说清"依赖的是什么技术"
  for (const [s, rel, t] of idx.snap.rels) {
    if (rel !== 'refnorm' && rel !== 'refinfo') continue;
    if (!s || !t) continue;
    const a = idx.docs.get(s), b = idx.docs.get(t);
    if (!a || !b || !a.g || !b.g || a.g === b.g) continue;
    const sMine = byName.has(s), tMine = byName.has(t);
    if (sMine === tMine) continue;          // 两边都在 / 都不在收藏里，不是"我的"跨组关系
    const other = sMine ? b.g : a.g;
    if (mineGroups.has(other)) continue;    // 另一个组也是我收藏的，属于"收藏之间"，另行处理
    const g = touchG(other);
    const dir = sMine ? 'use' : 'usedBy';
    if (dir === 'use') { g.use++; if (rel === 'refnorm') g.useNorm++; }
    else { g.usedBy++; if (rel === 'refnorm') g.usedByNorm++; }
    if (g.samples.length < 6) g.samples.push({ from: s, to: t, rel, dir, mine: sMine ? s : t });
    // 技术域统计
    let dm = domOf.get(other);
    if (!dm) { dm = new Map(); domOf.set(other, dm); }
    const dom = domainOf(idx.docs.get(sMine ? t : s));
    dm.set(dom, (dm.get(dom) || 0) + 1);
  }
  const groupsRel = [...gUse.values()].map(g => {
    const role = g.use && g.usedBy ? 'both' : g.use ? 'uses' : 'usedBy';
    const dm = [...(domOf.get(g.acr) || new Map())].sort((a, b) => b[1] - a[1]);
    return {
      ...g, role, roleText: ROLE_TEXT[role],
      total: g.use + g.usedBy,
      name: idx.groups.get(g.acr)?.name || '',
      state: idx.groups.get(g.acr)?.state || '',
      domains: dm.slice(0, 2),
      topDomain: dm[0]?.[0] || '其他',
    };
  }).sort((a, b) => (b.useNorm * 2 + b.use) - (a.useNorm * 2 + a.use) || b.total - a.total);

  /* ---------- 我的收藏引用了哪些外部文稿（缺口候选） ---------- */
  const extUnique = new Map();   // name → {n, t, g, cited, domain, users:[..]}
  for (const [c, arr] of outExt) {
    for (const e of arr) {
      let o = extUnique.get(e.to);
      if (!o) {
        const d = idx.docs.get(e.to);
        o = { n: e.to, t: d?.t || '', g: d?.g || null, cited: idx.cited.get(e.to) || 0,
              domain: domainOf(d), boiler: (idx.cited.get(e.to) || 0) >= BOILERPLATE, users: [] };
        extUnique.set(e.to, o);
      }
      if (!o.users.includes(c)) o.users.push(c);
    }
  }

  const docs = [...byName.values()].sort((a, b) => (idx.cited.get(b.n) || 0) - (idx.cited.get(a.n) || 0));
  const groupSet = new Set(docs.map(d => d.g || '—'));
  let extTotal = 0, extNorm = 0;
  for (const arr of outExt.values()) for (const e of arr) { extTotal++; if (e.rel === 'refnorm') extNorm++; }

  // 外部依赖的技术域分布（用于一句话结论）
  const extDomains = [...extUnique.values()]
    .filter(x => !x.boiler)
    .reduce((m, x) => { m.set(x.domain, (m.get(x.domain) || 0) + 1); return m; }, new Map());

  return {
    docs, byName, pairs: pairList, pairsOf: pairs,
    relsOf, outExt, inbound, inboundUnknown, isolated,
    bridges: bridges.slice(0, 40),
    groupsRel: groupsRel.slice(0, 30),
    extUnique,
    extDomains: [...extDomains].sort((a, b) => b[1] - a[1]),
    groups: [...groupSet],
    stats: {
      docs: docs.length,
      groups: groupSet.size,
      pairs: pairList.length,
      isolated: isolated.length,
      extTotal, extNorm,
      extDocs: extUnique.size,
      bridges: bridges.filter(b => !b.boiler && b.users.length >= 2).length,
      unknownInbound: [...inboundUnknown.values()].reduce((s, o) => s + o.norm + o.info + o.other, 0),
    },
  };
}

/** 一句话总结我的收藏关系（首页顶部那块最重要的信息） */
export function mineVerdict(m) {
  const s = m.stats;
  if (!s.docs) return '还没有收藏任何文稿。';
  if (s.docs === 1) return '只有 1 份文稿，还看不出关系。再收一份，才能判断它们是否相关。';

  // 只说"依赖最重的两个组"，并带上它们 predominately 的技术域——比罗列一串缩写有用
  const top = m.groupsRel.filter(g => g.role !== 'none' && (g.use || g.usedBy)).slice(0, 2);
  const who = top.length
    ? '；按引用方向看，主要依赖 <b>' +
      top.map(g => escInline(g.acr) + '（' + escInline(g.topDomain) + '）').join('</b>、<b>') + '</b>'
    : '';
  if (!s.pairs) {
    const br = s.bridges;
    return `${s.docs} 份文稿之间<b>没有直接引用</b>${br ? `，但有 <b>${br}</b> 处共同引用的文稿把它们间接连在一起` : ''}${who}。`;
  }
  const strong = m.pairs.filter(p => p.norm > 0).length;
  const tail = s.isolated ? `，另有 <b>${s.isolated}</b> 份与其他收藏没有任何关系` : '';
  return `${s.docs} 份文稿里有 <b>${s.pairs}</b> 对存在直接引用（<b>${strong}</b> 对是规范性依赖）${tail}${who}。`;
}

/** 供标题里拼 HTML 的最小转义（避免循环依赖 db.js） */
function escInline(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
