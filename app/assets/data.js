/* IETF Atlas — 数据层：快照加载、索引、缺口计算 */
import { db } from './db.js';

const SNAP = './data/snapshot.json';
let _snap = null;
let _index = null;

export async function loadSnapshot() {
  if (_snap) return _snap;
  const cached = await db.get('settings', 'snapshot-cache');
  let snap = null;
  try {
    const r = await fetch(SNAP, { cache: 'no-cache' });
    if (r.ok) snap = await r.json();
  } catch (e) { /* offline */ }
  if (!snap && cached?.data) snap = cached.data;
  if (!snap) throw new Error('无法加载数据快照（离线且无缓存）');
  _snap = snap;
  return snap;
}

export async function index() {
  if (_index) return _index;
  const s = await loadSnapshot();
  const G = (r) => ({ id: r[0], acr: r[1], name: r[2], type: r[3], state: r[4], parent: r[5], desc: r[6], list: r[7] });
  const D = (r) => ({ n: r[0], t: r[1], ty: r[2], g: r[3], rfc: r[4], rev: r[5],
    st: r[6] ? r[6].split('|') : [], lev: r[7], stream: r[8], time: r[9], ab: r[10],
    kw: r[11] ? r[11].split('|') : [] });
  s.groups = s.groups.map(G);
  s.docs = s.docs.map(D);
  // 关系表是池化压缩的 [srcIdx, relIdx, tgtIdx]，这里还原成名字
  if (s.namePool && s.relTypes) {
    const POOL = s.namePool, REL = s.relTypes;
    s.rels = s.rels.map(([a, b, c]) => [a < 0 ? null : POOL[a], REL[b], c < 0 ? null : POOL[c]]);
    s.namePool = null; s.relTypes = null;
  }
  const groups = new Map();
  for (const g of s.groups) groups.set(g.acr, { ...g, docs: [] });
  const docs = new Map();
  for (const d of s.docs) docs.set(d.n, d);
  // 归属
  for (const d of s.docs) {
    if (d.g && groups.has(d.g)) groups.get(d.g).docs.push(d.n);
  }
  // 引用计数（枢纽度）
  const cited = new Map();
  const relOf = new Map();
  for (const [src, rel, tgt] of s.rels) {
    if (tgt) cited.set(tgt, (cited.get(tgt) || 0) + 1);
    if (src) {
      if (!relOf.has(src)) relOf.set(src, []);
      relOf.get(src).push([rel, tgt]);
    }
    if (tgt && src) {
      if (!relOf.has(tgt)) relOf.set(tgt, []);
      relOf.get(tgt).push(['cited-by:' + rel, src]);
    }
  }
  // Area 映射（parent 指向 area 组）
  const areaOf = new Map();
  for (const g of groups.values()) {
    let p = g.parent ? s.groups.find(x => x.id === g.parent) : null;
    areaOf.set(g.acr, p ? p.acr : null);
  }
  _index = { snap: s, groups, docs, cited, relOf, areaOf, areas: s.groups.filter(g => g.type === 'area') };
  return _index;
}

export const DOC_URL = n => `https://datatracker.ietf.org/doc/${n}/`;
export const GROUP_URL = a => `https://datatracker.ietf.org/group/${a}/about/`;

/**
 * 官方正文文件地址（不经 Datatracker 那套 400KB 的页面壳）。
 * RFC 在 rfc-editor.org，草案在 ietf.org/archive/id；fmt 取 txt / html。
 */
export const DOC_FILE_URL = (n, fmt = 'txt', ver = '') => {
  const name = String(n).trim().toLowerCase();
  if (/^rfc\d{1,5}$/.test(name)) return `https://www.rfc-editor.org/rfc/${name}.${fmt}`;
  if (/^draft-/.test(name)) return `https://www.ietf.org/archive/id/${name}${ver ? '-' + ver : ''}.${fmt}`;
  return DOC_URL(name);   // BCP / STD / FYI 是多份 RFC 的合集，回官方文档页
};

