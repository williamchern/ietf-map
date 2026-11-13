/* IETF Atlas — 离线文稿
 *
 * 把 IETF 官方正文（rfc-editor.org / ietf.org/archive）按版本存进本机 IndexedDB，
 * 断网也能在应用里直接读；不引入任何第三方来源，也不改正文。
 *
 * 只有一个入口 openDocDialog：收藏库里点文稿名（或「管理」）就到这里。
 *   ① 选版本：草案 00..最新，RFC 一版
 *   ② 三个动作：下载到本机 / 在线看一次（不占空间）/ 读本机副本
 *   ③ 删除：单份、整篇，都只动本机，不动收藏
 */
import { esc, toast, log, db, fmtDate } from './db.js';
import { index, DOC_URL } from './data.js';
import { shortName } from './mine.js';

export const fmtKB = n => (n >= 1024 * 1024
  ? (n / 1024 / 1024).toFixed(1) + ' MB'
  : Math.max(1, Math.round(n / 1024)) + ' KB');

export const offlineRecId = (doc, ver) => `${doc}@${ver || 'base'}`;

/* ---------- 存储 ---------- */

export async function offlineList() {
  return db.all('offline');
}

/** 列表/统计只需要元数据：把正文从对象上摘掉，别让几十份 400KB 的字符串常驻内存 */
const stripText = rows => { for (const r of rows) delete r.text; return rows; };

/** doc → [记录…]，列表渲染时一次取完，避免每行查库 */
export async function offlineMap() {
  const rows = stripText(await offlineList());
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.doc)) m.set(r.doc, []);
    m.get(r.doc).push(r);
  }
  return m;
}

export async function offlineGet(doc, ver) {
  return db.get('offline', offlineRecId(doc, ver));
}

export async function offlineRemove(id) {
  const rec = await db.get('offline', id);
  await db.del('offline', id);
  if (rec) await log('offline-remove', rec.label || id);
  return rec;
}

export async function offlineTotal() {
  const rows = stripText(await offlineList());
  return { count: rows.length, bytes: rows.reduce((n, r) => n + (r.bytes || 0), 0) };
}

/* ---------- 版本 ---------- */

const isRfc = n => /^rfc\d{1,5}$/i.test(n);
const isDraft = n => /^draft-/i.test(n);

/** 版本号要问一次 Datatracker；同一篇在同一会话里只问一次 */
const VER_CACHE = new Map();

/**
 * 列出版本。草案按最新 rev 往下数到 00（archive 里每一版都有文件名），
 * RFC 只有一版；BCP/STD/FYI 是子系列（由多份 RFC 组成），不提供单文件下载。
 */
export async function docVersions(name) {
  if (VER_CACHE.has(name)) return VER_CACHE.get(name);
  const out = await computeVersions(name);
  VER_CACHE.set(name, out);
  return out;
}

/** 用已知 rev 直接造版本表——不联网，用本地快照也能先把列表放出来 */
export function buildVersions(name, rev) {
  if (isRfc(name)) {
    // RFC 9000 这种写法比 RFC9000 好读
    return [{ ver: '', label: name.replace(/^rfc/i, 'RFC '), latest: true, note: '正式发布版' }];
  }
  if (!isDraft(name)) return [];
  const n = parseInt(rev, 10);
  if (!rev || Number.isNaN(n)) return [];
  const out = [];
  for (let i = n; i >= 0; i--) {
    const v = String(i).padStart(2, '0');
    out.push({ ver: v, label: `${name}-${v}`, latest: i === n });
  }
  return out;
}

async function computeVersions(name) {
  if (isRfc(name)) return buildVersions(name, '');
  if (!isDraft(name)) return [];

  let rev = '';
  try {
    const r = await fetch(`/api/docmeta/${encodeURIComponent(name)}`);
    if (r.ok) rev = (await r.json()).rev || '';
  } catch { /* 离线时退回本地快照里的 rev */ }
  if (!rev) {
    try {
      const idx = await index();
      rev = idx.docs.get(name)?.rev || '';
    } catch { /* 快照也读不到就算了 */ }
  }
  const out = buildVersions(name, rev);
  if (out.length) return out;
  return [{ ver: '', label: name, latest: true, note: '版本未知' }];
}

