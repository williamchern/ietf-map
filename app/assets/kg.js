/* IETF Atlas — 静态知识图谱（SVG）
 *
 * 设计取舍（和之前的力导向完全相反）：
 *   1. 坐标是离线算好、写进 layout.json 的常量 —— 刷新前后、放大前后，图的形状永远一样。
 *   2. 布局是「分层」的：**一行 = 一个层次**。最下面一行是地基（被引最多的那份），
 *      越往上越是建在它之上的新工作；层内横向排开，箭头一律从上层指向下层。
 *      这比"弹簧乱飞"直观，因为 IETF 的引用本身就是 DAG，而且 RFC 编号也是自下而上的。
 *   3. 不求精确坐标，只求"一眼看出谁支持谁"：每层之间留一条空带，
 *      标签不会被线穿过（线走圆点，字挂在点的正下方）。
 *   4. 不抢鼠标：只有拖动画布是拖，点节点只是点亮，绝不会在指针底下挪动。
 *
 * 用法：mountGraph(box, { group, docs, onPick }) → { destroy, fit, setFocus }
 */
import { shortName } from './mine.js';

let _layout = null;

export async function loadLayout() {
  if (_layout) return _layout;
  const r = await fetch('./data/layout.json', { cache: 'no-cache' });
  _layout = r.ok ? await r.json() : { groups: {}, meta: {} };
  return _layout;
}

const NS = 'http://www.w3.org/2000/svg';
// 坐标系：**行 = 层次（rank）**，**列 = 层内位置**。
// 引用是自左向右的：左边是地基，右边是建在它上面的新工作。
// 这样读起来跟读一篇 RFC 的 References 一样，不用"往下滚屏"。
const COL_W = 132;      // 列宽（层内水平间距）
const ROW_H = 60;       // 行高：一行 = 一个层次（点上、字下，约 10px 呼吸）
const LANE = 8;         // 同一段通道里多条边上下分道的间距
const LIMIT = 11;       // 单行标签最大字符数：再长就折成两行

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/** 缩放范围：缩到 0.62 字还有 7.5px（还认得出），放到 1.35 已经很大 */
function clampK(W, H) {
  return { min: 0.62, max: 1.35 };
}

