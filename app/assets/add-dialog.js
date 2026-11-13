/* IETF Atlas — 添加文稿 / 组的对话框（收藏库、诊断、图谱共用） */
import { esc, toast, log } from './db.js';
import { index, resolveTarget, resolveTargetDeep, assetFromDoc } from './data.js';

export async function openAddDialog(onDone) {
  const idx = await index();
  let dlg = document.getElementById('add-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'add-dlg';
    dlg.innerHTML = `
      <form method="dialog">
        <div class="dlg-head">添加文稿或工作组</div>
        <div class="dlg-body">
          <label class="field"><span>草案名 / RFC / 链接 / 组缩写</span>
            <input type="text" id="dlg-input" placeholder="draft-ietf-quic-tls、RFC 9001、…/doc/draft-ietf-quic-tls/、quic">
            <em>支持粘贴 Datatracker 链接，自动去掉版本号与大小写差异。</em>
          </label>
          <div id="dlg-preview" class="hint"></div>
        </div>
        <div class="dlg-foot">
          <button class="btn" value="cancel">取消</button>
          <button class="btn primary" value="ok">添加</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
  }

  const form = dlg.querySelector('form');
  const input = dlg.querySelector('#dlg-input');
  const preview = dlg.querySelector('#dlg-preview');
  input.value = '';
  preview.innerHTML = '';

  let resolved = null;
  const setPreview = (html) => { preview.innerHTML = html; };

  const lookup = async () => {
    const v = input.value.trim();
    resolved = null;
    if (!v) return setPreview('');
    const local = resolveTarget(v, idx);
    if (local) {
      resolved = local;
      return setPreview(local.kind === 'doc'
        ? `<span class="label green">找到文稿</span> <b>${esc(local.key)}</b> — ${esc(local.doc?.t || '')}`
        : `<span class="label purple">找到工作组</span> <b>${esc(local.key)}</b> — ${esc(local.group?.name || '')}`);
    }
    setPreview('<span class="hint">快照里没有，正在向 Datatracker 查询…</span>');
    const { result, source } = await resolveTargetDeep(v, idx);
    if (!result) return setPreview('<span style="color:var(--danger)">没找到这份文稿或这个组，请检查名称。</span>');
    resolved = result;
    setPreview((result.kind === 'doc'
      ? `<span class="label green">实时查到</span> <b>${esc(result.key)}</b> — ${esc(result.doc?.t || '')}`
      : `<span class="label purple">实时查到工作组</span> <b>${esc(result.key)}</b> — ${esc(result.group?.name || '')}`)
      + (source === 'live' ? ' <span class="hint">（已缓存元数据）</span>' : ''));
  };

  input.oninput = lookup;
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); if (resolved) form.requestSubmit(); }
  };

  form.onsubmit = async (e) => {
    const val = (e.submitter?.value || 'cancel');
    if (val !== 'ok') return;
    if (!resolved) { await lookup(); if (!resolved) { e.preventDefault(); return; } }
    try {
      if (resolved.kind === 'doc') {
        await import('./data.js').then(m => m.saveAsset(assetFromDoc(resolved.doc)));
        await log('star-doc', resolved.key + ' (手动添加)');
        toast('已添加：' + resolved.key);
      } else {
        await import('./data.js').then(m => m.saveAsset({
          id: 'g:' + resolved.key, key: resolved.key, kind: 'group', added: Date.now(),
          meta: { acr: resolved.key, name: resolved.group?.name || '' },
        }));
        await log('star-group', resolved.key);
        toast('已关注：' + resolved.key);
      }
      onDone?.();
    } catch (err) {
      e.preventDefault();
      toast('添加失败：' + err.message);
    }
  };

  dlg.showModal();
  setTimeout(() => input.focus(), 30);
}