export function statusOf(d) {
  const st = (d.st || []).join(' ').toLowerCase();
  if (d.rfc || d.ty === 'rfc' || /^rfc\d+$/.test(d.n)) {
    if (d.lev === 'ps') return { k: 'std', label: 'Proposed Standard', cls: 'blue' };
    if (d.lev === 'is') return { k: 'std', label: 'Internet Standard', cls: 'blue' };
    if (d.lev === 'bcp') return { k: 'std', label: 'BCP', cls: 'blue' };
    if (d.lev === 'exp') return { k: 'exp', label: 'Experimental', cls: 'yellow' };
    if (d.lev === 'inf') return { k: 'info', label: 'Informational', cls: '' };
    if (d.lev === 'hist') return { k: 'hist', label: 'Historic', cls: 'yellow' };
    return { k: 'rfc', label: 'RFC', cls: 'blue' };
  }
  if (st.includes('expired')) return { k: 'expired', label: '已过期', cls: 'red' };
  if (st.includes('dead') || st.includes('withdrawn')) return { k: 'dead', label: '已废弃', cls: 'red' };
  if (st.includes('rfc edits') || st.includes('approved')) return { k: 'approved', label: '已通过', cls: 'green' };
  if (st.includes('last call')) return { k: 'lastcall', label: '最后呼叫', cls: 'purple' };
  if (st.includes('adopted') || st.includes('active') || st.includes('candidate')) return { k: 'active', label: '草案进行中', cls: 'green' };
  if (st.includes('replaced')) return { k: 'replaced', label: '已被替代', cls: 'red' };
  return { k: 'draft', label: '草案', cls: '' };
}

export function isAlive(d) {
  const k = statusOf(d).k;
  return !['expired', 'dead', 'replaced', 'hist'].includes(k);
}

/* ---------- 用户资产 ---------- */
export async function getAssets() {
  return db.all('assets');
}
export async function saveAsset(a) {
  return db.put('assets', a);
}
export async function removeAsset(id) {
  return db.del('assets', id);
}

export function normName(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?(datatracker\.ietf\.org|www\.ietf\.org|datatracker\.ietf\.org\/doc)\//i, '');
  s = s.replace(/^\/?doc\//, '');
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');
  s = s.replace(/\.(html|txt|pdf|json)$/i, '');
  s = s.replace(/-(\d\d)$/, '');
  s = s.replace(/^rfc[\s_-]?0*(\d+)$/i, (m, n) => 'rfc' + parseInt(n, 10));
  return s.toLowerCase();
}

export function resolveTarget(input, idx) {
  const key = normName(input);
  if (!key) return null;
  if (idx.docs.has(key)) {
    const d = idx.docs.get(key);
    return { kind: 'doc', key, doc: d };
  }
  if (idx.groups.has(key)) {
    return { kind: 'group', key, group: idx.groups.get(key) };
  }
  // 用户会照着界面上的短名输入：「green-terminology」对应 draft-ietf-green-terminology。
  // 去掉 draft-/ietf- 前缀后唯一命中才算，免得把 bclp-green-terminology 也认成同一个
  if (!key.startsWith('draft-')) {
    const tailOf = n => n.replace(/^draft-/, '').replace(/^ietf-/, '');
    const hits = [];
    for (const d of idx.docs.values()) if (tailOf(d.n) === key) hits.push(d);
    if (hits.length === 1) return { kind: 'doc', key: hits[0].n, doc: hits[0] };
    if (hits.length > 1) {
      const exact = hits.find(d => d.n === 'draft-ietf-' + key);
      if (exact) return { kind: 'doc', key: exact.n, doc: exact };
    }
  }
  // rfc 数字
  const m = key.match(/^rfc0*(\d+)$/);
  if (m) {
    const rfc = 'rfc' + m[1];
    for (const d of idx.docs.values()) if (d.rfc && 'rfc' + d.rfc === rfc && d.n === rfc) return { kind: 'doc', key: d.n, doc: d };
  }
  return null;
}

/* ---------- 实时回源（快照未命中时向 Datatracker 精确查询单条） ---------- */
// 同源代理优先（浏览器直连 datatracker 会被 CORS 拦截），回退到直连（若将来放开）
const API_SAME = '/api/live';
const API_DIRECT = 'https://datatracker.ietf.org/api/v1';
const LIVE_TTL = 1000 * 60 * 60 * 24; // 24h 内的实时结果不重复请求
const _liveCache = new Map();

function stSlugs(raw) {
  return (raw || []).map(u => String(u).replace(/\/$/, '').split('/').pop());
}

function buildDoc(o, idx) {
  // group 在 API 里是组 ID，转成本地 acronym
  let g = null;
  const gid = o.group ? Number(String(o.group).replace(/\/$/, '').split('/').pop()) : null;
  if (gid) {
    for (const grp of idx.groups.values()) if (grp.id === gid) { g = grp.acr; break; }
  }
  return {
    n: o.name,
    t: o.title,
    ty: String(o.type || '').replace(/\/$/, '').split('/').pop(),
    g,
    rfc: o.rfc_number,
    rev: o.rev || '00',
    st: stSlugs(o.states),
    lev: o.std_level ? String(o.std_level).replace(/\/$/, '').split('/').pop() : null,
    stream: o.stream ? String(o.stream).replace(/\/$/, '').split('/').pop() : null,
    time: (o.time || '').slice(0, 10),
    ab: (o.abstract || '').slice(0, 600),
    kw: [],
    live: true,
    fetched: Date.now(),
  };
}

export async function queryLiveDoc(name, idx) {
  const key = normName(name);
  if (!key || !key.startsWith('draft-')) return null;
  const hit = _liveCache.get(key);
  if (hit && Date.now() - hit.ts < LIVE_TTL) return hit.doc;
  try {
    const o = await apiGet(`${API_SAME}/doc/${encodeURIComponent(key)}`)
           ?? await apiGet(`${API_DIRECT}/doc/document/${encodeURIComponent(key)}/?format=json`);
    if (!o) return null;
    if (!o || !o.name) return null;
    const d = buildDoc(o, idx);
    idx.docs.set(d.n, d);          // 注入本次会话索引，图谱/详情立即可用
    if (d.g && idx.groups.has(d.g)) {
      const grp = idx.groups.get(d.g);
      if (!grp.docs) grp.docs = [];
      if (!grp.docs.includes(d.n)) grp.docs.push(d.n);
    }
    _liveCache.set(key, { ts: Date.now(), doc: d });
    return d;
  } catch (e) {
    return null;                    // 离线或跨域失败
  }
}

export async function queryLiveGroup(acr, idx) {
  try {
    const o = await apiGet(`${API_SAME}/group/${encodeURIComponent(acr)}`)
           ?? await apiGet(`${API_DIRECT}/group/group/${encodeURIComponent(acr)}/?format=json`);
    if (!o) return null;
    const g = {
      id: o.id, acr: o.acronym, name: o.name,
      type: String(o.type || '').replace(/\/$/, '').split('/').pop(),
      state: String(o.state || '').replace(/\/$/, '').split('/').pop(),
      parent: o.parent ? Number(String(o.parent).replace(/\/$/, '').split('/').pop()) : null,
      desc: o.description || '', docs: [], live: true
    };
    idx.groups.set(g.acr, g);
    return g;
  } catch (e) { return null; }
}

/** 统一取 JSON：失败/非 2xx 返回 null，不抛错 */
async function apiGet(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.name ? j : null;
  } catch (e) { return null; }
}