/* ---------- 取正文 ---------- */

export async function fetchDocText(name, ver) {
  const q = new URLSearchParams({ name, fmt: 'txt' });
  if (ver) q.set('ver', ver);
  let r;
  try {
    r = await fetch(`/api/docfile?${q.toString()}`);
  } catch {
    throw new Error('网络连不上，可能需要先联网');
  }
  if (!r.ok) {
    if (r.status === 404) throw new Error('官方存档里没有这一版');
    if (r.status === 413) throw new Error('文件太大（超过 12MB）');
    if (r.status === 400) throw new Error('这个名字/版本号不被支持');
    throw new Error(`下载失败（HTTP ${r.status}）`);
  }
  const text = await r.text();
  if (!text || text.length < 200) throw new Error('拿到的内容不完整，稍后再试');
  return text;
}

export async function saveOfflineDoc({ doc, ver, label, title, text }) {
  const rec = {
    id: offlineRecId(doc, ver),
    doc,
    ver: ver || '',
    label: label || doc,
    title: title || '',
    bytes: new Blob([text]).size,
    ts: Date.now(),
    text,
  };
  await db.put('offline', rec);
  await log('offline-save', `${rec.label} · ${fmtKB(rec.bytes)}`);
  return rec;
}

/* ---------- 版本 / 离线管理面板 ---------- */

/**
 * 点文稿名或「管理」都到这里：一屏里看清"哪些版本在本机、哪些没有"，
 * 每个版本三种去向——下载、在线看、直接读。
 * mode = 'open'（从名字进来，默认选已存的最新版）| 'manage'（从「管理」进来，多一个移除收藏）
 */
