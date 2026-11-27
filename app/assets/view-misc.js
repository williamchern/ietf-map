/* IETF Atlas — 数据源 / 配置 / 日志 / 帮助 / 关于 */
import { esc, toast, log, db, getSettings, setSettings, DEFAULT_SETTINGS, fmtDate, relTime } from './db.js';
import { index, getAssets, loadSnapshot } from './data.js';
import {
  authUser, isAdmin, session, changePassword, logout, listUsers,
  createUser, resetUserPassword, deleteUser, auditEvents,
} from './auth.js';
import { mountRecover, diagnose } from './recover.js';

/** 开场自检：收藏是空的就看看这台机器里是不是还有别的库，把结论直接放到页面最上面 */
export async function emptyBanner() {
  const view = document.getElementById('view');
  if (!view || document.getElementById('data-banner')) return;
  let mine = 0;
  try { mine = (await db.all('assets')).length; } catch { /* ignore */ }
  if (mine) return;                                        // 有收藏就不用提醒
  let d;
  try { d = await diagnose(); } catch { return; }
  const others = d.dbs.filter(x => !x.current && !x.error && x.counts.assets > 0);
  const total = d.dbs.reduce((n, x) => n + (x.error ? 0 : x.counts.assets), 0);
  const box = document.createElement('div');
  box.id = 'data-banner';
  box.className = 'data-banner';
  box.dataset.mode = others.length ? 'found' : 'empty';
  box.innerHTML = others.length
    ? `<div class="banner-body"><strong>这台机器里还有 ${others.reduce((n, x) => n + x.counts.assets, 0)} 条收藏在别的库里</strong>
        <span>（${others.map(x => `<code>${esc(x.name)}</code> ${x.counts.assets} 条`).join('、')}）。
        当前账号是空库，可以去配置页合并回来。</span></div>
       <a class="btn sm" href="#/settings">去配置页找回</a>`
    : `<div class="banner-body"><strong>这个账号下还没有收藏</strong>
        <span>本机只剩当前这个库（${total} 条），说明数据不在这台浏览器里了。
        ${d.used > 200 * 1048576 ? `存储占用 ${(d.used / 1048576).toFixed(0)} MB，主要是站点缓存，不是收藏。` : ''}
        旧数据只能从你导出的备份 JSON 恢复。</span></div>
       <div class="row"><button class="btn sm" id="banner-diag">复制体检结果</button><a class="btn sm" href="#/settings">配置页</a></div>`;
  box.querySelector('#banner-diag')?.addEventListener('click', async () => {
    const lines = [
      `地址：${d.origin} · ${d.pwa ? '独立窗口' : '标签页'}`,
      `已用 ${(d.used / 1048576).toFixed(1)} MB · 持久存储 ${d.persisted ? '已开启' : '未开启'} · SW ${d.sw ? '已接管' : '未接管'}`,
      ...d.dbs.map(x => `${x.name}${x.current ? '(当前)' : ''}：${x.error ? '打不开' : x.counts.assets + ' 条收藏'}`),
    ].join('\n');
    try { await navigator.clipboard.writeText(lines); toast('体检结果已复制'); } catch { toast('复制失败'); console.log(lines); }
  });
  const main = view.querySelector('main') || view;
  main.insertBefore(box, main.firstChild);
}

const ACTIONS = {
  'star-doc': '收藏文稿', 'unstar-doc': '移除文稿', 'star-group': '关注组', 'unstar-group': '取消关注组',
  'note-doc': '保存笔记', 'report-generate': '生成报告', 'report-export': '导出报告',
  'export-backup': '导出备份', 'import-backup': '导入备份', 'settings-save': '修改配置',
  'data-refresh': '刷新数据源', 'data-clear': '清空本地数据', 'domain-change': '修改域名',
  'login': '登录', 'logout': '退出登录', 'password-change': '修改密码',
  'user-create': '新建账号', 'user-reset': '重置密码', 'user-delete': '删除账号',
  'auth-login': '登录（服务端）', 'auth-login-fail': '登录失败（服务端）',
  'auth-login-lock': '登录锁定', 'data-migrate': '迁移旧数据', 'data-restore': '恢复本机数据'
};

