/* IETF Atlas — 关系解读（LLM 归纳层，强制证据约束）
 *
 * 设计原则：
 * 1. 模型只能看到「已抓取的真实引用边」，不允许它引入外部知识。
 * 2. 输出必须是结构化 JSON，每条结论必须列出支撑它的证据边编号。
 * 3. 服务端/前端都会校验：找不到对应证据的结论直接丢弃，并在 UI 里标注丢弃条数。
 * 4. 未配置 API Key 时，回退到"纯统计归纳"（不调用模型），保证功能永远可用。
 */
import { db, getSettings, esc } from './db.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const CACHE_KEY = 'llm-cache';

/* ---------- 证据构建：把组间关系压成模型可读的最小事実集 ---------- */
export function buildEvidence(idx, groupA, groupB, limit = 24) {
  const ev = [];
  for (const [src, rel, tgt] of idx.snap.rels) {
    if (!src || !tgt) continue;
    if (!['refnorm', 'refinfo', 'updates', 'obs', 'replaces'].includes(rel)) continue;
    const a = idx.docs.get(src), b = idx.docs.get(tgt);
    if (!a || !b) continue;
    if (!((a.g === groupA && b.g === groupB) || (a.g === groupB && b.g === groupA))) continue;
    ev.push({
      id: ev.length + 1,
      from: src, fromGroup: a.g, fromTitle: a.t,
      rel, to: tgt, toGroup: b.g, toTitle: b.t,
      weight: rel === 'refnorm' ? 2 : 1,
    });
    if (ev.length >= limit) break;
  }
  ev.sort((x, y) => y.weight - x.weight);
  ev.forEach((e, i) => e.id = i + 1);
  return ev;
}

/* ---------- 无 Key 时的统计归纳（确定性、可复现） ---------- */
export function statsDigest(groupA, groupB, ev) {
  const norm = ev.filter(e => e.rel === 'refnorm').length;
  const info = ev.filter(e => e.rel === 'refinfo').length;
  const aToB = ev.filter(e => e.fromGroup === groupA).length;
  const bToA = ev.filter(e => e.fromGroup === groupB).length;
  const lines = [];
  if (!ev.length) {
    lines.push(`${groupA} 与 ${groupB} 之间没有直接的文档引用关系。`);
  } else {
    lines.push(`${groupA} 与 ${groupB} 之间有 ${ev.length} 条文档引用（规范 ${norm} / 信息性 ${info}）。`);
    if (aToB && bToA) lines.push(`关系是双向的：${groupA}→${groupB} ${aToB} 条，${groupB}→${groupA} ${bToA} 条。`);
    else if (aToB) lines.push(`单向依赖：${groupA} 引用 ${groupB}，反过来没有。说明 ${groupA} 站在 ${groupB} 的基础上。`);
    else lines.push(`单向依赖：${groupB} 引用 ${groupA}，反过来没有。说明 ${groupB} 站在 ${groupA} 的基础上。`);
    if (norm === 0 && info > 0) lines.push(`全部是信息性引用，没有规范性依赖——技术耦合度低，属于背景参考关系。`);
    if (norm >= 3) lines.push(`有 ${norm} 条规范性引用，属于技术硬依赖：改一方的数据模型，另一方大概率要跟着改。`);
    const top = [...ev].sort((x, y) => y.weight - x.weight).slice(0, 3);
    lines.push(`最关键的三条：` + top.map(e => `\`${e.from}\` ${e.rel} \`${e.to}\``).join('；') + '。');
  }
  return lines;
}

