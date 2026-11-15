/* IETF Atlas — 存储层（local-first，IndexedDB + 内存兜底） */
const LEGACY_DB = 'ietf-atlas';
let DB_NAME = LEGACY_DB;
const DB_VER = 2;
// offline：下载到本机的正文（断网也能读）。升版本只会新建缺的 store，已有收藏不受影响
const STORES = ['assets', 'notes', 'tags', 'settings', 'logs', 'reports', 'offline'];
const ID_KEYED = new Set(['assets', 'offline']);

let _db = null;
const mem = Object.fromEntries(STORES.map(s => [s, []]));
let useMem = false;

const slug = name => String(name || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);

/**
 * 每个账号一份独立的本地库：同一台设备上换人登录，看到的是各自的收藏。
 * 没登录（理论上进不来）时退回旧库名。
 */
export function useUserData(name) {
  const next = name ? `${LEGACY_DB}--${slug(name)}` : LEGACY_DB;
  if (next === DB_NAME) return false;
  DB_NAME = next;
  _db = null;
  return true;
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const os = db.createObjectStore(s, { keyPath: ID_KEYED.has(s) ? 'id' : 'key' });
          if (s === 'assets') os.createIndex('group', 'group', { unique: false });
          if (s === 'logs') os.createIndex('ts', 'ts', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open() {
  if (_db) return Promise.resolve(_db);
  return openDb(DB_NAME).then(db => { _db = db; return db; })
    .catch(() => { useMem = true; return null; });
}

/**
 * 一次性搬迁：v0.7 之前只有一份公共库 `ietf-atlas`。
 *
 * 只搬一次：第一个登录的账号（通常是 admin，也就是这台机器的归属者）认领旧库，
 * 之后任何人登录都不再搬——否则每个新账号都会把同一个人的收藏复制一份，那就串号了。
 * 领养记录写在 localStorage 里，旧库本身保留不动，真搬错了还能找回来。
 */
const CLAIM_KEY = 'atlas.legacy-claimed-by';

export async function migrateLegacyTo(user) {
  if (!user) return false;
  if (DB_NAME === LEGACY_DB) return false;
  try {
    let claimed = '';
    try { claimed = localStorage.getItem(CLAIM_KEY) || ''; } catch { /* 隐私模式 */ }
    if (claimed) return false;                  // 旧库已经有人认领，其他人一律不搬

    const have = await db.all('assets');
    if (have.length) return false;              // 这个账号已经有数据，不覆盖

    const names = indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : null;
    if (names && !names.includes(LEGACY_DB)) return false;

    const legacy = await openDb(LEGACY_DB);
    const stores = [...legacy.objectStoreNames];
    if (!stores.includes('assets')) { legacy.close(); return false; }

    const rows = {};
    for (const s of STORES) {
      if (!stores.includes(s)) continue;
      rows[s] = await new Promise(res => {
        const r = legacy.transaction(s, 'readonly').objectStore(s).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => res([]);
      });
    }
    legacy.close();
    // 旧库是空的：什么都没搬，但标记一下，别让后面的人再翻一遍
    if (!(rows.assets || []).length) {
      try { localStorage.setItem(CLAIM_KEY, '—'); } catch { /* ignore */ }
      return false;
    }

    for (const s of STORES) {
      for (const row of rows[s] || []) await db.put(s, row);
    }
    await log('data-migrate', `从旧库复制 ${rows.assets.length} 条收藏到 ${DB_NAME}`);
    try { localStorage.setItem(CLAIM_KEY, user); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

function tx(store, mode) {
  return open().then(db => {
    if (!db) return null;
    return db.transaction(store, mode).objectStore(store);
  });
}

export const db = {
  async all(store) {
    const os = await tx(store, 'readonly');
    if (!os) return [...mem[store]];
    return new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(store, key) {
    const os = await tx(store, 'readonly');
    if (!os) return mem[store].find(x => (x.id ?? x.key) === key);
    return new Promise((res, rej) => {
      const r = os.get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async put(store, val) {
    const os = await tx(store, 'readwrite');
    if (!os) {
      const k = val.id ?? val.key;
      const arr = mem[store];
      const i = arr.findIndex(x => (x.id ?? x.key) === k);
      i >= 0 ? arr[i] = val : arr.push(val);
      return val;
    }
    return new Promise((res, rej) => {
      const r = os.put(val);
      r.onsuccess = () => res(val);
      r.onerror = () => rej(r.error);
    });
  },
  async del(store, key) {
    const os = await tx(store, 'readwrite');
    if (!os) {
      mem[store] = mem[store].filter(x => (x.id ?? x.key) !== key);
      return;
    }
    return new Promise((res, rej) => {
      const r = os.delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  async clear(store) {
    const os = await tx(store, 'readwrite');
    if (!os) { mem[store] = []; return; }
    return new Promise((res, rej) => {
      const r = os.clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
};

/* ---------- 设置（带默认值） ---------- */
export const DEFAULT_SETTINGS = {
  key: 'app',
  domainPrefix: 'atlas',
  rootDomain: 'ietfmap.app',
  theme: 'auto',
  density: 60,          // 图谱密度阈值：节点被引次数下限
  maxNodes: 400,
  groupStates: ['active', 'concluded'],
  autoReport: false,
  autoReportCron: '0 9 * * 1',
  showOrphans: true,
  lang: 'zh',
  // 关系解读（LLM）——留空则用统计归纳，不联网
  llmBase: 'https://api.openai.com/v1',
  llmKey: '',
  llmModel: 'gpt-4o-mini'
};

export async function getSettings() {
  const s = await db.get('settings', 'app');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await db.put('settings', s);
  applyTheme(s.theme);
  return s;
}

export function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = dark ? '#0d1117' : '#f6f8fa';
}

/* ---------- 操作日志 ---------- */
export async function log(action, detail = '') {
  const entry = { key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), action, detail };
  await db.put('logs', entry);
  window.dispatchEvent(new CustomEvent('atlas:log', { detail: entry }));
  return entry;
}

/* ---------- 工具 ---------- */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDate = ts => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return isNaN(d) ? '—' : d.toISOString().slice(0, 10);
};
export const relTime = ts => {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (isNaN(diff)) return '—';
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDate(ts);
};

export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}