export async function viewLog(root) {
  root.className = '';
  const logs = (await db.all('logs')).sort((a, b) => b.ts - a.ts);
  root.innerHTML = `
    <h1>日志</h1>
    <p class="sub">本机操作只记在这台浏览器；登录 / 账号变更另有一份服务端审计，仅管理员可见。</p>
    <div class="row" style="margin-bottom:12px">
      <input type="search" id="q" placeholder="过滤动作或内容…" style="max-width:320px">
      <span class="spacer"></span>
      <button class="btn" id="exp">导出日志 (CSV)</button>
      <button class="btn danger" id="clr">清空日志</button>
    </div>
    <div class="card"><div id="logbox">
      ${logs.length ? logs.map(l => `<div class="log-row" data-t="${esc((ACTIONS[l.action] || l.action) + ' ' + l.detail)}">
        <span class="mono hint">${esc(new Date(l.ts).toISOString().slice(0, 19).replace('T', ' '))}</span>
        <span><span class="label">${esc(ACTIONS[l.action] || l.action)}</span></span>
        <span class="mono">${esc(l.detail)}</span></div>`).join('') : '<div class="empty"><strong>暂无日志</strong>开始使用后，这里会记录你的每一次操作。</div>'}
    </div></div>
    ${isAdmin() ? `<div class="card"><div class="head">服务端审计（登录与账号）</div>
      <div class="body" id="audit-box"><span class="hint">正在读取…</span></div></div>` : ''}`;
  root.querySelector('#q').addEventListener('input', e => {
    const s = e.target.value.toLowerCase();
    root.querySelectorAll('.log-row').forEach(r => r.style.display = r.dataset.t.toLowerCase().includes(s) ? '' : 'none');
  });
  root.querySelector('#clr').addEventListener('click', async () => {
    if (!confirm('清空全部日志？此操作不可撤销。')) return;
    await db.clear('logs'); viewLog(root);
  });
  root.querySelector('#exp').addEventListener('click', () => {
    const csv = ['time,action,detail', ...logs.map(l => `${new Date(l.ts).toISOString()},${ACTIONS[l.action] || l.action},"${(l.detail || '').replace(/"/g, '""')}"`)].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = `ietf-atlas-log-${fmtDate(Date.now())}.csv`; a.click();
  });

  // 服务端审计：只读，改不了（改了就失去审计意义）
  const box = root.querySelector('#audit-box');
  if (box) {
    const events = await auditEvents();
    const NAME = {
      'seed': '初始化', 'login': '登录成功', 'login-fail': '登录失败', 'login-lock': '触发锁定',
      'logout': '退出', 'password-change': '改密码', 'user-create': '新建账号',
      'user-reset': '重置密码', 'user-delete': '删除账号',
    };
    box.innerHTML = events.length ? `<div class="log-list">${events.slice().reverse().map(e => `
      <div class="log-row">
        <span class="mono hint">${esc(new Date(e.ts).toISOString().slice(0, 19).replace('T', ' '))}</span>
        <span><span class="label ${e.action === 'login-fail' || e.action === 'login-lock' ? 'red' : ''}">${esc(NAME[e.action] || e.action)}</span></span>
        <span class="mono">${esc(e.detail || '')}</span>
      </div>`).join('')}</div>` : '<span class="hint">还没有账号相关的事件。</span>';
  }
}