/* ---------- 提示词：强约束 ---------- */
function buildPrompt(groupA, groupB, ev) {
  const evidence = ev.map(e =>
    `[${e.id}] ${e.from} (${e.fromGroup}) --${e.rel}--> ${e.to} (${e.toGroup})`
  ).join('\n');

  return `你是 IETF 技术关系分析助手。你只能依据下列**已经抓取到的真实引用记录**做归纳，禁止使用任何外部知识或猜测。

组 A：${groupA}
组 B：${groupB}

证据边（每行一条，格式：编号 源文稿 (源组) --关系--> 目标文稿 (目标组)）：
${evidence || '（无任何引用记录）'}

关系类型含义：
- refnorm = 规范性引用，表示技术硬依赖
- refinfo = 信息性引用，表示背景参考，耦合度弱
- updates / obs / replaces = 版本演进关系

请输出严格的 JSON（不要 markdown 代码块，不要多余文字）：
{
  "verdict": "一句话结论，不超过 40 字",
  "dependency": "one-way-a-to-b | one-way-b-to-a | bidirectional | none",
  "strength": "strong | moderate | weak | none",
  "claims": [
    { "text": "一条结论，不超过 60 字", "evidence": [1, 3] }
  ],
  "why": "为什么这两个组会产生关联，不超过 80 字",
  "caveat": "这个结论的局限，不超过 50 字"
}

硬性要求：
1. claims 最多 3 条，每条必须携带至少 1 个证据编号。
2. 证据编号必须来自上面的列表，不得编造。
3. 如果证据不足以支撑某个判断，就不要写这条 claim。
4. 如果证据边为空，verdict 必须是"无直接文档引用关系"，claims 为空数组。
5. 不要写"可能""也许"这类无证据的推测。`;
}

/* ---------- 调用模型 ---------- */
async function callLLM(cfg, prompt) {
  const base = (cfg.llmBase || 'https://api.openai.com/v1').replace(/\/$/, '');
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.llmKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel || DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你只输出合法 JSON，不做任何外部知识补充。' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`模型返回 ${r.status}：${t.slice(0, 120)}`);
  }
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || '';
}

/* ---------- 解析 + 证据校验 ---------- */
export function validateResult(raw, ev) {
  const validIds = new Set(ev.map(e => e.id));
  let obj;
  try {
    const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    obj = JSON.parse(s);
  } catch {
    return { ok: false, error: '模型输出不是合法 JSON', dropped: 0, result: null };
  }
  const claims = Array.isArray(obj.claims) ? obj.claims : [];
  const kept = [], dropped = [];
  for (const c of claims) {
    const ids = (c.evidence || []).map(Number).filter(i => validIds.has(i));
    if (ids.length && c.text) kept.push({ text: String(c.text).slice(0, 200), evidence: ids });
    else dropped.push(c.text || '(空)');
  }
  return {
    ok: true,
    dropped: dropped.length,
    droppedTexts: dropped,
    result: {
      verdict: String(obj.verdict || '').slice(0, 120),
      dependency: obj.dependency || 'unknown',
      strength: obj.strength || 'unknown',
      claims: kept,
      why: String(obj.why || '').slice(0, 200),
      caveat: String(obj.caveat || '').slice(0, 160),
    },
  };
}

/* ---------- 缓存 ---------- */
async function cacheGet(key) {
  const c = await db.get('settings', CACHE_KEY);
  return c?.data?.[key] || null;
}
async function cacheSet(key, value) {
  const c = await db.get('settings', CACHE_KEY);
  const data = { ...(c?.data || {}) };
  // 最多保留 200 条
  const keys = Object.keys(data);
  if (keys.length > 200) delete data[keys[0]];
  data[key] = { ...value, ts: Date.now() };
  await db.put('settings', { key: CACHE_KEY, data });
}

/* ---------- 主入口 ---------- */
export async function analyzeRelation(idx, groupA, groupB, { force = false } = {}) {
  const cfg = await getSettings();
  const ev = buildEvidence(idx, groupA, groupB);
  const key = [groupA, groupB].sort().join('|');
  const digest = statsDigest(groupA, groupB, ev);

  if (!cfg.llmKey) {
    return { mode: 'stats', digest, evidence: ev, result: null };
  }
  if (!force) {
    const hit = await cacheGet(key);
    if (hit && Date.now() - hit.ts < 1000 * 60 * 60 * 24) {
      return { mode: 'llm-cached', digest, evidence: ev, ...hit.value };
    }
  }
  try {
    const raw = await callLLM(cfg, buildPrompt(groupA, groupB, ev));
    const v = validateResult(raw, ev);
    if (!v.ok) return { mode: 'stats', digest, evidence: ev, result: null, error: v.error };
    const payload = { result: v.result, dropped: v.dropped, droppedTexts: v.droppedTexts };
    await cacheSet(key, payload);
    return { mode: 'llm', digest, evidence: ev, ...payload };
  } catch (e) {
    return { mode: 'stats', digest, evidence: ev, result: null, error: e.message };
  }
}

