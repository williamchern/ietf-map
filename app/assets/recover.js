/* IETF Atlas — 本机数据找回 / 备份
 *
 * 收藏存在浏览器 IndexedDB 里，按账号分库：ietf-atlas--<账号名>。
 * 换账号、换浏览器、清站点数据，看到的都会是空库——数据可能还在别的库里。
 * 这里做的事：把本机能看到的库都列出来，数一数各有多少东西，再决定往哪儿搬。
 */
import { db, esc, fmtDate, getSettings, setSettings, log, toast, relTime } from './db.js';
import { authUser } from './auth.js';

const PREFIX = 'ietf-atlas';
const READ_STORES = ['assets', 'notes', 'tags', 'reports', 'offline'];
const RESTORE_STORES = ['assets', 'notes', 'tags', 'reports', 'offline'];

/* ---------- 读别人的库（只读，不动源数据） ---------- */

function openRo(name) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(name); } catch (e) { return reject(e); }
    // 源库如果是更老的版本，别让 onupgradeneeded 把它写坏：直接放弃
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch { /* ignore */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('被占用'));
  });
}

function readAll(dbi, store) {
  return new Promise(res => {
    if (!dbi.objectStoreNames.contains(store)) return res([]);
    try {
      const r = dbi.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    } catch { res([]); }
  });
}

/** 本机能看见的所有 atlas 库；枚举不了就退回「旧库 + 当前库」。 */
export async function localDbs() {
  let names = [];
  try {
    if (indexedDB.databases) {
      names = (await indexedDB.databases()).map(d => d.name).filter(n => n && (n === PREFIX || n.startsWith(PREFIX + '--')));
    }
  } catch { /* 有的浏览器不给枚举 */ }
  if (!names.length) {
    names = [PREFIX];
    const me = authUser();
    if (me) names.push(`${PREFIX}--${slug(me.name)}`);
  }
  const cur = currentName();
  return [...new Set(names)].sort((a, b) => (a === cur ? -1 : b === cur ? 1 : a.localeCompare(b)));
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
}

function currentName() {
  const me = authUser();
  return me ? `${PREFIX}--${slug(me.name)}` : PREFIX;
}

/** 每个库：各 store 条数 + 最近一条记录的时间。 */
export async function scan() {
  const out = [];
  for (const name of await localDbs()) {
    let dbi;
    try { dbi = await openRo(name); } catch { out.push({ name, error: '打不开' }); continue; }
    const rows = {};
    for (const s of READ_STORES) rows[s] = await readAll(dbi, s);
    try {
      const stores = [...dbi.objectStoreNames];
      dbi.close();
      out.push({
        name,
        current: name === currentName(),
        stores,
        counts: Object.fromEntries(READ_STORES.map(s => [s, rows[s].length])),
        last: Math.max(0, ...rows.assets.map(a => Number(a.added || a.savedAt || a.updatedAt || 0))),
        sample: rows.assets.slice(0, 3).map(a => a.title || a.id || '（无标题）'),
      });
    } catch (e) {
      out.push({ name, error: String(e).slice(0, 60) });
    }
  }
  return out;
}

/** 把某个库整段搬到当前账号下。只加不删：同 id 覆盖，其余保留。 */
export async function restoreFrom(name) {
  const dbi = await openRo(name);
  const rows = {};
  for (const s of RESTORE_STORES) rows[s] = await readAll(dbi, s);
  try { dbi.close(); } catch { /* ignore */ }

  let n = 0;
  for (const s of RESTORE_STORES) {
    for (const row of rows[s] || []) { await db.put(s, row); if (s === 'assets') n++; }
  }
  await log('data-restore', `从 ${name} 恢复 ${n} 条收藏`);
  return { assets: n, offline: (rows.offline || []).length };
}

/* ---------- 存储状态：会不会被浏览器回收 ---------- */

export async function storageInfo() {
  const info = { used: 0, quota: 0, persisted: false, supported: !!(navigator.storage && navigator.storage.persist) };
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.used = e.usage || 0;
      info.quota = e.quota || 0;
    }
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
  } catch { /* ignore */ }
  return info;
}

export async function askPersist() {
  try { return await navigator.storage.persist(); } catch { return false; }
}

/* ---------- 备份 ---------- */