export async function viewData(root) {
  root.className = '';
  const idx = await index();
  const m = idx.snap.meta;
  const groupsByType = {};
  for (const g of idx.snap.groups) groupsByType[g.type] = (groupsByType[g.type] || 0) + 1;
  const relByType = {};
  for (const r of idx.snap.rels) relByType[r[1]] = (relByType[r[1]] || 0) + 1;

  root.innerHTML = `
    <h1>数据源</h1>
    <p class="sub">本应用的全部事实均来自 IETF Datatracker 公开 API，构建期生成静态快照，运行时不回传任何数据。</p>
    <div class="grid c2">
      <div class="card"><div class="head">快照信息</div><div class="body">
        <table>
          <tr><th>生成时间</th><td class="mono">${esc(m.generated)}</td></tr>
          <tr><th>源</th><td><a href="https://datatracker.ietf.org/api/" target="_blank" rel="noopener">datatracker.ietf.org/api</a></td></tr>
          <tr><th>组织实体</th><td class="mono">${m.groups.toLocaleString()} 组</td></tr>
          <tr><th>文稿条目</th><td class="mono">${m.docs.toLocaleString()}</td></tr>
          <tr><th>关系边</th><td class="mono">${m.rels.toLocaleString()}</td></tr>
          <tr><th>快照大小</th><td class="mono">${(m.bytes / 1024 / 1024).toFixed(2)} MB</td></tr>
        </table>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="refresh">检查更新并刷新缓存</button>
          <span class="hint" id="rs"></span>
        </div>
        <p class="hint">刷新只会重新向本站请求快照文件；快照本身由构建脚本 <code>scripts/fetch.py</code> 从 Datatracker 生成。</p>
      </div></div>
      <div class="card"><div class="head">组类型分布</div><div class="body">
        <table>${Object.entries(groupsByType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `<tr><th class="mono">${esc(k)}</th><td class="num">${v}</td></tr>`).join('')}</table>
      </div></div>
    </div>
    <div class="card"><div class="head">关系类型分布（已裁剪，仅保留有语义的引用/演进关系）</div>
      <div class="body"><table>${Object.entries(relByType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><th class="mono">${esc(k)}</th><td class="num">${v.toLocaleString()}</td></tr>`).join('')}</table></div></div>
    <div class="card"><div class="head">口径说明</div><div class="body hint">
      <ul>
        <li><b>为什么不含过期/废弃草案的正文条目？</b> 快照只保留 draft/rfc 类型且状态非 expired/replaced/dead 的条目，以避免图谱被历史噪音淹没；你已收藏的过时项仍会被标记。</li>
        <li><b>为什么只保留部分关系？</b> Datatracker 全量关系约 59 万条，其中十余万条为 <code>contains</code> 等结构关系，与知识地图无关。</li>
        <li><b>被引次数</b> = 快照内指向该文稿的关系边数量，用于估计"枢纽度"，<i>不是</i> IETF 官方指标。</li>
      </ul></div></div>
  `;
  root.querySelector('#refresh').addEventListener('click', async () => {
    const s = document.getElementById('rs');
    s.textContent = '正在拉取…';
    try {
      const r = await fetch('./data/snapshot.json?t=' + Date.now(), { cache: 'reload' });
      const j = await r.json();
      await db.put('settings', { key: 'snapshot-cache', data: j });
      s.textContent = `已更新：${j.meta.generated}`;
      await log('data-refresh', j.meta.generated);
      setTimeout(() => location.reload(), 800);
    } catch (e) { s.textContent = '失败：' + e.message; }
  });
}

export async function viewSettings(root) {
  root.className = '';
  const s = await getSettings();
  const host = `${s.domainPrefix}.${s.rootDomain}`;
  const me = authUser();
  const admin = isAdmin();
  root.innerHTML = `
    <h1>配置</h1>
    <p class="sub">界面与数据设置保存在本机浏览器；账号由本站服务器统一校验。</p>

    <div class="card"><div class="head">账号与安全</div><div class="body">
      <div class="row" style="margin-bottom:14px">
        <span class="label ${admin ? 'blue' : 'green'}">${admin ? '管理员' : '普通账号'}</span>
        <b class="mono">${esc(me?.name || '')}</b>
        ${session.offline ? '<span class="label yellow" title="这次没能连上服务器，用的是本机缓存的登录状态">离线</span>' : ''}
        <span class="spacer"></span>
        <button class="btn sm" id="pw-toggle">修改密码</button>
        <button class="btn sm" id="signout">退出登录</button>
      </div>
      <form id="pw-form" hidden style="max-width:360px">
        <label class="field"><span>当前密码</span><input type="password" id="pw-old" autocomplete="current-password"></label>
        <label class="field"><span>新密码（至少 8 位）</span><input type="password" id="pw-new" autocomplete="new-password"></label>
        <label class="field"><span>再输一次</span><input type="password" id="pw-new2" autocomplete="new-password"></label>
        <div class="row"><button class="btn primary" type="submit" id="pw-go">保存新密码</button>
          <span class="hint" id="pw-msg"></span></div>
        <p class="hint" style="margin:8px 0 0">改完之后其他设备上的登录会立即失效，需要重新登录。</p>
      </form>
      <p class="hint" id="pw-note" style="margin:14px 0 0">密码只以加盐散列（PBKDF2-SHA256）存在服务器上，任何页面都读不到明文；
        忘记密码只能由管理员重置。</p>
    </div></div>

    ${admin ? `<div class="card"><div class="head">账号管理（仅管理员）</div><div class="body">
      <div id="users-box" class="hint">正在读取…</div>
      <div class="sub-head">新建账号</div>
      <form id="new-user" style="max-width:460px">
          <div class="grid c2" style="gap:10px">
            <label class="field"><span>账号名</span><input type="text" id="nu-name" placeholder="3–24 位，字母数字 . _ -" autocomplete="off"></label>
            <label class="field"><span>初始密码</span><input type="password" id="nu-pw" placeholder="至少 8 位" autocomplete="new-password"></label>
          </div>
          <div class="grid c2" style="gap:10px">
            <label class="field"><span>角色</span>
              <select id="nu-role"><option value="user">普通账号</option><option value="admin">管理员</option></select></label>
            <label class="field"><span>备注（可选）</span><input type="text" id="nu-note" placeholder="给谁用、做什么" maxlength="60"></label>
          </div>
          <div class="row"><button class="btn primary" type="submit" id="nu-go">创建账号</button>
            <span class="hint" id="nu-msg"></span></div>
          <p class="hint" style="margin:8px 0 0">新账号第一次登录会被要求改密码。各账号的收藏与笔记互相隔离。</p>
      </form>
    </div></div>` : ''}

    <div class="grid c2">
      <div class="card"><div class="head">发布域名</div><div class="body">
        <label class="field"><span>APP 前缀（可改）</span>
          <div class="row"><input type="text" id="prefix" value="${esc(s.domainPrefix)}" style="max-width:160px"><span class="hint">.${esc(s.rootDomain)}</span></div>
          <em>当前站点名：<code id="pv">${esc(host)}</code>。改名只影响界面显示与文档标题，不会改变实际访问地址（实际地址由部署平台决定）。</em>
        </label>
        <label class="field"><span>根域（部署时固定）</span>
          <input type="text" id="root" value="${esc(s.rootDomain)}">
          <em>推荐 <code>ietfmap.app</code>：<code>.app</code> 顶级域强制 HTTPS，语义即"应用"，适合 PWA。</em>
        </label>
        <div class="row"><button class="btn primary" id="save-domain">保存域名</button>
          <span class="hint">候选：atlas / map / std / wg / ietf</span></div>
      </div></div>

      <div class="card"><div class="head">外观</div><div class="body">
        <label class="field"><span>主题</span>
          <select id="theme">
            <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>跟随系统</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>浅色</option>
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>深色</option>
          </select></label>
        <p class="hint" style="margin:8px 0 0">图谱的领域切换与缩放按钮在图谱页顶部工具条里，不在这里设置。</p>
      </div></div>
    </div>

    <div class="card"><div class="head">关系解读（大模型）</div><div class="body">
      <p class="hint" style="margin-top:0">用于对某一组组间引用做归纳（在图谱右侧详情里触发）。<b>模型只能看到已抓取的真实引用边</b>，
      每条结论必须携带证据编号，无证据的结论文本会被自动丢弃。留空 Key 则使用本地统计归纳，完全不联网。</p>
      <label class="field"><span>API 地址</span>
        <input type="text" id="llmBase" class="mono" value="${esc(s.llmBase || '')}" placeholder="https://api.openai.com/v1">
        <em>兼容 OpenAI 格式的任意端点（含自建网关、Azure、本地 Ollama：<code>http://localhost:11434/v1</code>）。</em></label>
      <label class="field"><span>API Key</span>
        <input type="password" id="llmKey" class="mono" value="${esc(s.llmKey || '')}" placeholder="sk-...">
        <em>只保存在本浏览器 IndexedDB，不会上传到本站服务器。共用设备请勿填写。</em></label>
      <label class="field"><span>模型</span>
        <input type="text" id="llmModel" class="mono" value="${esc(s.llmModel || 'gpt-4o-mini')}" placeholder="gpt-4o-mini"></label>
      <div class="row"><button class="btn primary" id="save-llm">保存</button>
        <button class="btn" id="test-llm">测试连接</button>
        <span class="hint" id="llm-msg"></span></div>
    </div></div>

    <div class="card"><div class="head">自动化</div><div class="body">
      <label class="check"><input type="checkbox" id="auto" ${s.autoReport ? 'checked' : ''}> 每周自动生成分析报告</label>
      <label class="field" style="margin-top:10px;max-width:320px"><span>Cron 表达式</span>
        <input type="text" id="cron" value="${esc(s.autoReportCron)}" class="mono"></label>
      <div class="hint" style="margin-bottom:10px">本应用是纯静态 PWA，定时任务需部署端配合。部署后添加如下 GitHub Actions 定时任务即可（每日 09:00 UTC）：</div>
      <pre class="report-pre" style="max-height:220px"># .github/workflows/atlas.yml
