/* IETF Atlas — 路由与应用外壳 */
import { getSettings, applyTheme, esc, toast } from './db.js';

export const NAV = [
  ['/graph', '图谱'],
  ['/library', '收藏库'],
  ['/diagnosis', '诊断'],
  ['/settings', '配置'],
  ['/log', '日志'],
  ['/help', '帮助']
];

export const routes = {};
export function route(path, fn) { routes[path] = fn; }

export function navigate(path) {
  if (location.hash.slice(1) === path) return render();
  location.hash = path;
}

export function currentPath() {
  const raw = location.hash.slice(1) || '/graph';
  const path = raw.split('?')[0];
  return routes[path] ? path : '/graph';
}

/** 当前 hash 里的查询参数（图谱页用 ?tab= 切换二级视图） */
export function currentQuery() {
  const raw = location.hash.slice(1);
  return new URLSearchParams(raw.split('?')[1] || '');
}

const NAV_ALIAS = {
  '/map': '/graph', '/atlas': '/graph', '/relations': '/graph', '/path': '/graph',
  '/gaps': '/diagnosis', '/reports': '/diagnosis', '/read': '/library',
};

export function renderHeader() {
  const cur = NAV_ALIAS[currentPath()] || currentPath();
  const curLabel = (NAV.find(([p]) => p === cur) || NAV[0])[1];
  return `
  <header class="app">
    <a class="brand" href="#/graph" title="IETF 文稿地图">
      <span class="mark">IA</span>
      <span class="brand-txt">IETF Atlas<br><small>标准与草案知识地图</small></span>
    </a>
    <div class="navmenu" id="navmenu">
      <button class="navbtn" id="navbtn" aria-haspopup="menu" aria-expanded="false" title="切换视图">
        <span class="navbtn-ico">▤</span><span id="navbtn-label">${curLabel}</span><span class="caret">▾</span>
      </button>
      <div class="navlist" role="menu" id="navlist" hidden>
        <div class="navlist-t">切换视图</div>
        ${NAV.map(([p, label]) => `<a role="menuitem" href="#${p}" class="${p === cur ? 'on' : ''}">
          <span>${label}</span>${p === cur ? '<span class="tick">✓</span>' : ''}</a>`).join('')}
      </div>
    </div>
    <div class="header-right">
      <span class="badge-unofficial" title="本应用为第三方视图，非 IETF 官方产品">Unofficial</span>
      <button class="btn sm" id="theme-toggle" aria-label="切换主题" title="切换深色 / 浅色">主题</button>
    </div>
  </header>`;
}

export function renderFooter() {
  return `
  <footer style="border-top:1px solid var(--border);margin-top:40px;padding:16px 20px;color:var(--fg-muted);font-size:12px">
    <div>数据来源：<a href="https://datatracker.ietf.org" target="_blank" rel="noopener">IETF Datatracker</a> 公开 API。
    本站为第三方视图，<strong>与 IETF、IETF Trust、IETF LLC 无关联，未获其背书</strong>；文档版权归原作者与 IETF Trust 所有，
    引用内容仅为元数据与摘要节选，全文请以 ietf.org 官方为准。</div>
    <div style="margin-top:6px">© ${new Date().getFullYear()} IETF Atlas · <a href="#/about">关于与法律声明</a></div>
  </footer>`;
}

let _globalBound = false;

function bindHeader() {
  const btn = document.getElementById('navbtn');
  const list = document.getElementById('navlist');
  if (btn && list) {
    const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = list.hidden;
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    list.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
    if (!_globalBound) {
      document.addEventListener('click', () => {
        const l = document.getElementById('navlist'), b = document.getElementById('navbtn');
        if (l && !l.hidden) { l.hidden = true; b?.setAttribute('aria-expanded', 'false'); }
      });
      document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const l = document.getElementById('navlist');
        if (l && !l.hidden) { l.hidden = true; document.getElementById('navbtn')?.setAttribute('aria-expanded', 'false'); }
      });
      _globalBound = true;
    }
  }
  document.getElementById('theme-toggle')?.addEventListener('click', async () => {
    const s = await getSettings();
    const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    const { setSettings } = await import('./db.js');
    await setSettings({ theme: next });
    document.dispatchEvent(new Event('themechange'));
    toast(next === 'dark' ? '已切换为深色' : '已切换为浅色');
  });
}

/** 所有表格统一外套一层横向滚动容器：窄屏不挤压、不重叠，可以左右拖 */
function wrapTables() {
  document.querySelectorAll('table').forEach(t => {
    const p = t.parentElement;
    if (p && p.classList.contains('table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    p.insertBefore(w, t);
    w.appendChild(t);
  });
}

let _rendering = false;
export async function render() {
  if (_rendering) return;
  _rendering = true;
  try {
    const s = await getSettings();
    applyTheme(s.theme);
    document.title = `${s.domainPrefix}.${s.rootDomain} · IETF Atlas`;
    const path = currentPath();
    document.body.innerHTML = renderHeader() + '<main id="view"></main>' + renderFooter();
    bindHeader();
    const view = document.getElementById('view');
    const fn = routes[path];
    await fn(view);
    wrapTables();
    window.scrollTo(0, 0);
  } finally {
    _rendering = false;
  }
}

export async function boot() {
  window.addEventListener('hashchange', render);
  document.addEventListener('themechange', () => {});
  if (!location.hash) location.hash = '/graph';
  await render();
  // 注册 Service Worker
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

export { esc };