export function mountGraph(box, opts = {}) {
  const { onPick = () => {}, focus = false } = opts;
  box.innerHTML = '';
  const svg = el('svg', { class: 'kg' }, box);
  const gRoot = el('g', null, svg);
  const gEdges = el('g', { class: 'kg-edges' }, gRoot);
  const gNodes = el('g', { class: 'kg-nodes' }, gRoot);

  // 背景矩形垫在最底层：只用来"点空白取消选中"。
  // 它必须插到 svg 的第一个孩子（放到 gRoot 里会盖住节点——之前点击被挡住的就是它）
  const bgRect = el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'transparent', class: 'kg-bg' });
  svg.insertBefore(bgRect, gRoot);
  gRoot.setAttribute('class', 'kg-root');

  const state = { t: { x: 0, y: 0, k: 1 }, sel: null, hover: null, data: null, cut: 0 };
  let nodes = [];

  /** 点 = 圆点，字挂在下面两行；宽度估算要和 CSS 的 12px 字号对齐 */
  const tw = t => [...t].reduce((a, ch) => a + (/[\u4e00-\u9fa5]/.test(ch) ? 12.2 : 7.0), 0) + 4;

  /** 画布的内容区（盒模型去掉 padding）——坐标原点在 border-box 左上，
   *  而内边距是画在盒子里的，所以取景要以内容区为准，否则底部那行字正好被内边距吃掉 */
  function viewRect() {
    const r = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    return {
      left: r.left + pl, top: r.top + pt,
      width: Math.max(1, r.width - pl - pr), height: Math.max(1, r.height - pt - pb),
    };
  }

  function place(data) {
    state.data = data;
    gEdges.textContent = '';
    gNodes.textContent = '';
    nodes = [];
    state.cut = 0;
    if (!data) { state.bounds = null; return; }

    const vr = viewRect();
    const W = Math.max(240, vr.width);
    const H = Math.max(200, vr.height);
    const padX = 30, padY = 30;

    // rank = 层次（0 = 最底层的地基），就地取行号，不做任何"裁剪"，骨架不丢
    const ranks = [...new Set(Object.values(data.order || {}).map(o => o.rank))].sort((a, b) => a - b);
    const rankIdx = new Map(ranks.map((r, i) => [r, i]));
    const R = ranks.length || 1;
    // 层内次序：直接用布局里给的（dot 会顺手把邻居排在一起）
    const seq = new Map();
    for (const id of data.docs) {
      const o = data.order?.[id];
      seq.set(id, o ? o.row : 0);
    }
    const byRank = new Map();
    for (const id of data.docs) {
      const r = rankIdx.get(data.order?.[id]?.rank) ?? 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(id);
    }
    for (const arr of byRank.values()) arr.sort((a, b) => (seq.get(a) - seq.get(b)) || a.localeCompare(b));

    // 标签：长名字在中间断开折两行（省横向空间，一行里能塞更多节点）
    const prep = id => {
      const bare = id.replace(/^draft-ietf-/, '').replace(/^draft-/, '');
      let lines;
      if (/^rfc\d+$/i.test(id) || /^(bcp|std|fyi)\d+$/i.test(id) || bare.length <= LIMIT) {
        lines = [shortName(id, LIMIT)];
      } else {
        let cut = -1;
        for (let k = Math.ceil(bare.length / 2); k < bare.length - 2; k++) {
          if (bare[k] === '-') { cut = k; break; }
        }
        lines = cut > 2 ? [bare.slice(0, cut + 1), bare.slice(cut + 1)] : [shortName(id, LIMIT)];
      }
      return { lines, tw: Math.max(...lines.map(tw)) };
    };

    // 每层里最多排几列。手机上排不了几列（排太宽就只能整体缩到看不清），
    // 宁可折成几个子行；桌面视口大，最多排到 12~14 列。
    const avail = (W - padX * 2) / COL_W;
    const total = data.docs.length;
    const roomy = total > 30 ? 2 : total > 20 ? 1 : 0;
    const capByWidth = Math.max(3, Math.floor(avail * 1.15));
    let perRow = Math.min(12 + roomy, Math.max(4, capByWidth + roomy));
    // 层太少（一大半都挤在同一层）时多摊几列，免得整幅图只有两三行
    if (R * perRow < total * 0.6) perRow = Math.min(16, Math.ceil(total / Math.max(3, R)));

    const maxW = Math.max(...data.docs.map(id => prep(id).tw), 40);

    // 每层分页：一层里节点太多就折成「几个子行」，同一层内上下并列，
    // 层与层之间永远留一条空带——箭头和"这一层是什么"才看得出来。
    const SUB_H = ROW_H;                 // 层内每个子行的高度
    const GAP_H = 34;                    // 层与层之间的空带
    const rowsOfRank = new Map();
    let y = 0;
    const rankY = [];
    for (let r = 0; r < R; r++) {
      const arr = byRank.get(r) || [];
      const k = Math.max(1, Math.ceil(arr.length / perRow));
      rankY.push({ y0: y, k, n: arr.length, per: Math.ceil(Math.max(arr.length, 1) / k) });
      y += k * SUB_H + (r < R - 1 ? GAP_H : 0);
    }
    const totalH = y;
    const maxK = Math.max(...rankY.map(t => t.k));
    // 层内水平间距：层浅（层少、一层稀）时拉开一点，图不会缩成中间一小团
    const COL_H = COL_W * (maxK <= 2 ? 1.5 : 1);
    const outCols = Math.max(...rankY.map(t => t.per), 1);

    for (let r = 0; r < R; r++) {
      const arr = byRank.get(r) || [];
      const info = rankY[r];
      const per = Math.ceil(Math.max(arr.length, 1) / info.k);
      arr.forEach((id, i) => {
        const p = prep(id);
        const sub = Math.floor(i / per);              // 层内第几个子行
        const idx = i % per;                          // 子行里的第几个
        const cnt = Math.min(per, arr.length - sub * per);
        nodes.push({
          id, label: p.lines[0], lines: p.lines, full: id,
          x: (idx - (cnt - 1) / 2) * COL_H,
          y: info.y0 + sub * SUB_H + 14,
          rfc: /^rfc\d+$/i.test(id), bcp: /^(bcp|std|fyi)\d+$/i.test(id),
          rank: r, col: idx, row: sub, tw: p.tw, vh: p.lines.length,
        });
      });
    }
    // 垂直居中：整幅图以 y=0 为中线
    const H2 = (rankY.length ? rankY[rankY.length - 1].y0 + rankY[rankY.length - 1].k * SUB_H : ROW_H);
    for (const n of nodes) n.y -= H2 / 2;

    // 同一子行里，右边那个点若落进左边这条标签的宽度范围，就右推——文字永不重叠
    const rowGroups = new Map();
    for (const n of nodes) {
      const key = n.rank + ':' + n.row;
      if (!rowGroups.has(key)) rowGroups.set(key, []);
      rowGroups.get(key).push(n);
    }
    const span = n => n.tw / 2 + 12;
    for (const arr of rowGroups.values()) {
      arr.sort((a, b) => a.x - b.x);
      let minX = -Infinity;
      for (const n of arr) {
        const need = minX + span(n) + 12;
        if (n.x < need) n.x = need;
        minX = n.x + span(n);
      }
    }

    const byId = new Map(nodes.map(n => [n.id, n]));
    const edges = (data.links || [])
      .map(([s, t, w]) => ({ s: byId.get(s), t: byId.get(t), w }))
      .filter(e => e.s && e.t && e.s !== e.t);
    state.edges = edges;

    // 边：从「引用方」（左）指向「被引用方」（右）。先水平走一小段再拐，
    // 同一段通道里多条边上下分道，否则十几条叠成一根线什么都看不出来
    const laneUsed = new Map();
    for (const e of edges) {
      const key = `${e.s.rank}>${e.t.rank}`;
      const n = laneUsed.get(key) || 0;
      laneUsed.set(key, n + 1);
      const sameRank = e.s.rank === e.t.rank;
      const x1 = e.s.x + 7, x2 = e.t.x - 7;
      const off = ((n % 5) - 2) * LANE;
      const y1 = e.s.y - 8, y2 = e.t.y - 8;     // 圆点的圆心
      let d;
      if (sameRank) {
        // 同层引用（互相更新/补充）：从上面绕过去；第一个走拱形，后面几条往下错开
        const up = n === 0 ? 0 : (n % 2 ? -1 : 1) * LANE * Math.ceil(n / 2);
        const mx = (x1 + x2) / 2, bulge = Math.min(30, 10 + Math.abs(x2 - x1) * 0.22);
        d = `M${x1},${y1} C${mx},${y1 - bulge + up} ${mx},${y2 - bulge + up} ${x2},${y2}`;
      } else {
        // 从圆的左右两侧出发（不出头，免得在点周围糊成一片），中线处再上下分道
        const mx = (x1 + x2) / 2;
        d = `M${x1},${y1} C${mx},${y1 + off} ${mx},${y2 + off} ${x2},${y2}`;
      }
      const path = el('path', {
        d, class: 'kg-edge' + (e.w >= 2 ? ' strong' : ''),
        'marker-end': 'url(#kg-arrow)',
      }, gEdges);
      e.el = path;
    }

    for (const n of nodes) {
      const g = el('g', {
        class: 'kg-node' + (n.rfc ? ' rfc' : ''), 'data-id': n.id,
        transform: `translate(${n.x},${n.y})`,
      }, gNodes);
      el('circle', { r: 4.5, cy: -8 }, g);
      // 圆环把线头盖住：高亮时十几条线从点上散开，中心会糊成一团墨点
      el('circle', { r: 6.2, cy: -8, class: 'kg-halo' }, g);
      const txt = el('text', { x: 0, y: 16, 'text-anchor': 'middle', 'font-size': '12px' }, g);
      (n.lines || [n.label]).forEach((ln, i) => {
        const ts = el('tspan', { x: 0, dy: i ? 13 : 0 }, txt);
        ts.textContent = ln;
      });
      const ttl = el('title', null, g);
      ttl.textContent = n.id;
      n.el = g;
      g.addEventListener('pointerenter', () => { state.hover = n.id; paint(); });
      g.addEventListener('pointerleave', () => { state.hover = null; paint(); });
      g.addEventListener('click', ev => { ev.stopPropagation(); pick(n.id); });
    }

    // 包围盒：直接用浏览器量出来的真实墨水盒。
    // 两个坑（都踩过）：
    //   ① getBBox() 量的是**本地坐标**（还没算 <g> 上的 translate），必须自己加上 n.x/n.y，
    //      否则整幅图被当成"从原点开始"，取景是错的；
    //   ② 点用 getBoundingClientRect（含 translate），再换算回本地——比 getBBox 稳。
    // 之前按"估算字宽"推包围盒，遇到 12px 的 quic-trans… 这种宽标签会差十来个像素，
    // 第一行/最后一行的字就被画布边缘切掉。
    let bx = -1e9, tx = 1e9, by = -1e9, ty = 1e9;
    const k0 = state.t.k || 1;
    const boxRect = viewRect();
    for (const n of nodes) {
      const r = n.el.getBoundingClientRect();       // 屏幕坐标
      const l = (r.left - boxRect.left - state.t.x) / k0;
      const t = (r.top - boxRect.top - state.t.y) / k0;
      const rr = (r.right - boxRect.left - state.t.x) / k0;
      const bb = (r.bottom - boxRect.top - state.t.y) / k0;
      bx = Math.max(bx, rr); tx = Math.min(tx, l);
      by = Math.max(by, t); ty = Math.min(ty, bb);
    }
    if (!(bx > tx)) { bx = 60; tx = -60; by = 20; ty = -20; }   // 量不到（被 display:none 之类）时的兜底
    // 估算包围盒：比实际墨水盒略宽（按"整层排满 outCols 列"算），
    // 这样各层会以同一条中线居中，不会一层偏左、一层偏右
    const gx = ((outCols - 1) / 2) * COL_H + maxW / 2 + 8;
    state.bounds = { x0: -gx, x1: gx, y0: ty, y1: by, wx: bx - tx, wy: by - ty };
    state.geo = { R, perRow, maxK, maxW };
    paint();
    fit();
  }

  function pick(id) {
    state.sel = state.sel === id ? null : id;
    paint();
    onPick(state.sel);
  }

  /** 只改 class，不动坐标——这是"点了不乱"的根本 */
  function paint() {
    const focus = state.sel || state.hover;
    const near = new Set();
    if (focus) {
      near.add(focus);
      for (const e of state.edges) {
        if (e.s.id === focus) near.add(e.t.id);
        if (e.t.id === focus) near.add(e.s.id);
      }
    }
    for (const n of nodes) {
      // 被点亮/相邻的节点提到最上层，别被别的框压住
      const lift = !!focus && near.has(n.id);
      if (lift) gNodes.appendChild(n.el);
      n.el.classList.toggle('on', n.id === focus);
      // 全聚焦模式（选项 focus）：没被选中的点整块淡出，只留焦点和它的邻居——
      // 否则高亮一堆线反而糊成一团，看不出"它到底依赖谁"
      n.el.classList.toggle('far', !!opts.focus && !!focus && !near.has(n.id));
      n.el.classList.toggle('near', !!focus && near.has(n.id) && n.id !== focus);
      n.el.classList.toggle('dim', !!focus && !near.has(n.id));
    }
    for (const e of state.edges) {
      const on = focus && (e.s.id === focus || e.t.id === focus);
      e.el.classList.toggle('on', !!on);
      e.el.classList.toggle('dim', !!focus && !on);
    }
  }

  /** 让某个节点进入视野（诊断页「看图」跳过来时用），不改变缩放比例 */
  function reveal(id) {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    const r = viewRect();
    // 只把节点挪进视野、并保持原缩放：整幅图通常已经一屏放得下，
    // 无脑居中反而会把图推出画布边缘（之前 RFC 9000 就是这样飘到右上角去的）
    const cx = n.x * state.t.k + state.t.x, cy = n.y * state.t.k + state.t.y;
    const m = 60;
    if (cx < m || cx > r.width - m) state.t.x = r.width / 2 - n.x * state.t.k;
    if (cy < m || cy > r.height - m) state.t.y = r.height / 2 - n.y * state.t.k;
    apply();
  }

  // 画布尺寸在挂载那一刻可能还没定型（页面刚插入、滚动条还没出现），
  // 所以每次都重新量，量到 0 就跳过，等 ResizeObserver 再来一次
  function fit() {
    if (!state.bounds) return;
    const r0 = viewRect();
    if (r0.width < 40 || r0.height < 40) return;
    const W = r0.width, H = r0.height;
    // 不靠"估算的包围盒"死算缩放：先按估算铺满，再量**真实墨水盒**
    // （getBoundingClientRect 含字体实际行高、省略号宽度等一切细节），
    // 把溢出比例一次性折进缩放，最后按真实包围盒居中。
    // 估算留白取 0.8 倍：宁可让测量这一步去补，也不要让第一行/最后一行字
    // 正好卡在内容区边上、被取整误差切掉一条。
    const pad = Math.min(28, Math.max(14, Math.min(W, H) * 0.03)) * 0.8;
    const { min } = clampK(W, H);
    const b = state.bounds;
    const cw = Math.max(1, b.x1 - b.x0), ch = Math.max(1, b.y1 - b.y0);
    let k = Math.min(1.35, Math.max(min, Math.min((W - pad * 2) / cw, (H - pad * 2) / ch)));

    const put = kk => {
      state.t.k = kk;
      // 先按估算包围盒的中心摆，循环结束后再按真实包围盒居中一次
      state.t.x = W / 2 - ((b.x0 + b.x1) / 2) * kk;
      state.t.y = H / 2 - ((b.y0 + b.y1) / 2) * kk;
      gRoot.setAttribute('transform', `translate(${state.t.x},${state.t.y}) scale(${kk})`);
    };

    for (let pass = 0; pass < 2; pass++) {
      put(k);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of nodes) {
        const r = n.el.getBoundingClientRect();
        x0 = Math.min(x0, r.left - r0.left); x1 = Math.max(x1, r.right - r0.left);
        y0 = Math.min(y0, r.top - r0.top); y1 = Math.max(y1, r.bottom - r0.top);
      }
      if (!(x1 > x0)) break;
      // 估算包络（整层排满时的宽度）和实测墨水盒取"更宽的那个"：
      // 只按实测缩，会正好卡在边上，两轮之间来回抖
      const gw = Math.max(x1 - x0, (b.wx || 0) * k), gh2 = Math.max(y1 - y0, (b.wy || 0) * k);
      // 精确解：内容尺寸与 k 成正比，所以把"溢出比例"一次性折进 k（按 0.98 留余量）
      let k2 = k * Math.min((W - pad * 2) / Math.max(gw, 1), (H - pad * 2) / Math.max(gh2, 1)) * 0.98;
      // 手机屏：图本来就只能缩到看不清，允许缩到 0.4 先看全（可以放大或点全屏细看）
      k2 = Math.max(0.4, Math.min(k, k2));
      if (Math.abs(k2 - k) < 0.0005) break;
      k = k2;
    }
    // 最后按真实包围盒居中（一次平移，不动缩放）
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const r = n.el.getBoundingClientRect();
      x0 = Math.min(x0, r.left - r0.left); x1 = Math.max(x1, r.right - r0.left);
      y0 = Math.min(y0, r.top - r0.top); y1 = Math.max(y1, r.bottom - r0.top);
    }
    if (x1 > x0) {
      state.t.x += (W - (x0 + x1)) / 2;
      state.t.y += (H - (y0 + y1)) / 2;
    }
    state.t.x = Math.round(state.t.x * 100) / 100;
    state.t.y = Math.round(state.t.y * 100) / 100;
    state.t.k = Math.round(state.t.k * 1000) / 1000;
    apply();
  }

  function apply() {
    gRoot.setAttribute('transform', `translate(${state.t.x},${state.t.y}) scale(${state.t.k})`);
  }

  function zoom(factor, cx, cy) {
    const t = state.t;
    const r = viewRect();
    const mx = (cx == null ? r.width / 2 : cx), my = (cy == null ? r.height / 2 : cy);
    const k2 = Math.min(3, Math.max(0.1, t.k * factor));
    t.x = mx - (mx - t.x) * (k2 / t.k);
    t.y = my - (my - t.y) * (k2 / t.k);
    t.k = k2;
    apply();
  }

  /* 拖拽平移（背景上拖动）+ 滚轮缩放（按时价缩放，不改变图本身的形状） */
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (e.target.closest('.kg-node')) return;
    drag = { x: e.clientX, y: e.clientY, tx: state.t.x, ty: state.t.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('grabbing');
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    state.t.x = drag.tx + (e.clientX - drag.x);
    state.t.y = drag.ty + (e.clientY - drag.y);
    apply();
  });
  const endDrag = () => { drag = null; svg.classList.remove('grabbing'); };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = viewRect();
    zoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  svg.addEventListener('click', () => { if (state.sel) pick(state.sel); });   // 点空白取消选中

  // 只在尺寸真的变了（且用户没手动缩放过）时重新取景，避免"点一下图就重排"
  let lastSize = '';
  const ro = new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    const sig = Math.round(r.width) + 'x' + Math.round(r.height);
    if (sig === lastSize || r.width < 40) return;
    lastSize = sig;
    fit();
  });
  ro.observe(box);

  return {
    setData(data) { place(data); },
    setSelected(id) { state.sel = id && nodes.some(n => n.id === id) ? id : null; paint(); },
    reveal, fit, zoom,
    stats() { return { shown: nodes.length, cut: state.cut || 0, edges: (state.edges || []).length }; },
    destroy() { ro.disconnect(); box.innerHTML = ''; },
  };
}

/** 箭头 marker 只需要注册一次 */
export function ensureArrowDefs() {
  if (document.getElementById('kg-defs')) return;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('id', 'kg-defs');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `<defs><marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"></path></marker></defs>`;
  document.body.appendChild(svg);
}