on:
  schedule:
    - cron: '${s.autoReportCron}'
  workflow_dispatch:
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/fetch.py
      - run: npx wrangler pages deploy app --project-name ietf-atlas</pre>
    </div></div>

    <div class="card"><div class="head">数据源</div><div class="body row">
      <a class="btn" href="#/data">查看快照版本与口径说明</a>
      <span class="hint">快照由 <code>scripts/fetch.py</code> 从 Datatracker 公开 API 生成。</span>
    </div></div>

    <div class="card"><div class="head">找回数据</div><div class="body">
      <p class="hint" style="margin:0 0 10px">收藏存在<b>这台浏览器</b>里，按账号分库。换账号、换浏览器、清站点数据之后看到的都是空库——
      但原来那份可能还留在本机。扫一下就知道。</p>
      <div class="hint warn" id="db-tip" hidden style="margin:0 0 10px"></div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn" id="db-scan">扫描本机历史数据</button>
        <button class="btn" id="db-diag">复制体检结果</button>
        <button class="btn" id="db-export">导出备份 JSON</button>
        <button class="btn" id="db-import">导入备份 JSON</button>
        <input type="file" id="db-file" accept="application/json" hidden>
      </div>
      <div id="db-list"></div>
      <div class="hint" id="store-info" style="margin-top:10px"></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="db-persist" hidden>开启持久存储</button></div>
    </div></div>

    <div class="card"><div class="head">清空</div><div class="body row">
      <button class="btn danger" id="wipe">清空本地全部数据</button>
      <span class="hint">只清当前账号；清空前先导出备份（备份不含离线正文）。</span>
    </div></div>
  `;

  const save = async patch => { await setSettings(patch); await log('settings-save', JSON.stringify(patch)); toast('已保存'); };
  root.querySelector('#prefix').addEventListener('input', e => {
    root.querySelector('#pv').textContent = `${e.target.value}.${root.querySelector('#root').value}`;
  });
  root.querySelector('#save-domain').addEventListener('click', async () => {
    const prefix = root.querySelector('#prefix').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'atlas';
    await save({ domainPrefix: prefix });
    await log('domain-change', prefix);
    document.title = `${prefix}.${(await getSettings()).rootDomain} · IETF Atlas`;
    location.reload();
  });
  root.querySelector('#theme').addEventListener('change', async e => {
    await save({ theme: e.target.value });
    const { applyTheme } = await import('./db.js');
    applyTheme(e.target.value);
  });
  root.querySelector('#auto').addEventListener('change', e => save({ autoReport: e.target.checked }));
  root.querySelector('#cron').addEventListener('change', e => save({ autoReportCron: e.target.value }));
  root.querySelector('#save-llm').addEventListener('click', async () => {
    await save({
      llmBase: root.querySelector('#llmBase').value.trim(),
      llmKey: root.querySelector('#llmKey').value.trim(),
      llmModel: root.querySelector('#llmModel').value.trim(),
    });
  });
  root.querySelector('#test-llm').addEventListener('click', async () => {
    const msg = root.querySelector('#llm-msg');
    const base = root.querySelector('#llmBase').value.trim().replace(/\/$/, '');
    const key = root.querySelector('#llmKey').value.trim();
    const model = root.querySelector('#llmModel').value.trim();
    if (!key) { msg.textContent = '未填 Key，将使用统计归纳（无需联网）'; return; }
    msg.textContent = '测试中…';
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      });
      msg.textContent = r.ok ? '✓ 连接正常' : `✗ HTTP ${r.status}`;
    } catch (e) {
      msg.textContent = '✗ ' + e.message + '（可能是跨域限制，建议使用自建代理）';
    }
  });
  root.querySelector('#wipe').addEventListener('click', async () => {
    if (!confirm('将清空收藏、日志、报告、设置，以及已下载到本机的离线正文，确认？\n\n导出备份里不含离线正文，清掉就只能重新下载。')) return;
    for (const s2 of ['assets', 'logs', 'reports', 'settings', 'offline']) await db.clear(s2);
    toast('已清空'); setTimeout(() => location.reload(), 600);
  });

  await mountRecover(root);

  /* ---------- 账号与安全 ---------- */

  const pwForm = root.querySelector('#pw-form');
  root.querySelector('#pw-toggle').addEventListener('click', () => {
    pwForm.hidden = !pwForm.hidden;
    if (!pwForm.hidden) root.querySelector('#pw-old').focus();
  });
  root.querySelector('#signout').addEventListener('click', async () => {
    if (!confirm('退出登录？本机收藏不会丢，重新登录同一个账号就能看到。')) return;
    await logout();
    location.reload();
  });
  pwForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = root.querySelector('#pw-msg');
    const old = root.querySelector('#pw-old').value;
    const a = root.querySelector('#pw-new').value;
    const b = root.querySelector('#pw-new2').value;
    msg.textContent = '';
    if (a !== b) { msg.textContent = '两次输入的新密码不一致'; return; }
    try {
      msg.textContent = '保存中…';
      await changePassword(old, a);
      pwForm.reset();
      pwForm.hidden = true;
      const note = root.querySelector('#pw-note');
      if (note) { note.textContent = '✓ 密码刚刚已更新，其他设备上的登录已失效'; note.className = 'hint good'; }
      toast('密码已更新');
    } catch (err) {
      msg.textContent = '✗ ' + err.message;
    }
  });

  if (admin) mountUserAdmin(root);
}

/** 管理员：账号列表 + 重置 / 删除 */
async function mountUserAdmin(root) {
  const box = root.querySelector('#users-box');
  if (!box) return;

  const renderList = async () => {
    let data;
    try {
      data = await listUsers();
    } catch (e) {
      box.innerHTML = `<span class="hint">读不到账号列表：${esc(e.message)}</span>`;
      return;
    }
    const users = data.users || [];
    box.innerHTML = `<div class="table-wrap"><table class="table-plain auth-table">
      <thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th>备注</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr>
        <td class="mono">${esc(u.name)}${u.name === data.me ? ' <span class="label blue">你</span>' : ''}</td>
        <td>${u.role === 'admin' ? '<span class="label blue">管理员</span>' : '<span class="label">普通</span>'}</td>
        <td>${u.must_change ? '<span class="label yellow">待改密码</span>' : '<span class="hint">正常</span>'}</td>
        <td class="hint">${u.last_login ? relTime(u.last_login) : '从未'}</td>
        <td class="hint" style="overflow-wrap:anywhere">${esc(u.note || '—')}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm" data-rst="${esc(u.name)}">重置密码</button>
          ${u.name === data.me ? '' : `<button class="btn sm danger" data-del="${esc(u.name)}">删除</button>`}
        </td></tr>`).join('')}</tbody></table></div>`;

    box.querySelectorAll('[data-rst]').forEach(b => b.addEventListener('click', async () => {
      const name = b.dataset.rst;
      const pw = prompt(`给「${name}」设一个新密码（至少 8 位）。\n对方下次登录会被要求再改一次。`);
      if (!pw) return;
      try {
        await resetUserPassword(name, pw);
        await log('user-reset', name);
        toast('已重置 ' + name + ' 的密码');
        renderList();
      } catch (e) { toast('✗ ' + e.message); }
    }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const name = b.dataset.del;
      if (!confirm(`删除账号「${name}」？\n\n他/她将无法再登录，但本机已有的收藏不会被删除。`)) return;
      try {
        await deleteUser(name);
        await log('user-delete', name);
        toast('已删除 ' + name);
        renderList();
      } catch (e) { toast('✗ ' + e.message); }
    }));
  };

  root.querySelector('#new-user')?.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = root.querySelector('#nu-msg');
    const name = root.querySelector('#nu-name').value.trim();
    const pw = root.querySelector('#nu-pw').value;
    const role = root.querySelector('#nu-role').value;
    const note = root.querySelector('#nu-note').value.trim();
    msg.textContent = '';
    const btn = root.querySelector('#new-user button[type=submit]');
    btn.disabled = true;
    try {
      msg.textContent = '创建中…';
      await createUser(name, pw, role, note);
      await log('user-create', `${name}（${role}）`);
      root.querySelector('#nu-name').value = '';
      root.querySelector('#nu-pw').value = '';
      root.querySelector('#nu-note').value = '';
      msg.textContent = '✓ 已创建，把账号和初始密码告诉对方，首次登录需改密码';
      renderList();
      root.querySelector('#nu-name').focus();   // 连着建下一个
    } catch (err) {
      msg.textContent = '✗ ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  renderList();
}

