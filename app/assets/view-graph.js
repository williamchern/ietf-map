/* IETF Atlas — 图谱（一幅图，不再分三个子页）
 *
 * 业界知识图谱的通用做法就三件事，这次照做、不再自创：
 *   ① 固定布局：坐标离线算好，刷新、放大、全屏都不变形
 *   ② 点边关系：节点 = 文稿，边 = 引用，箭头指方向，粗细分规范/信息性
 *   ③ 看得清：全屏是真全屏（连页眉页脚都收起），手机上能横向拖
 *
 * 一屏回答一个问题：**这个技术领域里，谁建立在谁之上。**
 */
import { esc, toast, log } from './db.js';
import { index, getAssets, saveAsset, assetFromDoc, statusOf, DOC_URL, GROUP_URL } from './data.js';
import { shortName, isSubseries, relShort, REL_TEXT } from './mine.js';
import { loadLayout, mountGraph, ensureArrowDefs } from './kg.js';

const short = n => shortName(n, 26);
const SECTION_KEY = 'kg.group';

export async function viewGraph(root) {
  const idx = await index();
  const layout = await loadLayout();
  const assets = await getAssets();
  const owned = new Set(assets.filter(a => a.kind === 'doc').map(a => a.key));

  // 图谱只看**我收藏的草案所在的工作组**。
  // 全站 28 个领域里绝大部分跟我没关系，画出来没人看；收窄之后下拉里只有"我在跟的组"。
  const ownedCnt = new Map();
  for (const n of owned) {
    const g = idx.docs.get(n)?.g;
    if (g && layout.groups[g]) ownedCnt.set(g, (ownedCnt.get(g) || 0) + 1);
  }
  const featured = [...ownedCnt.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([g]) => g);

  // 从诊断页 / 搜索点「看图」进来：?g=组缩写 直接定位；也支持 ?g=某份文稿，跳到它所属的组并选中。
  // 这类"外面点进来"的组即使没收藏，也临时放进下拉——否则 select 里没有这一项，页面会空掉。
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const want = q.get('g') || '';
  let wantDoc = null;
  let extra = null;
  const dWant = want ? (idx.docs.get(want) || idx.docs.get(want.toLowerCase())) : null;
  const wantGroup = layout.groups[want] ? want : (dWant?.g && layout.groups[dWant.g] ? dWant.g : '');
  if (dWant) wantDoc = dWant.n;
  if (wantGroup && !featured.includes(wantGroup)) extra = wantGroup;
  const list = extra ? [extra, ...featured] : featured;

  // 默认组：URL 指定的 → 上次看过的 → 收藏最多的
  const last = localStorage.getItem(SECTION_KEY);
  const pick = list.includes(wantGroup) ? wantGroup
    : list.includes(last) ? last
      : list[0] || '';

  if (!list.length) {
    root.className = 'wide kg-only';
    // 两种空：一份没收藏 / 收藏了但都不在有图谱数据的工作组里——说法要不一样，不然像 bug
    const body = owned.size
      ? `<h3>这些文稿暂时画不出关系图</h3>
         <p class="hint">你收藏了 ${owned.size} 份文稿，但它们所属的工作组还没有可画的引用数据。<br>
         图谱只画 <strong>你收藏的草案</strong> 所在的工作组，不列全站那些跟你无关的公共组。</p>
         <a class="btn" href="#/library">去收藏库看看</a>`
      : `<h3>还没有可看的关系图</h3>
         <p class="hint">图谱只画 <strong>你收藏的草案</strong> 所在的工作组——不列全站那些跟你无关的公共组。<br>
         收藏几份草案之后，它们所属的工作组就会出现在这里。</p>
         <a class="btn primary" href="#/library">去收藏库看看</a>`;
    root.innerHTML = `<div class="kg-page" id="kg-page"><div class="kg-empty">${body}</div></div>`;
    return;
  }

  // kg-only：图谱页没有页脚，占满一屏（否则 footer 会把画布顶掉一截，底部那行字被切）
  root.className = 'wide kg-only';
  root.innerHTML = `
    <div class="kg-page" id="kg-page">
      <div class="kg-bar">
        <div class="kg-bar-l">
          <select id="kg-group" title="选择技术领域（工作组 / 研究组）">
            ${list.map(g => `<option value="${esc(g)}" ${g === pick ? 'selected' : ''}>${esc(g)} — ${esc(idx.groups.get(g)?.name || layout.groups[g]?.name || '')}</option>`).join('')}
          </select>
          <div class="kg-legend">
            <span><i class="k-dot rfc"></i>RFC</span>
            <span><i class="k-dot draft"></i>草案</span>
            <span><i class="k-dot owned"></i>我收藏的</span>
            <span class="k-sep"></span>
            <span><i class="k-line norm"></i>规范引用</span>
            <span><i class="k-line info"></i>信息性引用</span>
          </div>
        </div>
        <div class="kg-bar-r">
          <span class="hint" id="kg-count"></span>
          <button class="btn sm" id="kg-zoom-out" title="缩小">−</button>
          <button class="btn sm" id="kg-zoom-in" title="放大">+</button>
          <button class="btn sm" id="kg-fit" title="缩放到适合窗口">适合窗口</button>
          <button class="btn sm" id="kg-fs" title="全屏（Esc 退出）">全屏</button>
        </div>
      </div>
      <div class="kg-body">
        <div class="kg-stage">
          <div class="kg-canvas" id="kg-canvas"></div>
          <div class="kg-axis">
            <span>↑ 新工作</span>
            <span>↓ 地基</span>
            <span class="kg-axis-c">箭头：上层引用下层</span>
          </div>
          <div class="kg-hint" id="kg-hint">点一个点看它的引用明细</div>
          <div class="kg-tip" id="kg-tip" hidden></div>
        </div>
        <aside class="kg-side" id="kg-side"></aside>
      </div>
    </div>`;

  ensureArrowDefs();

  const page = root.querySelector('#kg-page');
  const canvas = root.querySelector('#kg-canvas');
  const side = root.querySelector('#kg-side');
  const countEl = root.querySelector('#kg-count');
  const sel = root.querySelector('#kg-group');

  let graph = null;
  let curGroup = null;
  let data = null;

  function groupData(acr) {
    const g = layout.groups[acr];
    if (!g) return null;
    return g;
  }

  function render() {
    curGroup = sel.value;
    localStorage.setItem(SECTION_KEY, curGroup);
    data = groupData(curGroup);
    if (!data) {
      canvas.innerHTML = '<div class="empty" style="padding:40px">这个领域还没有引用关系可画。</div>';
      countEl.textContent = '';
      side.innerHTML = '';
      return;
    }
    graph?.destroy();
    // focus: 选中一个点时，把无关的节点隐掉——"它依赖谁"要一眼看出来
    graph = mountGraph(canvas, { onPick: id => showDetail(id), focus: true });
    graph.setData(data);
    const st = graph.stats();
    const rfcN = data.docs.filter(n => /^rfc\d+$/i.test(n)).length;
    // 图只画"主干"：组内互相引用最密的那一圈。边缘的、谁都不挨着的文稿不画进图，
    // 但一份都不会丢——右侧列表和搜索里都在
    countEl.textContent = `${st.shown} 份文稿 · ${st.edges} 条引用`;
    side.innerHTML = introPanel();
    root.querySelector('#kg-hint').textContent =
      rfcN + ' 份 RFC · 其余草案 · 点一下看明细';
  }

  function introPanel() {
    const g = idx.groups.get(curGroup);
    const mine = data.docs.filter(n => owned.has(n)).length;
    const cited = data.docs.map(n => ({ n, c: idx.cited.get(n) || 0 })).sort((a, b) => b.c - a.c).slice(0, 5);
    return `
      <div class="d-head">
        <div class="row"><span class="mono big">${esc(curGroup)}</span>
          <span class="label ${g?.state === 'concluded' ? 'yellow' : 'green'}">${g?.state === 'concluded' ? '已关闭' : '进行中'}</span></div>
        <h3 style="margin:6px 0 2px">${esc(g?.name || data.name || '')}</h3>
        <div class="hint">${data.docs.length} 份文稿 · ${data.links.length} 条组内引用${mine ? ` · 你收藏了 ${mine} 份` : ''}</div>
      </div>
      <div class="d-body">
        <p class="hint" style="margin-top:0">一行是一层。最下面一行是这个领域的地基，越往上越是建在它之上的新工作；箭头从引用方指向被引用方。</p>
        <p class="hint kg-legend-inline"><i class="k-dot rfc"></i>RFC　<i class="k-dot draft"></i>草案　<i class="k-dot owned"></i>我收藏的　<i class="k-line norm"></i>规范引用　<i class="k-line info"></i>信息性引用</p>
        <p class="hint">图只画组内互相引用最密的那一圈（最多 ${32} 份），边缘的、谁也不挨着的文稿没画进来。</p>
        <div class="side-title">被引最多的地基（点一下定位）</div>
        <div class="mini-list">${cited.map(x => `<div class="mini-row">
          <a class="mono" href="#" data-goto="${esc(x.n)}">${esc(short(x.n))}</a>
          <span class="spacer"></span><span class="hint">被引 ${x.c}</span></div>`).join('')}</div>
        <div class="row">
          <a class="btn sm" href="${GROUP_URL(curGroup)}" target="_blank" rel="noopener">Datatracker 组页面 ↗</a>
        </div>
      </div>`;
  }

  function showDetail(id) {
    if (!id) { side.innerHTML = introPanel(); bindSide(); return; }
    const idxRow = idx.docs.get(id);
    const assetsNow = owned.has(id);
    const st = idxRow ? statusOf(idxRow) : { label: '快照外', cls: 'yellow' };
    const outs = [];
    const ins = [];
    for (const [s, t, w] of data.links) {
      if (s === id) outs.push({ to: t, w });
      if (t === id) ins.push({ to: s, w });
    }
    const relOfPairs = new Map();
    for (const [s, rel, t] of idx.snap.rels) {
      if (!s || !t) continue;
      if (s !== id && t !== id) continue;
      const k = s + '|' + t + '|' + rel;
      relOfPairs.set(k, (relOfPairs.get(k) || 0) + 1);
    }
    const kinds = new Map();
    for (const [k, v] of relOfPairs) {
      const rel = k.split('|')[2];
      kinds.set(rel, (kinds.get(rel) || 0) + v);
    }

    side.innerHTML = `
      <div class="d-head">
        <div class="row"><span class="mono big">${esc(id)}</span><span class="label ${st.cls}">${esc(st.label)}</span>
          ${assetsNow ? '<span class="label green">已收藏</span>' : ''}</div>
        <h3 style="margin:6px 0 2px">${esc(idxRow?.t || (isSubseries(id) ? 'RFC 子系列（BCP / STD / FYI），无单独标题' : '（不在本地快照中）'))}</h3>
        <div class="hint">${idxRow?.g ? esc(idxRow.g) + ' · ' : ''}被引 ${idx.cited.get(id) || 0}${idxRow?.rev ? ' · rev ' + esc(idxRow.rev) : ''}${idxRow?.time ? ' · ' + esc(idxRow.time) : ''}</div>
      </div>
      <div class="d-body">
        <div class="row" style="margin-bottom:12px">
          ${assetsNow ? '' : `<button class="btn primary sm" id="kg-add">收藏进地图</button>`}
          <a class="btn sm" href="${DOC_URL(id)}" target="_blank" rel="noopener">Datatracker ↗</a>
          <button class="btn sm" id="kg-clear">取消选中</button>
        </div>

        <div class="side-title">它依赖（它引用的 ${outs.length} 份）</div>
        <div class="mini-list">${outs.length ? outs.slice(0, 12).map(x => `<div class="mini-row">
          <a class="mono" href="#" data-goto="${esc(x.to)}">${esc(short(x.to))}</a>
          <span class="spacer"></span>${x.w > 1 ? `<span class="label blue">${x.w} 条</span>` : ''}
        </div>`).join('') + (outs.length > 12 ? `<div class="mini-row hint">还有 ${outs.length - 12} 份…</div>` : '') : '<div class="mini-row hint">组内没有它引用的文稿</div>'}</div>

        <div class="side-title">谁依赖它（引用它的 ${ins.length} 份）</div>
        <div class="mini-list">${ins.length ? ins.slice(0, 12).map(x => `<div class="mini-row">
          <a class="mono" href="#" data-goto="${esc(x.to)}">${esc(short(x.to))}</a>
        </div>`).join('') + (ins.length > 12 ? `<div class="mini-row hint">还有 ${ins.length - 12} 份…</div>` : '') : '<div class="mini-row hint">组内没有文稿引用它</div>'}</div>

        <div class="side-title">引用类型（快照全量）</div>
        <div class="mini-list">${[...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([rel, n]) => `<div class="mini-row">
          <span class="label ${rel === 'refnorm' ? 'blue' : ''}">${esc(relShort(rel))}</span>
          <span class="hint ellipsis">${esc(REL_TEXT[rel] || rel)}</span>
          <span class="spacer"></span><span class="hint">${n}</span></div>`).join('') || '<div class="mini-row hint">—</div>'}</div>
      </div>`;
    bindSide();
  }

  function bindSide() {
    side.querySelectorAll('[data-goto]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const id = a.dataset.goto;
      graph.setSelected(id);
      showDetail(id);
    }));
    side.querySelector('#kg-add')?.addEventListener('click', async () => {
      const id = graph && side.querySelector('.mono.big')?.textContent;
      if (!id) return;
      const d = idx.docs.get(id);
      await saveAsset(d ? assetFromDoc(d) : { id: 'd:' + id, key: id, kind: 'doc', added: Date.now() });
      await log('star-doc', id + ' (从图谱)');
      owned.add(id);
      toast('已加入：' + id);
      showDetail(id);
      paintOwned();
    });
    side.querySelector('#kg-clear')?.addEventListener('click', () => {
      graph.setSelected(null); side.innerHTML = introPanel(); bindSide();
    });
  }

  /* 收藏状态直接体现在节点样式上，不再额外画图例之外的装饰 */
  function paintOwned() {
    canvas.querySelectorAll('.kg-node').forEach(g => {
      g.classList.toggle('owned', owned.has(g.dataset.id));
    });
  }

  /* 全屏：真全屏——页眉、页脚、左侧栏全部收起，Esc 退出 */
  const setFs = on => {
    page.classList.toggle('is-fs', on);
    document.documentElement.classList.toggle('fs-open', on);
    root.querySelector('#kg-fs').textContent = on ? '退出全屏' : '全屏';
    setTimeout(() => graph?.fit(), 60);
  };
  root.querySelector('#kg-fs').addEventListener('click', () => setFs(!page.classList.contains('is-fs')));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && page.classList.contains('is-fs')) setFs(false);
  });

  root.querySelector('#kg-fit').addEventListener('click', () => graph.fit());
  root.querySelector('#kg-zoom-in').addEventListener('click', () => graph.zoom(1.18));
  root.querySelector('#kg-zoom-out').addEventListener('click', () => graph.zoom(0.85));
  sel.addEventListener('change', render);

  // 悬停看全名：标签是截断/折行后的短名，指上去要看得到完整 id
  const tip = root.querySelector('#kg-tip');
  canvas.addEventListener('pointerover', e => {
    const g = e.target.closest?.('.kg-node');
    if (!g) return;
    tip.textContent = g.dataset.id;
    tip.hidden = false;
  });
  canvas.addEventListener('pointerout', e => {
    if (e.target.closest?.('.kg-node')) tip.hidden = true;
  });

  render();
  // 首次挂载后把收藏状态刷上（节点是 render 里生成的）
  setTimeout(paintOwned, 0);
  if (wantDoc) setTimeout(() => { graph.setSelected(wantDoc); graph.reveal(wantDoc); showDetail(wantDoc); }, 80);
}