/** 先查本地快照，未命中再实时回源。返回 { result, source } */
export async function resolveTargetDeep(input, idx) {
  const local = resolveTarget(input, idx);
  if (local) return { result: local, source: 'snapshot' };
  const key = normName(input);
  if (!key) return { result: null, source: 'none' };
  if (key.startsWith('draft-')) {
    const d = await queryLiveDoc(key, idx);
    if (d) return { result: { kind: 'doc', key: d.n, doc: d }, source: 'live' };
  }
  const g = await queryLiveGroup(key, idx);
  if (g) return { result: { kind: 'group', key: g.acr, group: g }, source: 'live' };
  return { result: null, source: 'none' };
}

/** 收藏时把元数据快照一并存下，避免下次刷新后无元数据可显示 */
export function assetFromDoc(d) {
  return {
    id: 'd:' + d.n, key: d.n, kind: 'doc', group: d.g, added: Date.now(),
    meta: { n: d.n, t: d.t, g: d.g, ty: d.ty, rfc: d.rfc, rev: d.rev, st: d.st,
            lev: d.lev, time: d.time, ab: d.ab, live: !!d.live }
  };
}

/* ---------- 缺口计算 ---------- */
export function computeGaps(idx, assets) {
  const owned = new Set(assets.filter(a => a.kind === 'doc').map(a => a.key));
  const ownedGroups = new Set(assets.filter(a => a.kind === 'group').map(a => a.key));
  // 组 = 显式收藏 ∪ 所收文稿的归属组
  const touched = new Set(ownedGroups);
  for (const n of owned) {
    const d = idx.docs.get(n);
    if (d?.g) touched.add(d.g);
  }
  const out = { orphans: [], hollow: [], dangling: [], blindspots: [], stale: [], coverage: null, recommend: [] };

  // 1 孤儿草案：关注组内、未被收藏、活跃且指数被引靠前
  for (const g of touched) {
    const grp = idx.groups.get(g);
    if (!grp) continue;
    for (const n of grp.docs) {
      if (owned.has(n)) continue;
      const d = idx.docs.get(n);
      if (!d || !isAlive(d)) continue;
      const c = idx.cited.get(n) || 0;
      if (c >= 3) out.orphans.push({ g, n, cited: c, doc: d });
    }
  }
  out.orphans.sort((a, b) => b.cited - a.cited);
  out.orphans = out.orphans.slice(0, 200);

  // 2 空心组：收藏了组但组内 0 收藏；或只靠文稿间接带出的组
  for (const g of touched) {
    const grp = idx.groups.get(g);
    if (!grp) continue;
    const cnt = grp.docs.filter(n => owned.has(n)).length;
    if (cnt === 0) out.hollow.push({ g, docs: grp.docs.length, explicit: ownedGroups.has(g) });
  }
  out.hollow.sort((a, b) => b.docs - a.docs);

  // 3 断链：已收藏文稿的规范性引用目标不在收藏
  const seen = new Set();
  for (const n of owned) {
    for (const [rel, tgt] of (idx.relOf.get(n) || [])) {
      if (rel !== 'refnorm') continue;
      if (owned.has(tgt) || seen.has(tgt)) continue;
      if (!idx.docs.has(tgt)) continue;
      seen.add(tgt);
      out.dangling.push({ from: n, to: tgt, cited: idx.cited.get(tgt) || 0 });
    }
  }
  out.dangling.sort((a, b) => b.cited - a.cited);
  out.dangling = out.dangling.slice(0, 300);

  // 4 盲区：我有关注的 Area 内、完全未触及的兄弟组
  const areasTouched = new Map();
  for (const g of touched) {
    const a = idx.areaOf.get(g);
    if (a) areasTouched.set(a, (areasTouched.get(a) || 0) + 1);
  }
  for (const [area, cnt] of areasTouched) {
    if (cnt < 2) continue;
    const siblings = [...idx.groups.values()].filter(g => idx.areaOf.get(g.acr) === area && g.type === 'wg');
    const untouched = siblings.filter(g => !touched.has(g.acr));
    out.blindspots.push({ area, touched: cnt, total: siblings.length, untouched: untouched.length, sample: untouched.slice(0, 8).map(g => g.acr) });
  }
  out.blindspots.sort((a, b) => a.touched / a.total - b.touched / b.total);

  // 5 过时风险
  for (const n of owned) {
    const d = idx.docs.get(n);
    if (!d) continue;
    const st = statusOf(d);
    const replaced = (idx.relOf.get(n) || []).filter(([r]) => r === 'cited-by:obs' || r === 'cited-by:replaces');
    if (['expired', 'replaced', 'dead'].includes(st.k) || replaced.length) {
      out.stale.push({ n, doc: d, status: st, replacedBy: replaced.map(r => r[1]) });
    }
  }

  // 覆盖度评分（0-100）
  if (assets.length) {
    const gScore = Math.min(1, touched.size / 8) * 25;                       // 组广度
    const dScore = Math.min(1, owned.size / 25) * 25;                        // 资产深度
    const linksTotal = [...owned].reduce((s, n) => s + (idx.relOf.get(n) || []).length, 0) || 1;
    const lScore = Math.max(0, 1 - out.dangling.length / linksTotal) * 25;   // 引用完整度
    const hScore = Math.max(0, 1 - out.stale.length / Math.max(1, owned.size)) * 25; // 新鲜度
    out.coverage = Math.round(gScore + dScore + lScore + hScore);
    out.coverageParts = { 组广度: Math.round(gScore), 资产深度: Math.round(dScore), 引用完整度: Math.round(lScore), 新鲜度: Math.round(hScore) };
  }

  // 推荐：同组高分未收藏 + 共享引用邻居
  const shared = new Map();
  for (const n of owned) {
    for (const [rel, tgt] of (idx.relOf.get(n) || [])) {
      if (!rel.startsWith('cited-by:')) continue;
      if (owned.has(tgt)) continue;
      if (!idx.docs.has(tgt)) continue;
      shared.set(tgt, (shared.get(tgt) || 0) + 1);
    }
  }
  const rec = [];
  for (const [n, v] of shared) {
    const d = idx.docs.get(n);
    if (!d || !isAlive(d)) continue;
    rec.push({ n, reason: `被 ${v} 份你收藏的文稿引用`, score: v * 3 + (idx.cited.get(n) || 0) / 10, doc: d });
  }
  for (let i = 0; i < Math.min(80, out.orphans.length); i++) {
    const o = out.orphans[i];
    rec.push({ n: o.n, reason: `${o.g} 组内高被引（${o.cited} 次）`, score: o.cited + 1, doc: o.doc });
  }
  const dedup = new Map();
  for (const r of rec) if (!dedup.has(r.n) || dedup.get(r.n).score < r.score) dedup.set(r.n, r);
  out.recommend = [...dedup.values()].sort((a, b) => b.score - a.score).slice(0, 40);
  return out;
}
