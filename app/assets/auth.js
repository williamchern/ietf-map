/* IETF Atlas — 账号与会话（前端）
 *
 * 登录态由服务端签名的 HttpOnly Cookie 承载，这里只做三件事：
 *   1) 问 /api/auth/me 当前是谁；断网时退回本机缓存（离线也能接着看）；
 *   2) 没登录 / 首次登录未改密码 → 渲染登录门；
 *   3) 配置页里的改密码、建账号、重置、删除。
 *
 * 密码永远不落本机：只在提交时经 HTTPS 发给自己的服务器。
 */
import { esc, toast, useUserData, migrateLegacyTo, log } from './db.js';

const CACHE_KEY = 'atlas.auth';
const SESSION_MS = 30 * 24 * 3600 * 1000;   // 与服务端一致：登录一次管 30 天

export const session = { user: null, offline: false };
export const authUser = () => session.user;
export const isAdmin = () => session.user?.role === 'admin';
/** 刚在登录框里输入的密码，只留在内存里，用于首次改密码时预填 */
export let lastPassword = '';

/* ---------- 本机会话缓存（只为断网时还能进） ---------- */

function saveCache(user) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ user, exp: Date.now() + SESSION_MS }));
  } catch { /* 隐私模式下写不了就算了 */ }
}
function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!raw || !raw.user || raw.exp < Date.now()) return null;
    return raw;
  } catch { return null; }
}
function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

function adopt(user) {
  useUserData(user.name);
  return user;
}

/* ---------- 会话 ---------- */

export async function loadSession() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) {
      clearCache();
      session.user = null; session.offline = false;
      return null;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    session.user = adopt(d.user);
    session.offline = false;
    saveCache(d.user);
    return session.user;
  } catch {
    // 断网 / 服务端没起来：用本机缓存，别把人挡在门外（数据本来就在本机）
    const c = readCache();
    session.user = c ? adopt(c.user) : null;
    session.offline = !!c;
    return session.user;
  }
}

export async function login(name, password) {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `登录失败（HTTP ${r.status}）`);
  session.user = adopt(d.user);
  session.offline = false;
  saveCache(d.user);
  await migrateLegacyTo(d.user.name);
  await log('login', d.user.name);
  return d.user;
}

export async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 断网也照样退出本机 */ }
  await log('logout', session.user?.name || '');
  clearCache();
  session.user = null;
}

export async function changePassword(oldPw, newPw) {
  const r = await fetch('/api/auth/password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old: oldPw, new: newPw }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `修改失败（HTTP ${r.status}）`);
  session.user = d.user;
  saveCache(d.user);
  await log('password-change', '');
  return d.user;
}

/* ---------- 管理员：账号 ---------- */

async function adminPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

export async function listUsers() {
  const r = await fetch('/api/auth/list', { credentials: 'same-origin', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
export const createUser = (name, password, role, note) => adminPost('/api/auth/users', { name, password, role, note });
export const resetUserPassword = (name, password) => adminPost('/api/auth/users/reset', { name, password });
export const deleteUser = name => adminPost('/api/auth/users/delete', { name });
export const auditEvents = async () => {
  const r = await fetch('/api/auth/audit', { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return d.events || [];
};

/* ---------- 登录门 ---------- */

/**
 * @param {'login'|'change'} mode
 * @param {() => void} onDone 登录（或改完密码）之后做什么
 * @param {{old?: string}} [opts] 刚登录时用的密码，首次改密码时预填，省得再输一遍
 */
export function mountGate(mode, onDone, opts = {}) {
  const offlineHint = mode === 'login' && !navigator.onLine
    ? '<p class="auth-note warn">当前处于离线状态，无法验证密码。之前在这台设备登录过的话，直接打开应用即可；否则请联网后再登录。</p>'
    : '';
  const body = mode === 'change' ? `
      <h1 class="auth-title">先设一个新密码</h1>
      <p class="auth-sub">账号 <b class="mono">${esc(session.user?.name || '')}</b> 还在用初始密码或已被重置。改完才能进。</p>
      <form id="af" autocomplete="off">
        <label class="auth-field"><span>当前密码</span>
          <input type="password" id="cp" autocomplete="current-password" required value="${esc(opts.old || '')}"></label>
        <label class="auth-field"><span>新密码</span>
          <input type="password" id="np" autocomplete="new-password" minlength="8" required placeholder="至少 8 位"></label>
        <label class="auth-field"><span>再输一次</span>
          <input type="password" id="np2" autocomplete="new-password" minlength="8" required></label>
        <p class="auth-err" id="err"></p>
        <div class="auth-actions">
          <button class="btn primary" type="submit">保存并进入</button>
          <button class="btn" type="button" id="out">退出</button>
        </div>
      </form>` : `
      <h1 class="auth-title">登录 IETF Atlas</h1>
      <p class="auth-sub">这个实例需要账号才能打开。数据仍然只存在你自己的浏览器里。</p>
      ${offlineHint}
      <form id="af" autocomplete="on">
        <label class="auth-field"><span>账号</span>
          <input type="text" id="un" autocomplete="username" required autocapitalize="off" spellcheck="false" placeholder="admin"></label>
        <label class="auth-field"><span>密码</span>
          <input type="password" id="pw" autocomplete="current-password" required></label>
        <p class="auth-err" id="err"></p>
        <div class="auth-actions">
          <button class="btn primary" type="submit" id="go">登录</button>
        </div>
      </form>
      <p class="auth-note">第一次用：初始管理员是 <b class="mono">admin</b> / <b class="mono">admin</b>，登录后会要求改密码。
      忘记密码只能请管理员在「配置 → 账号」里重置。</p>`;

  document.body.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand"><span class="mark">IA</span>
          <div><b>IETF Atlas</b><span>标准与草案知识地图</span></div></div>
        ${body}
      </div>
      <p class="auth-foot">第三方视图，与 IETF 无关联 · <a href="#/about">关于与法律声明</a></p>
    </div>`;

  const form = document.getElementById('af');
  const err = document.getElementById('err');
  const say = m => { err.textContent = m || ''; err.classList.toggle('on', !!m); };

  document.getElementById('out')?.addEventListener('click', async () => {
    await logout();
    mountGate('login', onDone);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    say('');
    try {
      if (mode === 'change') {
        const cp = document.getElementById('cp').value;
        const np = document.getElementById('np').value;
        const np2 = document.getElementById('np2').value;
        if (np !== np2) throw new Error('两次输入不一致');
        if (np === cp) throw new Error('新密码不能和当前密码一样');
        await changePassword(cp, np);
        toast('密码已更新');
      } else {
        await login(document.getElementById('un').value.trim(), document.getElementById('pw').value);
        lastPassword = document.getElementById('pw').value;
      }
      onDone?.();
    } catch (e2) {
      say(e2.message || '出错了');
      btn.disabled = false;
    }
  });

  // 打开就能直接敲字：渲染完立刻聚焦（rAF 比 setTimeout 更早，且不会在布局前抢焦点）
  const first = document.getElementById(mode === 'change' ? 'cp' : 'un');
  requestAnimationFrame(() => first?.focus());
}