/* ---------- 渲染 ---------- */
export function renderAnalysis(el, groupA, groupB, data) {
  const evById = new Map(data.evidence.map(e => [e.id, e]));
  const modeLabel = {
    'llm': '<span class="label green">模型归纳 · 已校验证据</span>',
    'llm-cached': '<span class="label green">模型归纳 · 缓存</span>',
    'stats': '<span class="label">统计归纳 · 无需模型</span>',
  }[data.mode] || '';

  let html = `<div class="row" style="margin-bottom:8px">${modeLabel}
    <span class="spacer"></span><span class="hint">证据 ${data.evidence.length} 条</span></div>`;

  if (data.error) {
    html += `<div class="hint" style="color:var(--danger);margin-bottom:8px">模型调用失败，已回退到统计归纳：${esc(data.error)}</div>`;
  }

  if (data.result) {
    const r = data.result;
    const depText = {
      'one-way-a-to-b': `${esc(groupA)} 依赖 ${esc(groupB)}`,
      'one-way-b-to-a': `${esc(groupB)} 依赖 ${esc(groupA)}`,
      'bidirectional': '双向依赖',
      'none': '无依赖',
    }[r.dependency] || '';
    const strCls = { strong: 'blue', moderate: 'yellow', weak: '', none: 'red' }[r.strength] || '';
    html += `<div style="font-weight:600;margin-bottom:6px">${esc(r.verdict)}</div>
      <div class="row" style="margin-bottom:10px">
        ${depText ? `<span class="label">${depText}</span>` : ''}
        ${r.strength !== 'unknown' ? `<span class="label ${strCls}">强度：${esc({strong:'强',moderate:'中',weak:'弱',none:'无'}[r.strength] || r.strength)}</span>` : ''}
      </div>`;
    if (r.claims?.length) {
      html += `<div class="side-title">结论（每条都附证据编号）</div>`;
      for (const c of r.claims) {
        html += `<div class="hop" style="margin-bottom:6px">
          <div>${esc(c.text)}</div>
          <div style="margin-top:4px">${c.evidence.map(id => {
            const e = evById.get(id);
            return e ? `<span class="label blue mono" title="${esc(e.from + ' → ' + e.to)}">[${id}]</span>` : '';
          }).join(' ')}</div>
        </div>`;
      }
    }
    if (r.why) html += `<div class="side-title">成因</div><div class="hint" style="margin-bottom:8px">${esc(r.why)}</div>`;
    if (r.caveat) html += `<div class="side-title">局限</div><div class="hint" style="margin-bottom:8px">${esc(r.caveat)}</div>`;
    if (data.dropped) {
      html += `<div class="hint" style="color:var(--attention);margin-bottom:8px">
        ⚠ 已丢弃 ${data.dropped} 条无证据支撑的结论（防止模型编造）。</div>`;
    }
  } else {
    html += `<div class="side-title">统计归纳</div>`;
    html += data.digest.map(l => `<div style="margin-bottom:4px">${esc(l).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>`).join('');
  }

  if (data.evidence.length) {
    html += `<div class="side-title" style="margin-top:12px">证据边（点击编号可定位原文）</div>
      <div class="mini-list">${data.evidence.map(e => `<div class="mini-row">
        <span class="label mono">[${e.id}]</span>
        <a class="mono" href="https://datatracker.ietf.org/doc/${esc(e.from)}/" target="_blank" rel="noopener">${esc(e.from.replace('draft-', ''))}</a>
        <span class="label ${e.rel === 'refnorm' ? 'blue' : ''}">${e.rel === 'refnorm' ? '规范' : e.rel === 'refinfo' ? '信息' : esc(e.rel)}</span>
        <a class="mono" href="https://datatracker.ietf.org/doc/${esc(e.to)}/" target="_blank" rel="noopener">${esc(e.to)}</a>
      </div>`).join('')}</div>`;
  }
  el.innerHTML = html;
}