/* ---------- 静态内容 ---------- */
export async function viewHelp(root) {
  root.className = '';
  const s = await getSettings();
  root.innerHTML = `
    <div class="prose" style="max-width:840px">
    <h1>帮助</h1>
    <p class="sub">两分钟看懂这张地图怎么用。</p>

    <h2>1. 它只回答三个问题</h2>
    <ul>
      <li><b>我关心的文稿之间，有没有关系？是什么关系？</b>——规范引用（技术硬依赖）还是信息性引用（背景参考），谁指向谁。</li>
      <li><b>我关心的文稿，引用了哪些我还没读的文稿和标准？</b>——一条条列出来，点一下就能收进地图，关系自动连上。</li>
      <li><b>我还漏了什么？</b>——诊断页把「该补哪几份」按优先级列成一张清单，每行都有理由。</li>
    </ul>
    <p class="hint">不做宏大叙事：没有评分排名，没有"知识全景"，只有你手边这几份文稿的事实。</p>

    <h2>2. 账号与登录</h2>
    <p>打开应用先要登录。账号由<b>本站服务器</b>校验，密码只以加盐散列（PBKDF2-SHA256）存在服务器上，页面读不到明文。</p>
    <table>
      <tr><th>事项</th><th>说明</th></tr>
      <tr><td>初始账号</td><td><code>admin</code> / <code>admin</code>，<b>登录后必须改密码</b>才能进</td></tr>
      <tr><td>改自己的密码</td><td>配置 → 账号与安全 → 修改密码。改完其他设备上的登录立即失效</td></tr>
      <tr><td>加账号</td><td>管理员在 配置 → 账号管理 里新建，填账号名 + 初始密码，选「普通」或「管理员」</td></tr>
      <tr><td>忘了密码</td><td>只能由管理员重置；重置后对方下次登录要再改一次</td></tr>
      <tr><td>退出</td><td>顶栏右侧「退出」，或配置页「退出登录」</td></tr>
      <tr><td>登录保持</td><td><b>30 天</b>：登录一次，一个月内打开就能直接用；只要期间来过，到期时间会自动往后顺延，等于"连续 30 天不来才要重新登录"。公用电脑上用完请点「退出」</td></tr>
    </table>
    <p class="hint">收藏、笔记、离线正文仍然<b>存在各自浏览器里</b>，按账号分开：同一台设备换个人登录，看到的是他/她自己的收藏。
    账号是"门禁"，不是加密保险箱——真要保密，请用带加密的设备与浏览器配置。</p>
    <p class="hint">从旧版本升级的：只有<b>升级后第一个登录的账号</b>会接手原来那份收藏（通常就是你自己）；
    之后新建的账号都是空的，不会复制别人的收藏。</p>
    <p class="hint">断网时用的是本机缓存的登录状态（同样 30 天），离线阅读照常；缓存过期后需要联网重新登录一次。</p>

    <h2>3. 收藏会不会丢</h2>
    <p>收藏、笔记、离线正文都只存在<b>这台浏览器</b>里（IndexedDB），按账号分库。服务器只存账号凭据，不存你的收藏——
    所以 <b>GitHub 仓库里也没有</b>，从代码仓库恢复不出来。</p>
    <table>
      <tr><th>看起来"丢了"</th><th>怎么回事</th></tr>
      <tr><td>换了账号登录</td><td>每个账号一个独立的库；换个人登录看到的是他/她的库</td></tr>
      <tr><td>换浏览器 / 换设备 / 隐私窗口</td><td>数据跟着浏览器走，不跨设备同步</td></tr>
      <tr><td>清了站点数据、清了缓存</td><td>IndexedDB 一起被删</td></tr>
      <tr><td>iPhone / iPad 上的 Safari</td><td>超过 7 天没访问，系统会清掉本站的本地数据</td></tr>
      <tr><td>磁盘紧张</td><td>浏览器可能回收"不常用站点"的存储</td></tr>
    </table>
    <p><b>怎么找回来：</b>配置 → 找回数据 → <b>扫描本机历史数据</b>。它会列出这台浏览器里所有 <code>ietf-atlas*</code> 库以及各自有多少条收藏，
    哪份有数就点「恢复到此账号」合并过来（只加不删，源库原样保留）。以前导出过 JSON 的，用「导入备份 JSON」。</p>
    <p class="hint">升级到账号版时，旧版本那份公共库是<b>原样留着</b>的，没有删——现在的库如果是空的，扫描通常能看见它。</p>
    <p><b>先看结论：</b>收藏是空的时候，页面顶部会自动出一条提示，直接写清「本机只剩当前这个库、几条」，或者「还有 N 条在别的库里，去配置页合并」。
    不用自己判断。要细看就点<b>复制体检结果</b>，把那段文字发给管理员即可。</p>
    <p><b>以后别再丢：</b>① 每周点一次「导出备份 JSON」，文件存网盘；② 点「开启持久存储」，让浏览器别在空间紧张时回收；
    ③ 加到主屏或书签，别让 Safari 判定为"久未访问"；④ 换浏览器前先导出。</p>

    <h2>4. 怎么切换视图</h2>
    <p>顶栏左上角是<b>视图下拉</b>：点一下展开竖排菜单，选哪个进哪个，不用在横排标题里一个个找。</p>
    <p class="hint">地址栏里的 hash 会跟着变（<code>#/graph</code>、<code>#/library</code>…），收藏夹里存哪个视图都行。</p>

    <h2>5. 图谱怎么读</h2>
    <p>只有一幅图，回答一个问题：<b>这个技术领域里，谁建立在谁之上。</b></p>
    <table>
      <tr><th>你看到的</th><th>意思</th></tr>
      <tr><td>方框 = 一份文稿</td><td>粗边框＝已经发成 RFC；细边框＝草案；<b>绿色底</b>＝你已经收藏了它</td></tr>
      <tr><td>箭头 = 一条引用</td><td>从<b>引用方</b>指向<b>被引用方</b>；实线＝规范性引用（硬依赖），虚线＝信息性引用（背景参考）</td></tr>
      <tr><td>列 = 层次</td><td>越靠左越像"地基"（被更多文稿依赖），越靠右越像"新工作"（建立在别人之上）</td></tr>
      <tr><td>图上的形状是固定的</td><td>坐标由数据离线算好，刷新、缩放、全屏都不会变——同一个领域永远是同一张图</td></tr>
    </table>
    <p class="hint">选哪个领域，用左上角的下拉框。领域 = IETF 的工作组 / 研究组，图里是它内部的文稿引用。
    下拉里<b>只出现你收藏的草案所在的工作组</b>——全站几十个组跟你没关系，列出来只是噪声。</p>

    <h2>6. 推荐使用顺序</h2>
    <ol>
      <li>先把你在读的 <b>3–8 份文稿</b>加进来（只加<b>真的读过</b>的，别加待读清单）。</li>
      <li><a href="#/graph">图谱</a>里只有你收藏的组，选一个看这张领域图：哪些是地基，哪些建立在它之上。</li>
      <li>点图上任意一个节点，旁边（全屏时在下方）会列出它依赖谁、谁依赖它——缺的那份直接「收藏进地图」。</li>
      <li>去 <a href="#/diagnosis">诊断</a> 看 ①「你引用了但没读」：读了结论、没读依据的那部分，性价比最高；每行都有「看图」能跳回图上定位。</li>
      <li>收藏库按组归类，<b>「已收 / 组内总数」</b>直接告诉你哪块还有空白。</li>
    </ol>

    <h2>7. 关系解读为什么不会瞎编</h2>
    <p>可选的模型归纳有一条硬约束：<b>模型只能看到已抓取的真实引用边，每条结论必须挂证据编号</b>。
    输出后前端会校验编号，对不上一律丢弃并标出丢弃条数。没有配置 API Key 时自动改用本地统计归纳（纯规则计算，结论可复现）。</p>
    <p class="hint">所以不会出现"这两个组有关系，因为都涉及能源"这种没有证据的推测。</p>

    <h2>8. 诊断页四个分区</h2>
    <p>诊断页不讲评分，只按「补了最有用」的顺序排四段：</p>
    <table>
      <tr><th>分区</th><th>判定规则</th><th>为什么排这个顺序</th></tr>
      <tr><td>① 你引用了但没读</td><td>已收藏文稿的<b>规范性</b>引用目标不在收藏内（已滤掉被 800+ 份文稿引用的通用规范）</td><td>读了结论没读依据，是最容易高估自己的地方，所以排第一</td></tr>
      <tr><td>② 组里有你没收</td><td>你在这个组有收藏、组内被引最高的活跃文稿（每组最多 6 条，与①不重复）</td><td>组内必修课，按需补</td></tr>
      <tr><td>③ 已过期 / 被替代</td><td>收藏项状态为过期、废弃或被新版替代</td><td>引用它们会直接出错</td></tr>
      <tr><td>④ 关注了但没读的组</td><td>关注了组，组内 0 篇收藏</td><td>要么补一份，要么取关，别让收藏库虚胖</td></tr>
    </table>

    <h2>9. 操作速查</h2>
    <ul>
      <li>图中<b>滚轮缩放</b>、<b>拖拽空白处平移</b>；点空白处取消选中</li>
      <li>右上角<b>「全屏」</b>是真的全屏：页眉、页脚、侧栏都收起，只剩图和详情；<b>Esc</b> 或「退出全屏」回来</li>
      <li>点一个节点会点亮它和它的邻居，<b>点的瞬间位置不会动</b>——再点另一个就换过去</li>
      <li>收藏库表格现在只有四列，手机上自动收起标题列，<b>不用横滑</b>就能看全</li>
      <li>添加时可直接粘贴 Datatracker 链接，会自动去掉版本号与大小写差异</li>
      <li>快照里没有的文稿会实时向 Datatracker 查一次（需要联网）</li>
      <li>数据全在本机：换浏览器 / 清缓存会丢，请定期「导出 JSON 备份」</li>
      <li>收藏库里点<b>文稿名</b>就是选版本：读本机副本、下载到本机，或者在线看一次</li>
    </ul>

    <h2>10. 离线下载与阅读</h2>
    <p>收藏库每一行只有两个入口：<b>点文稿名</b>、点右边的<b>「管理」</b>。两个都打开同一张「版本」面板，
    在里面挑版本（草案有 00 到最新，RFC 只有一版），再决定这一版怎么处理：</p>
    <ul>
      <li><b>下载到本机</b>：把官方正文存进浏览器数据库，断网也能读；面板里能看到每一版占多少空间。</li>
      <li><b>在线看</b>：现在就读，<b>不占本机空间</b>，但需要联网；标题旁会标「在线」，想留着点「存到本机」。</li>
      <li><b>开始阅读</b>：本机已存的那一版直接打开，秒开、不联网。</li>
    </ul>
    <p>已存的版本在行尾标「已存 44 KB」，收藏库列表里也会标「离线 N」。面板打开不等网络：先按本地快照把版本列出来，再在后台核对有没有新版。</p>
    <ul>
      <li>正文来自 IETF 官方（<code>rfc-editor.org</code> / <code>ietf.org/archive</code>），只去掉了每页重复的页眉页脚，内容一字不改。</li>
      <li>手机上是原文 72 列版式，<b>左右滑动</b>看完整行——强行折行会把标题和缩进拆散，更难读。</li>
      <li>同一篇存了多版时，阅读器顶部有<b>版本切换</b>，不用回收藏库。</li>
      <li>占多少空间看顶部「离线管理」：能逐份删，也能一键清空。</li>
      <li>删除收藏时会先问一句：<b>只移除收藏</b>，还是<b>连同本机离线副本一起删</b>。</li>
      <li>正文只是只读缓存；引用与转载仍以官方发布版本为准，别把缓存当权威副本。</li>
    </ul>

    <h2>11. 安装为应用</h2>
    <p>Chrome / Edge 地址栏右侧点"安装"，或 iOS Safari「分享 → 添加到主屏幕」。安装后快照本地缓存，可离线查看已收藏内容。</p>

    <h2>12. 法律与商标</h2>
    <blockquote>
      IETF Atlas 是<b>第三方非官方工具</b>，与 IETF Trust、IETF LLC、IESG 无任何隶属或背书关系。
      本站不镜像 IETF 全文文档，仅展示元数据与摘要节选，并链接至 ietf.org 原文。
      "IETF"、"Internet-Draft"、"RFC" 等标识的使用仅为事实性指代。
    </blockquote>
    <p>详见 <a href="#/about">关于与法律声明</a>。当前站点名称：<code>${esc(s.domainPrefix)}.${esc(s.rootDomain)}</code>。</p>
    </div>`;
}