export async function openDocDialog(docName, { onChange, mode = 'open', onRemove } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'doc-dlg';
  dlg.innerHTML = `<div class="dlg-head"><span class="mono ell" title="${esc(docName)}">${esc(docName)}</span>
      <span class="spacer"></span><button class="btn sm" data-x title="关闭">×</button></div>
    <div class="dlg-body"><p class="hint">正在查版本…</p></div>
    <div class="dlg-foot" hidden></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const body = dlg.querySelector('.dlg-body');
  const foot = dlg.querySelector('.dlg-foot');
  let closed = false;
  const close = () => { closed = true; dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-x]').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.addEventListener('cancel', () => { closed = true; dlg.remove(); });

  // 先用本地快照里的 rev 立刻把版本表放出来，再去问 Datatracker 核一次最新版。
  // 网络慢的时候，等接口只会让对话框停在"正在查版本…"。
  let idx = null;
  try { idx = await index(); } catch { /* 快照没加载也能下载 */ }
  const snap = idx ? buildVersions(docName, idx.docs.get(docName)?.rev || '') : [];
  const provisional = snap.length > 0;
  let vers = [];
  try { vers = provisional ? snap : await docVersions(docName); } catch { vers = []; }

  let title = idx?.docs.get(docName)?.t || '';

  // BCP / STD / FYI：没有单一正文文件
  if (!vers.length) {
    body.innerHTML = `<p style="margin-top:0">BCP / STD / FYI 是由多份 RFC 组成的子系列，没有单一正文可以下载。</p>
      <p class="hint">想读的话，去 Datatracker 逐份看。</p>`;
    foot.hidden = false;
    foot.innerHTML = `<a class="btn sm" href="${DOC_URL(docName)}" target="_blank" rel="noopener">Datatracker ↗</a>
      <span class="spacer"></span><button class="btn" data-x2>关闭</button>`;
    foot.querySelector('[data-x2]').addEventListener('click', close);
    return;
  }

  const saved = new Map(((await offlineMap()).get(docName) || []).map(r => [r.ver, r]));
  // 默认选中：本机已存的最新一版——从名字点进来，多半是为了接着读
  let current = vers.find(v => saved.has(v.ver)) || vers[0];
  let expanded = false;
  let busy = false;
  let msg = '';

  const byBytes = () => [...saved.values()].reduce((n, r) => n + (r.bytes || 0), 0);
  // 版本多的草案（20 版以上）默认只露最近几版，已存的版本永远露出来；手机上再少两行，别把对话框撑满
  const COLLAPSED = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches ? 5 : 8;
  const rows = () => (expanded ? vers : vers.filter((v, i) => i < COLLAPSED || saved.has(v.ver)));

  const rowHtml = v => {
    const have = saved.get(v.ver);
    // 标题栏已经写着是这一篇了，版本行只留 `-34` 这种后缀，窄屏也不会被截成半截
    const tag = v.ver ? '-' + v.ver : v.label;
    return `<label class="ver-row${v.ver === current.ver ? ' on' : ''}" data-ver="${esc(v.ver)}">
      <input type="radio" name="dl-ver" value="${esc(v.ver)}" ${v.ver === current.ver ? 'checked' : ''}>
      <span class="mono">${esc(tag)}</span>
      ${v.latest ? '<span class="label blue">最新</span>' : ''}
      ${v.note ? `<span class="hint">${esc(v.note)}</span>` : ''}
      <span class="spacer"></span>
      ${have
        ? `<span class="label green" title="${fmtDate(have.ts)} 保存">已存 ${fmtKB(have.bytes)}</span>`
        : '<span class="hint nowrap">未下载</span>'}
    </label>`;
  };

  const footHtml = () => {
    const have = saved.get(current.ver);
    return `<div class="foot-left">
        ${mode === 'manage' && onRemove ? '<button class="btn sm danger" data-rmdoc>移除收藏</button>' : ''}
        <a class="dlg-link" href="${DOC_URL(docName)}" target="_blank" rel="noopener" title="官方文档页：元数据、历史版本、邮件列表">Datatracker ↗</a>
      </div>
      <div class="foot-right">
        <button class="btn" data-x2>关闭</button>
        ${have
          ? '<button class="btn" data-rm>删除本机</button><button class="btn primary" data-read>开始阅读</button>'
          : '<button class="btn" data-live title="现在就读，不占本机空间，需要联网">在线看</button><button class="btn primary" data-dl>下载到本机</button>'}
      </div>`;
  };

  const goRead = live => {
    close();
    location.hash = `/read?doc=${encodeURIComponent(docName)}&ver=${encodeURIComponent(current.ver)}${live ? '&live=1' : ''}`;
  };

  const download = async () => {
    if (busy) return;
    busy = true;
    msg = '正在下载…';
    render();
    try {
      const text = await fetchDocText(docName, current.ver);
      const rec = await saveOfflineDoc({ doc: docName, ver: current.ver, label: current.label, title, text });
      saved.set(rec.ver, rec);
      msg = `已存到本机：${rec.label}（${fmtKB(rec.bytes)}），断网也能读。`;
      toast('已存到本机 ' + rec.label);
      onChange?.();
    } catch (e) {
      msg = e.message;
    } finally {
      busy = false;
      render();
    }
  };

  const removeOne = async () => {
    const rec = saved.get(current.ver);
    if (!rec) return;
    if (!confirm(`删除本机的「${rec.label}」？\n\n只删这份离线副本，收藏本身不受影响。`)) return;
    await offlineRemove(rec.id);
    saved.delete(current.ver);
    msg = `已删除本机副本：${rec.label}`;
    toast('已删除本机副本');
    onChange?.();
    render();
  };

  function wire() {
    body.querySelectorAll('.ver-row').forEach(row => row.addEventListener('click', () => {
      const v = vers.find(x => x.ver === row.dataset.ver);
      if (!v || v.ver === current.ver) return;
      current = v;
      msg = '';
      render();
    }));
    body.querySelector('[data-more]')?.addEventListener('click', () => { expanded = !expanded; render(); });

    foot.querySelector('[data-x2]')?.addEventListener('click', close);
    foot.querySelector('[data-rmdoc]')?.addEventListener('click', () => { close(); onRemove?.(); });
    foot.querySelector('[data-dl]')?.addEventListener('click', download);
    foot.querySelector('[data-live]')?.addEventListener('click', () => goRead(true));
    foot.querySelector('[data-read]')?.addEventListener('click', () => goRead(false));
    foot.querySelector('[data-rm]')?.addEventListener('click', removeOne);
  }

  function render() {
    body.innerHTML = `
      ${title ? `<p class="doc-title ell" title="${esc(title)}">${esc(title)}</p>` : ''}
      <p class="hint" style="margin:0 0 10px">${mode === 'manage'
        ? '这一篇的离线副本都在这里：已存的能读、能删，没存的能下载。'
        : '选一个版本：下载到本机就能断网读；只想现在看，就选「在线看」。'}</p>
      <div class="dlg-label">版本 ${vers.length > 1 ? `<span class="hint">共 ${vers.length} 个</span>` : ''}
        <span class="spacer"></span>
        <span class="hint">${saved.size ? `本机 ${saved.size} 个 · ${fmtKB(byBytes())}` : '本机还没有'}</span></div>
      <div class="ver-list" role="radiogroup">${rows().map(rowHtml).join('')}</div>
      ${vers.length > COLLAPSED ? `<button class="ver-more" data-more>${expanded ? '只看最近几版' : `显示全部 ${vers.length} 个版本`}</button>` : ''}
      <p class="dlg-msg">${esc(msg)}</p>`;
    foot.hidden = false;
    foot.innerHTML = footHtml();
    wire();
  }

  render();
  // 版本多时选中行可能在滚动区外，先把它露出来
  body.querySelector('.ver-row.on')?.scrollIntoView({ block: 'nearest' });

  // 后台核一次：本地快照的 rev 可能落后，真出了新版就补进列表（用户已选的版本不跳走）
  if (provisional) {
    docVersions(docName).then(fresh => {
      if (closed || !fresh.length) return;
      if (fresh.length === vers.length && fresh[0].ver === vers[0].ver) return;
      const keep = current?.ver;
      vers = fresh;
      current = vers.find(v => v.ver === keep) || vers.find(v => saved.has(v.ver)) || vers[0];
      render();
    }).catch(() => { /* 核不到就继续用快照那份 */ });
  }
}

/* ---------- 删除前询问 ---------- */

/** 删收藏时用：返回 'keep'（只删收藏）/ 'purge'（连离线一起删）/ null（取消） */
export function askOfflineBeforeDelete(docName, recs) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'doc-dlg ask-dlg';
    const bytes = recs.reduce((n, r) => n + (r.bytes || 0), 0);
    dlg.innerHTML = `
      <div class="dlg-head">移除收藏</div>
      <div class="dlg-body">
        <p style="margin-top:0"><span class="mono">${esc(shortName(docName, 40))}</span> 在本机还有
          <b>${recs.length}</b> 个离线版本（${fmtKB(bytes)}）。</p>
        <p class="hint">只移除收藏的话，离线正文还留着，仍然可以断网阅读。</p>
      </div>
      <div class="dlg-foot">
        <button class="btn" data-r="cancel">取消</button>
        <span class="spacer"></span>
        <button class="btn" data-r="keep">只移除收藏</button>
        <button class="btn danger" data-r="purge">连同离线一起删</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => {
      dlg.close(); dlg.remove(); resolve(b.dataset.r);
    }));
    dlg.addEventListener('cancel', () => { resolve(null); dlg.remove(); });
  });
}

