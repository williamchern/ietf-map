/* IETF Atlas — 收藏库 / 诊断与报告 */
import { esc, toast, log, db, fmtDate, setSettings } from './db.js';
import { index, getAssets, saveAsset, removeAsset, computeGaps, statusOf, DOC_URL, GROUP_URL } from './data.js';
import { shortName } from './mine.js';
import {
  offlineMap, offlineTotal, openDocDialog, openOfflinePanel, askOfflineBeforeDelete,
  offlineRemove, fmtKB,
} from './offline.js';
export { openAddDialog } from './add-dialog.js';
import { openAddDialog } from './add-dialog.js';

function emptyBox(title, desc, cta) {
  return `<div class="empty"><strong>${esc(title)}</strong>${desc}${cta ? `<div style="margin-top:14px">${cta}</div>` : ''}</div>`;
}
const short = n => shortName(n, 34);


/* ================= 收藏库（按组归类） ================= */
export async function viewLibrary(root) {
  root.className = '';
  const idx = await index();
  const assets = await getAssets();
  const docAssets = assets.filter(a => a.kind === 'doc');
  const grpAssets = assets.filter(a => a.kind === 'group');
  const off = await offlineMap();
  const offStat = await offlineTotal();

  // 按组归类
  const secMap = new Map();
  for (const a of docAssets) {
    const d = idx.docs.get(a.key) || a.meta || { n: a.key };
    const g = d.g || '—';
    if (!secMap.has(g)) secMap.set(g, []);
    secMap.get(g).push({ a, d });
  }
  const sections = [...secMap.entries()].map(([g, list]) => {
    const grp = g === '—' ? null : idx.groups.get(g);
    return {
      g, list: list.sort((x, y) => (idx.cited.get(y.d.n) || 0) - (idx.cited.get(x.d.n) || 0)),
      name: grp?.name || '未归属（个人稿 / 单独的 RFC）',
      state: grp?.state || '',
      total: grp?.docs?.length || 0,
    };
  }).sort((a, b) => b.list.length - a.list.length || a.g.localeCompare(b.g));

  // 关注了但一份没收（空心组）
  const hollow = grpAssets.filter(a => !(secMap.get(a.key) || []).length)
    .map(a => ({ acr: a.key, grp: idx.groups.get(a.key) || a.meta }));

  root.innerHTML = `
    <h1>收藏库</h1>
    <p class="sub">按工作组 / 研究组归类。<b>「已收 / 组内总数」</b>能直接告诉你哪块有遗漏。</p>
    <div class="row" style="margin-bottom:16px">
      <button class="btn primary" id="add">+ 添加文稿 / 组</button>
      <button class="btn" id="export">导出 JSON 备份</button>
      <input type="search" id="filter" placeholder="在收藏中搜索…" style="max-width:260px">
      <span class="spacer"></span>
      <button class="btn sm" id="offline-btn" title="阅读 / 删除本机离线正文">
        离线管理${offStat.count ? ` · ${offStat.count} 份 · ${fmtKB(offStat.bytes)}` : ''}
      </button>
      <span class="hint">${docAssets.length} 份文稿 · ${sections.length} 个有收藏的组</span>
    </div>

    ${!docAssets.length ? emptyBox('还没有任何收藏', '把读过的草案、RFC 加进来，图谱才有意义。', '<button class="btn primary" id="add2">添加第一条</button>') : ''}

    <div id="secs">
    ${sections.map(s => `
      <details class="grp-sec" open data-sec="${esc(s.g)}">
        <summary>
          <span class="mono strong">${esc(s.g === '—' ? '未归属' : s.g)}</span>
          <span class="hint ellipsis" style="max-width:38ch">${esc(s.name)}</span>
          ${s.state === 'concluded' ? '<span class="label yellow">已关闭</span>' : ''}
          <span class="spacer"></span>
          <span class="label ${s.total && s.list.length >= s.total ? 'green' : 'blue'}">已收 ${s.list.length}${s.total ? ' / ' + s.total : ''}</span>
        </summary>
        <div class="table-wrap"><table class="lib-table"><thead><tr>
          <th class="c-name">文稿</th><th class="c-title">标题 · 笔记</th>
          <th class="c-cite">被引</th><th class="c-act"></th></tr></thead>
        <tbody>
        ${s.list.map(({ a, d }) => {
          const st = d && d.st ? statusOf(d) : { label: '无元数据', cls: 'yellow' };
          const mine = off.get(a.key) || [];
          return `<tr data-name="${esc(a.key)}">
            <td class="c-name">
              <button class="link-name mono" data-open="${esc(a.key)}" title="选版本：阅读 / 下载 / 在线看">${esc(short(a.key))}</button>
              <span class="label ${st.cls}">${esc(st.label)}</span>
              ${mine.length ? `<span class="off-tag" title="本机已存 ${mine.length} 个离线版本">离线 ${mine.length}</span>` : ''}
              <span class="row-title ell">${esc(d?.t || '—')}</span>
            </td>
            <td class="c-title" title="${esc(d?.t || '')}">
              <div class="ell">${esc(d?.t || '—')}</div>
              ${a.note ? `<div class="hint ell note-line" title="${esc(a.note)}">笔记 · ${esc(a.note)}</div>` : ''}
            </td>
            <td class="c-cite num">${idx.cited.get(a.key) || 0}</td>
            <td class="c-act"><button class="btn sm" data-mgr="${esc(a.key)}" title="管理这一篇的离线副本">管理</button></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>
      </details>`).join('')}
    </div>

    ${hollow.length ? `<div class="card" style="margin-top:16px">
      <div class="head">关注了但一份都没收的组 (${hollow.length})</div>
      <div class="body">
        <p class="hint" style="margin-top:0">这些组你点了关注，但组内 0 份收藏——属于"名义关注"。要么补一份，要么取消关注。</p>
        <div class="mini-list">${hollow.map(h => `<div class="mini-row">
          <a class="mono" href="${GROUP_URL(h.acr)}" target="_blank" rel="noopener">${esc(h.acr)}</a>
          <span class="hint ellipsis">${esc(h.grp?.name || '')}</span>
          <span class="spacer"></span>
          <span class="hint">组内 ${idx.groups.get(h.acr)?.docs?.length || 0} 份</span>
          <button class="btn sm danger" data-delg="${esc(h.acr)}">取消关注</button>
        </div>`).join('')}</div>
      </div></div>` : ''}

    ${grpAssets.length ? `<div class="card"><div class="head">关注的工作组 (${grpAssets.length})</div>
      <div class="body grid c4">
      ${grpAssets.map(a => {
        const g = idx.groups.get(a.key) || a.meta;
        const own = (secMap.get(a.key) || []).length;
        return `<div><div class="row"><a class="mono" href="${GROUP_URL(a.key)}" target="_blank" rel="noopener"><strong>${esc(a.key)}</strong></a>
        ${g?.state ? `<span class="label ${g.state === 'concluded' ? 'yellow' : 'green'}">${esc(g.state)}</span>` : ''}
        <span class="spacer"></span><button class="btn sm danger" data-delg="${esc(a.key)}">×</button></div>
        <div class="hint ellipsis">${esc(g?.name || '（离线无元数据）')}</div>
        <div class="hint">已收 ${own} / 组内 ${idx.groups.get(a.key)?.docs?.length || 0}</div></div>`;
      }).join('')}
    </div></div>` : ''}
  `;

  root.querySelector('#add')?.addEventListener('click', () => openAddDialog(() => viewLibrary(root)));
  root.querySelector('#add2')?.addEventListener('click', () => openAddDialog(() => viewLibrary(root)));

  root.querySelector('#filter')?.addEventListener('input', e => {
    const s = e.target.value.toLowerCase();
    root.querySelectorAll('#secs .grp-sec').forEach(sec => {
      let shown = 0;
      sec.querySelectorAll('tbody tr').forEach(tr => {
        const hit = !s || tr.dataset.name.includes(s) || tr.textContent.toLowerCase().includes(s);
        tr.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      sec.style.display = shown ? '' : 'none';
      if (s && shown) sec.open = true;
    });
  });

  /** 删收藏前先问一句：本机还存着离线正文的话，别让它变成看不见的垃圾 */
  const delDoc = async (key) => {
    const recs = off.get(key) || [];
    let purge = false;
    if (recs.length) {
      const ans = await askOfflineBeforeDelete(key, recs);
      if (ans === null) return;            // 取消：什么都不做
      purge = ans === 'purge';
      if (purge) for (const r of recs) await offlineRemove(r.id);
    }
    await removeAsset('d:' + key);
    await log('unstar-doc', key + (purge ? ' (含离线)' : ''));
    toast(purge ? '已移除（含离线副本）' : '已移除');
    viewLibrary(root);
  };
  const dlDoc = (key, mode = 'open') => openDocDialog(key, {
    mode,
    onChange: () => viewLibrary(root),
    onRemove: () => delDoc(key),
  });
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => dlDoc(b.dataset.open, 'open')));
  root.querySelectorAll('[data-mgr]').forEach(b => b.addEventListener('click', () => dlDoc(b.dataset.mgr, 'manage')));
  root.querySelector('#offline-btn')?.addEventListener('click', () => openOfflinePanel({ onChange: () => viewLibrary(root) }));
  root.querySelectorAll('[data-delg]').forEach(b => b.addEventListener('click', async () => {
    await removeAsset('g:' + b.dataset.delg); await log('unstar-group', b.dataset.delg);
    toast('已取消关注'); viewLibrary(root);
  }));
  root.querySelector('#export')?.addEventListener('click', async () => {
    const s = await db.all('settings');
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), assets, settings: s }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `ietf-atlas-backup-${fmtDate(Date.now())}.json`; a.click();
    await log('export-backup', `${assets.length} 项`);
    await setSettings({ lastExport: Date.now() });
    toast('已导出备份');
  });
}

/* ================= 诊断 =================
 * 这一页只回答一件事：接下来补哪几份。
 * 评分、报告、导出、历史快照全部砍掉——那些是给别人看的，不解决手边的问题。
 */
export async function viewDiagnosis(root) {
  root.className = '';
  const idx = await index();
  const assets = await getAssets();
  const docAssets = assets.filter(a => a.kind === 'doc');

  if (!docAssets.length) {
    root.innerHTML = `<h1>诊断</h1><p class="sub">先建立地图，诊断才有意义。</p>
      ${emptyBox('还没有可诊断的内容', '至少收藏 3–5 份文稿，结论才站得住。', '<button class="btn primary" id="go">去添加</button>')}`;
    root.querySelector('#go').addEventListener('click', () => openAddDialog(() => viewDiagnosis(root)));
    return;
  }

  const gaps = computeGaps(idx, assets);
  // 被上千份文稿引用的通用规范（RFC 2119 / 8174 那类）不算缺口
  const BOILER = 800;
  const dReal = gaps.dangling.filter(x => (idx.cited.get(x.to) || 0) < BOILER);
  const dBoiler = gaps.dangling.filter(x => (idx.cited.get(x.to) || 0) >= BOILER);
  const seen = new Set(dReal.map(x => x.to));
  // 只算「你在这个组里确实有收藏」的组；只关注了组却一篇没收的，归到 ④
  const myGroups = new Set(assets.filter(a => a.kind === 'doc')
    .map(a => (idx.docs.get(a.key) || a.meta)?.g).filter(Boolean));
  const orphans = gaps.orphans.filter(o => myGroups.has(o.g) && !seen.has(o.n));

  const byGroup = new Map();
  for (const o of orphans) {
    if (!byGroup.has(o.g)) byGroup.set(o.g, []);
    byGroup.get(o.g).push(o);
  }
  // 每组最多 4 条、最多 8 个组——清单长了就又变成"不知道从哪下手"
  const groupBlocks = [...byGroup.entries()]
    .map(([g, list]) => ({ g, list: list.sort((a, b) => b.cited - a.cited).slice(0, 4), total: list.length }))
    .sort((a, b) => b.list[0].cited - a.list[0].cited)
    .slice(0, 8);
  const orphanShown = groupBlocks.reduce((n, b) => n + b.list.length, 0);

  const nC = gaps.stale.length ? 3 : null;
  const nD = nC ? 4 : 3;
  const bits = [];
  if (dReal.length) bits.push(`<b>${dReal.length}</b> 份规范性引用的依据没读`);
  if (orphans.length) bits.push(`<b>${orphans.length}</b> 份组内高被引没收`);
  if (gaps.stale.length) bits.push(`<b>${gaps.stale.length}</b> 份已过期`);
  const say = bits.length ? bits.join('；') + '。' : '没有需要补的，收藏已经自洽。';

  const row = (n) => {
    const d = idx.docs.get(n);
    const st = d ? statusOf(d) : { label: '快照外', cls: 'yellow' };
    return `<div class="todo-row">
      <div class="todo-main">
        <div class="todo-line">
          <a class="mono" href="${DOC_URL(n)}" target="_blank" rel="noopener">${esc(short(n))}</a>
          <span class="label ${st.cls}">${esc(st.label)}</span>
        </div>
        <div class="hint ellipsis">${esc(d?.t || '—')}</div>
      </div>
      <span class="hint num">被引 ${idx.cited.get(n) || 0}</span>
      <a class="btn sm" href="#/graph?g=${esc(n)}" title="在图谱里看它前后都有谁">看图</a>
      <button class="btn sm" data-add="${esc(n)}">收藏</button>
    </div>`;
  };

  // ① 按「谁引用了它」分块：同一份收藏欠的依据放在一起，避免每行重复一遍来源
  const bySrc = new Map();
  for (const x of dReal) {
    if (!bySrc.has(x.from)) bySrc.set(x.from, []);
    bySrc.get(x.from).push(x.to);
  }
  const srcBlocks = [...bySrc.entries()]
    .map(([from, list]) => ({ from, list: list.sort((a, b) => (idx.cited.get(b) || 0) - (idx.cited.get(a) || 0)) }))
    .sort((a, b) => b.list.length - a.list.length)
    .slice(0, 3);
  // 只列"欠得最多"的三篇；剩下的条数要说清楚，否则总数和看到的行数对不上
  const srcShown = srcBlocks.reduce((n, b) => n + Math.min(10, b.list.length), 0);

  root.innerHTML = `
    <h1>诊断</h1>
    <p class="sub">这一页只回答一件事：<b>接下来补哪几份</b>。没有评分，没有排名，也不导出报告。</p>

    <div class="card"><div class="body" style="padding:14px 16px">
      <div class="diag-say">${say}</div>
      <div class="hint" style="margin-top:4px">${dReal.length ? '先补 ①：读了结论却没读依据，是最容易高估自己的地方。' : '①、② 都空就说明这块已经补齐了。'}</div>
    </div></div>

    <h2>① 你引用了，但没读 <span class="label red">${dReal.length}</span></h2>
    <p class="hint" style="margin-top:-4px">你的收藏在规范性引用（硬依赖）里点名了它们。缺了这些，结论站不住。</p>
    ${dReal.length > srcShown ? `<p class="hint" style="margin:-6px 0 14px">还有 ${dReal.length - srcShown} 条分散在其它收藏里，按下面同一套办法在收藏库逐篇看。</p>` : ''}
    ${srcBlocks.map(b => `
      <div class="todo-group">
        <div class="todo-group-h"><span class="mono strong">${esc(short(b.from))}</span>
          <span class="hint">规范性引用了 ${b.list.length} 份你还没读的</span></div>
        ${b.list.slice(0, 10).map(n => row(n)).join('')}
        ${b.list.length > 10 ? `<div class="todo-more">还有 ${b.list.length - 10} 份，在收藏库看这组</div>` : ''}
      </div>`).join('') || '<div class="mini-list ledger"><div class="todo-row"><div class="todo-main hint">没有实质性断链。</div></div></div>'}
    ${dBoiler.length ? `<details style="margin:-4px 0 18px"><summary class="hint" style="cursor:pointer">另有 ${dBoiler.length} 条通用基础规范（RFC 2119 那类，被 ${BOILER}+ 份文稿引用，通常不必单独收）</summary>
      <div class="mini-list ledger" style="margin-top:8px">${dBoiler.slice(0, 20).map(x => row(x.to)).join('')}</div></details>` : ''}

    <h2>② 组里有，你没收 <span class="label blue">${orphans.length}</span></h2>
    <p class="hint" style="margin-top:-4px">你在这个组里有收藏，但这几份是组内被引最高的活跃文稿。每组最多列 4 条、最多 8 个组${orphans.length > orphanShown ? `，这里先给 ${orphanShown} 条，其余 ${orphans.length - orphanShown} 条在收藏库里按组看` : ''}。</p>
    ${groupBlocks.map(b => `
      <div class="todo-group">
        <div class="todo-group-h"><a class="mono strong" href="#/library">${esc(b.g)}</a>
          <span class="hint ellipsis">${esc(idx.groups.get(b.g)?.name || '')}</span></div>
        ${b.list.map(o => row(o.n)).join('')}
      </div>`).join('') || '<div class="hint">没有。</div>'}

    ${gaps.stale.length ? `<h2>③ 已过期 / 被替代 <span class="label red">${gaps.stale.length}</span></h2>
    <p class="hint" style="margin-top:-4px">这些收藏已经失效，引用它们会出问题。换成新版或标注弃用。</p>
    <div class="mini-list ledger">${gaps.stale.map(x => `<div class="todo-row">
      <div class="todo-main"><a class="mono" href="${DOC_URL(x.n)}" target="_blank" rel="noopener">${esc(short(x.n))}</a>
        <span class="label red">${esc(x.status.label)}</span>
        <div class="hint">${x.replacedBy.length ? '→ ' + x.replacedBy.map(v => esc(short(v))).join('、') : '无替代版本记录'}</div></div>
    </div>`).join('')}</div>` : ''}

    ${gaps.hollow.length ? `<h2>${nD === 4 ? '④' : '③'} 关注了但没读的组 <span class="label yellow">${gaps.hollow.length}</span></h2>
    <p class="hint" style="margin-top:-4px">名义关注。补一份，或者取消关注——留着一个空的组，只会让收藏库看着乱。</p>
    <div class="mini-list ledger">${gaps.hollow.map(h => `<div class="todo-row">
      <div class="todo-main"><span class="mono">${esc(h.g)}</span>
        <span class="hint ellipsis">${esc(idx.groups.get(h.g)?.name || '')}</span></div>
      <span class="hint num">${h.docs} 份</span>
      <a class="btn sm" href="${GROUP_URL(h.g)}" target="_blank" rel="noopener">看组 ↗</a>
    </div>`).join('')}</div>` : ''}

    <p class="hint" style="margin-top:24px">口径与判定规则见 <a href="#/help">帮助</a>。数据快照 ${esc(idx.snap.meta.generated)}。</p>`;

  root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', async () => {
    const n = b.dataset.add;
    await saveAsset({ id: 'd:' + n, key: n, kind: 'doc', added: Date.now() });
    await log('star-doc', n + ' (来自诊断)');
    toast('已收藏 ' + n);
    b.textContent = '已收藏'; b.disabled = true;
  }));
}