export async function viewAbout(root) {
  root.className = '';
  root.innerHTML = `
  <div class="prose" style="max-width:820px">
    <h1>关于与法律声明</h1>
    <p class="sub">这是使用 IETF 内容前必须看清楚的一页。</p>

    <h2>一、性质</h2>
    <p>IETF Atlas（下称"本应用"）是一个<b>个人知识管理工具</b>，以只读方式消费 IETF Datatracker 的公开 API，
    帮助使用者组织自己关心的草案与标准。本应用<b>不代表 IETF</b>，不是 IETF 的官方服务，
    也未获得 IETF Trust / IETF LLC 的授权、赞助或背书。</p>

    <h2>二、内容与版权</h2>
    <ul>
      <li>IETF 文档（Internet-Drafts 与 RFC）的版权归其作者及 <a href="https://trustee.ietf.org/" target="_blank" rel="noopener">IETF Trust</a> 所有，适用 <a href="https://trustee.ietf.org/license-info/" target="_blank" rel="noopener">Trust Legal Provisions</a>（BCP 78 / TLP）。</li>
      <li>本应用<b>不复制、不分发文档正文</b>，默认仅呈现：标题、编号、状态、日期、页数、关键词，以及 Datatracker 提供的<b>摘要节选</b>（截断至 900 字符，标为节选）。</li>
      <li>「离线保存」是<b>使用者主动发起的个人缓存</b>：正文经本应用的同源转发，从 IETF 官方地址
      （<code>rfc-editor.org</code> / <code>ietf.org/archive</code>）取得，<b>只存放在使用者自己的设备上</b>，
      不上传、不二次分发。服务端只做原样转发、不改写内容，仅做短时内存缓存以减少重复请求。</li>
      <li>离线副本仅供个人阅读；<b>引用、转载或再分发仍须遵守 BCP 78 / TLP 与原文的版权声明</b>。</li>
      <li>每份文稿均提供指向 <code>datatracker.ietf.org</code> 与 <code>ietf.org</code> 的原始链接；如需完整内容请访问官方来源。</li>
      <li>RFC 的规范文本以其官方发布版本（rfc-editor.org）为唯一权威。</li>
    </ul>

    <h2>三、商标</h2>
    <p>"IETF"、"Internet Engineering Task Force"、"Internet-Draft"、"RFC" 等名称与标识为 IETF 相关主体的商标或服务标识。
    本应用仅在<b>描述性、事实指代</b>的意义上使用（nominative fair use），不使用 IETF 官方 Logo、菱形标志或其视觉识别系统，
    不暗示任何官方关系。站点名称 <code>ietfmap.app</code> 为描述性组合，如有异议将立即更名。</p>

    <h2>四、数据处理（隐私）</h2>
    <ul>
      <li>你的收藏、笔记、日志、报告全部保存在浏览器的 IndexedDB 中，不上传到服务器；可按账号分开存放（同一设备换人登录看到各自的数据）。</li>
      <li><b>账号系统只存最少信息</b>：账号名、角色、密码的加盐散列（PBKDF2-SHA256，210,000 轮）、创建时间、最近登录时间。不收集邮箱、手机号、IP 归属地，也不做画像。</li>
      <li>登录会话用一枚 <code>HttpOnly</code>、<code>SameSite=Lax</code> 的签名 Cookie 承载，有效期 30 天（期间访问会自动续期）；服务端只保留一份审计日志（登录成功 / 失败、账号变更），用于排查异常登录。</li>
      <li>密码不可逆：管理员能"重置"但不能"看到"任何人的密码；忘记密码只能重置。</li>
      <li>不接入任何第三方分析脚本；注销账号会立即删除其凭据，本机已有收藏不受影响。</li>
      <li>由于只处理账号凭据这一最小集合，本应用在设计上规避了 GDPR / 中国《个人信息保护法》下的多数义务；若未来加入云同步，须重新进行合规评估。</li>
    </ul>

    <h2>五、风险与免责</h2>
    <ul>
      <li><b>数据时效</b>：快照为构建期静态数据，可能滞后于 Datatracker 实时状态；不做实时性保证。</li>
      <li><b>准确性</b>：状态、引用关系直接取自 Datatracker；"被引次数""覆盖度评分""孤儿草案"等为本站自计算的启发式指标，<b>非 IETF 官方评价</b>。</li>
      <li><b>不做技术解读</b>：本应用不构成对任何技术规范的解读、认证或法律意见。</li>
      <li>因使用本应用产生的任何决策后果，由使用者自行承担。</li>
    </ul>

    <h2>六、对 IETF 的合理请求</h2>
    <ul>
      <li>遵守 Datatracker API 的使用礼仪：低频拉取（每日 1 次构建期拉取）、设置明确 User-Agent、支持 gzip。</li>
      <li>不将快照用于再分发或商业转售。</li>
      <li>收到 IETF 方面的任何异议（命名、用法、内容），在 7 日内响应并调整。</li>
    </ul>

    <h2>七、联络</h2>
    <p>本应用为个人项目，问题请通过项目仓库 Issue 反馈。最后更新：${fmtDate(Date.now())}。</p>
  </div>`;
}