export async function exportBackup() {
  const assets = await db.all('assets');
  const notes = await db.all('notes');
  const tags = await db.all('tags');
  const reports = await db.all('reports');
  const s = await getSettings();
  const blob = new Blob([JSON.stringify({
    exported: new Date().toISOString(),
    account: authUser()?.name || '',
    assets, notes, tags, reports,
    settings: { theme: s.theme, density: s.density, maxNodes: s.maxNodes, groupStates: s.groupStates },
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ietf-atlas-backup-${fmtDate(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  await log('export-backup', `手动备份 ${assets.length} 条收藏`);
  await setSettings({ lastExport: Date.now() });
  return assets.length;
}

/* ---------- 配置页里的那张卡 ---------- */

export async function mountRecover(root) {
  const list = root.querySelector('#db-list');
  const info = root.querySelector('#store-info');
  if (!list) return;

  const size = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B');

  const paintStorage = async () => {
    const st = await storageInfo();
    const s = await getSettings();
    const bits = [`本机已用 ${size(st.used)}`];
    if (st.quota) bits.push(`可用额度 ${size(st.quota)}`);
    bits.push(st.supported ? (st.persisted ? '持久存储：<b class="good">已开启</b>' : '持久存储：<b>未开启</b>（浏览器在空间紧张时可能回收）') : '持久存储：此浏览器不支持');
    bits.push(s.lastExport ? `上次备份：${relTime(s.lastExport)}` : '<b>还没备份过</b>');
    info.innerHTML = bits.join(' · ');
    const btn = root.querySelector('#db-persist');
    if (btn) btn.hidden = !st.supported || st.persisted;
    const tip = root.querySelector('#db-tip');
    if (tip) {
      const days = s.lastExport ? (Date.now() - s.lastExport) / 86400000 : 999;
      tip.hidden = days < 14;
      tip.textContent = `已经 ${s.lastExport ? Math.floor(days) + ' 天' : '很久'}没导出备份了。数据只在这台浏览器里，建议现在导一份存到网盘。`;
    }
  };
  paintStorage();

  root.querySelector('#db-persist')?.addEventListener('click', async () => {
    const ok = await askPersist();
    toast(ok ? '已开启持久存储' : '浏览器拒绝了（可稍后再试，或把站点加到书签常用）');
    paintStorage();
  });

  const doScan = async () => {
    list.innerHTML = '<div class="hint">正在扫描…</div>';
    const rows = await scan();
    if (!rows.length) { list.innerHTML = '<div class="hint">没有找到任何本地库——这个浏览器里确实没有数据了。</div>'; return; }
    list.innerHTML = `<div class="db-rows">
      ${rows.map(r => r.error ? `<div class="db-row"><div class="db-row-main"><code>${esc(r.name)}</code></div>
          <div class="db-row-meta">打不开：${esc(r.error)}</div></div>` : `<div class="db-row">
        <div class="db-row-main"><code>${esc(r.name)}</code>${r.current ? ' <span class="tag">当前</span>' : ''}</div>
        <div class="db-row-meta">收藏 <b>${r.counts.assets}</b> · 笔记 ${r.counts.notes} · 离线 ${r.counts.offline} · 最近改动 ${r.last ? fmtDate(r.last) : '—'}</div>
        ${r.current || !r.counts.assets ? '' : `<div class="db-row-act"><button class="btn sm" data-restore="${esc(r.name)}" data-count="${r.counts.assets}">恢复到此账号</button></div>`}
      </div>`).join('')}
      </div>
      <div class="hint" style="margin-top:8px">「恢复到此账号」只加不删：同一条记录以源库为准，本账号独有的记录保留，源库也不会被改动。
      ${rows.some(r => r.counts && r.counts.assets > 0) ? '' : '这几个库都是空的，说明数据已不在这个浏览器里。'}</div>`;

    list.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.dataset.restore;
      const n = btn.dataset.count;
      if (!confirm(`把 ${name} 里的 ${n} 条收藏合并到当前账号？\n\n不会删除源库，也不动当前账号已有的其它记录。`)) return;
      btn.disabled = true; btn.textContent = '恢复中…';
      try {
        const r = await restoreFrom(name);
        btn.textContent = `✓ 已恢复 ${r.assets}`;
        toast(`已恢复 ${r.assets} 条收藏，正在刷新`);
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        btn.disabled = false; btn.textContent = '恢复到此账号';
        toast('恢复失败：' + e.message);
      }
    }));
  };

  root.querySelector('#db-scan')?.addEventListener('click', doScan);

  // 当前账号是空库就直接扫一遍：多半是换账号 / 换浏览器丢的，有救就当场告诉他
  try { if (!(await db.all('assets')).length) await doScan(); } catch { /* ignore */ }

  root.querySelector('#db-export')?.addEventListener('click', async () => {
    const n = await exportBackup();
    toast(`已导出 ${n} 条收藏`);
  });
  root.querySelector('#db-import')?.addEventListener('click', () => root.querySelector('#db-file')?.click());
  root.querySelector('#db-file')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      let n = 0;
      for (const a of j.assets || []) { await db.put('assets', a); n++; }
      for (const x of j.notes || []) await db.put('notes', x);
      await log('import-backup', `${n} 项`);
      toast(`已导入 ${n} 条收藏，正在刷新`);
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast('导入失败：文件不是有效的备份 JSON');
    }
  });
}