/* ---------- 本机离线清单（清垃圾用） ---------- */

export async function openOfflinePanel({ onChange } = {}) {
  const rows = stripText(await offlineList()).sort((a, b) => b.ts - a.ts);
  const dlg = document.createElement('dialog');
  dlg.className = 'doc-dlg';
  dlg.innerHTML = `<div class="dlg-head">本机离线正文 <span class="spacer"></span>
      <span class="hint" id="op-sum"></span>
      <button class="btn sm" data-x style="margin-left:10px">关闭</button></div>
    <div class="dlg-body"></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const body = dlg.querySelector('.dlg-body');
  const sum = dlg.querySelector('#op-sum');
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-x]').addEventListener('click', close);
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.addEventListener('cancel', () => dlg.remove());

  const stat = () => {
    const bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
    sum.textContent = `${rows.length} 份 · ${fmtKB(bytes)}`;
  };

  function render() {
    stat();
    body.innerHTML = rows.length ? `
      <p class="hint" style="margin:0 0 10px">只存在这台设备上。删除不影响收藏，也不影响 IETF 官方存档。</p>
      <div class="off-list">${rows.map(r => `
        <div class="off-row" data-id="${esc(r.id)}">
          <div class="off-main">
            <a class="mono ell" href="#/read?doc=${encodeURIComponent(r.doc)}&ver=${encodeURIComponent(r.ver)}" data-open="${esc(r.id)}">${esc(r.label)}</a>
            ${r.title ? `<div class="hint ell" title="${esc(r.title)}">${esc(r.title)}</div>` : ''}
          </div>
          <span class="hint num">${fmtKB(r.bytes)} · ${fmtDate(r.ts)}</span>
          <button class="btn sm" data-go="${esc(r.id)}">阅读</button>
          <button class="btn sm danger" data-rm="${esc(r.id)}">删除</button>
        </div>`).join('')}</div>
      <div class="op-foot"><button class="btn sm danger" data-clear>清空全部（${rows.length} 份）</button></div>`
      : `<div class="empty" style="padding:28px 10px"><strong>还没有下载任何正文</strong>
          在收藏库里点文稿名，选一版「下载到本机」。</div>`;
    body.querySelectorAll('[data-open]').forEach(a => a.addEventListener('click', close));
    body.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
      const r = rows.find(x => x.id === b.dataset.go);
      if (!r) return;
      close();
      location.hash = `/read?doc=${encodeURIComponent(r.doc)}&ver=${encodeURIComponent(r.ver)}`;
    }));
    body.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      const rec = await offlineRemove(b.dataset.rm);
      const i = rows.findIndex(r => r.id === b.dataset.rm);
      if (i >= 0) rows.splice(i, 1);
      toast('已删除 ' + (rec?.label || '离线副本'));
      onChange?.();
      render();
    }));
    body.querySelector('[data-clear]')?.addEventListener('click', async () => {
      if (!confirm(`删除本机全部 ${rows.length} 份离线正文？\n\n收藏不受影响，但之后要重新下载才能断网读。`)) return;
      for (const r of rows.slice()) await offlineRemove(r.id);
      rows.length = 0;
      toast('已清空本机离线正文');
      onChange?.();
      render();
    });
  }
  render();
}

/* ---------- 阅读器 ---------- */

/** RFC / 草案的纯文本里每页都重复页眉页脚，读起来很吵；只去掉这两处，正文一个字不改 */
function tidyText(raw) {
  const pages = String(raw).replace(/\r\n/g, '\n').split('\n\f');
  return pages.map(page => {
    let lines = page.split('\n');
    // 每页第一行是页眉（RFC 号码 / 草案名 + 日期），第一页的页眉在正文之前，也不属于内容
    if (lines.length) lines = lines.slice(1);
    lines = lines.filter(l => !/\[Page \d+\]/.test(l));
    return lines.join('\n');
  }).join('\n\n').replace(/^\n+/, '').trimEnd();
}

const rfcLabel = n => n.replace(/^rfc/i, 'RFC ');

export async function viewRead(root) {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const doc = q.get('doc') || '';
  const ver = q.get('ver') || '';
  const live = q.get('live') === '1';
  root.className = '';
  if (!doc) {
    root.innerHTML = `<div class="empty"><strong>没指定文稿</strong><div style="margin-top:14px">
      <a class="btn primary" href="#/library">回收藏库</a></div></div>`;
    return;
  }

  let rec = null;
  let label = ver ? `${doc}-${ver}` : rfcLabel(doc);

  if (live) {
    // 在线看：取官方正文但不落库，先给个占位，别让页面空着
    root.innerHTML = `<div class="empty"><strong>正在取官方正文…</strong>这一版只读一次，不存到本机。</div>`;
    try {
      const text = await fetchDocText(doc, ver);
      rec = { doc, ver, label, bytes: new Blob([text]).size, ts: 0, text, live: true };
    } catch (e) {
      root.innerHTML = `<div class="empty"><strong>没取到正文</strong>${esc(e.message)}
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" id="rd-retry">重试</button>
          <a class="btn" href="#/library">回收藏库</a>
        </div></div>`;
      root.querySelector('#rd-retry')?.addEventListener('click', () => viewRead(root));
      return;
    }
  } else {
    rec = await db.get('offline', offlineRecId(doc, ver));
    if (!rec) {
      root.innerHTML = `<div class="empty"><strong>这份文稿不在本机</strong>
        可能已经删除，或者还没下载。<div style="margin-top:14px">
        <a class="btn primary" href="#/library">回收藏库</a></div></div>`;
      return;
    }
    label = rec.label || label;
  }

  let title = rec.title || '';
  if (!title) {
    try { title = (await index()).docs.get(doc)?.t || ''; } catch { /* 快照没加载也能读正文 */ }
  }

  // 同一篇存了多版时给个切换器；换版本不用回收藏库
  let others = [];
  if (!live) {
    try {
      others = ((await offlineMap()).get(doc) || []).sort((a, b) => String(b.ver).localeCompare(String(a.ver)));
    } catch { /* 列表读不到就不给切换器 */ }
  }

  root.innerHTML = `
    <div class="reader-bar">
      <div class="rd-main">
        <a class="btn sm" href="#/library">← 收藏库</a>
        <span class="mono ell" title="${esc(doc)}">${esc(shortName(label, 44))}</span>
        ${live ? '<span class="label yellow">在线</span>' : '<span class="label green">离线</span>'}
        <span class="hint num">${fmtKB(rec.bytes)}${live ? '' : ' · ' + fmtDate(rec.ts)}</span>
      </div>
      <div class="rd-act">
        ${others.length > 1 ? `<label class="rd-ver">版本 <select id="rd-ver">${others.map(o => `
          <option value="${esc(o.ver)}"${o.ver === rec.ver ? ' selected' : ''}>${esc(o.ver || label)}</option>`).join('')}</select></label>` : ''}
        ${live
          ? '<button class="btn sm primary" id="rd-save">存到本机</button>'
          : '<button class="btn sm danger" id="rd-del">删除本机</button>'}
      </div>
    </div>
    ${title ? `<h1 class="reader-title">${esc(title)}</h1>` : ''}
    ${live ? '<p class="reader-note">这是在线读取的官方正文，没有存到本机。要断网也能读，点「存到本机」。</p>' : ''}
    <div class="reader-tip">正文按原文 72 列排版，左右滑动可以看到完整的行。</div>
    <div class="doc-text"><pre id="rd-text"></pre></div>`;

  root.querySelector('#rd-text').textContent = tidyText(rec.text);

  root.querySelector('#rd-ver')?.addEventListener('change', e => {
    location.hash = `/read?doc=${encodeURIComponent(doc)}&ver=${encodeURIComponent(e.target.value)}`;
  });

  root.querySelector('#rd-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await saveOfflineDoc({ doc, ver, label: rec.label, title, text: rec.text });
      toast('已存到本机');
      location.hash = `/read?doc=${encodeURIComponent(doc)}&ver=${encodeURIComponent(ver)}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '存到本机';
      toast('保存失败：' + err.message);
    }
  });

  root.querySelector('#rd-del')?.addEventListener('click', async () => {
    if (!confirm(`删除本机的「${label}」？\n\n只删这份离线副本，收藏本身不受影响。`)) return;
    await offlineRemove(rec.id);
    toast('已删除本机副本');
    location.hash = '/library';
  });
}
