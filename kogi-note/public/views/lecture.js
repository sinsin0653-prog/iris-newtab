import { h, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';
import { statusLabel, isWorking, reuploadWarning } from '../lib/status.js';
import { parseTranscript, parseTime, nearestLineIndex, formatTime } from '../lib/time.js';
import { uploadAudio, uploadAttachment, kindOf } from '../upload.js';

const POLL_MS = 10000;
// 音声が要るときだけ目立たせる（要約のエラーではまず「やり直す」）
const l2class = (l) => (l.needs_audio ? 'primary' : '');
const TABS = [['summary', '要約'], ['transcript', '文字起こし'], ['notes', 'メモ・レジュメ']];

export async function render(root, [lectureId]) {
  let timer = null;
  let lecture = null;
  let tab = 'summary';
  let pendingJump = null;

  const head = h('div');
  const notices = h('div', { role: 'status' });
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel' });
  root.append(head, notices, tabBar, panel);

  const flash = sessionStorage.getItem('kogi:flash');
  const failedFiles = JSON.parse(sessionStorage.getItem('kogi:failed') ?? '[]');
  sessionStorage.removeItem('kogi:flash');
  sessionStorage.removeItem('kogi:failed');

  async function act(path, label) {
    try {
      await apiFetch(path, { method: 'POST' });
      await load();
    } catch (err) {
      alert(`${label}：${errorText(err)}`);
    }
  }

  function audioPicker() {
    const input = h('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac', hidden: true });
    const bar = h('progress', { max: 1, value: 0, hidden: true });
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      bar.hidden = false;
      try {
        await uploadAudio({ lectureId, file: input.files[0], onProgress: (r) => { bar.value = r; } });
      } catch (err) {
        alert(`音声を送れませんでした：${errorText(err)}`);
      }
      await load();
    });
    const onclick = () => {
      const warning = reuploadWarning(lecture);
      if (warning && !confirm(warning)) return;
      input.click();
    };
    return h('span', {}, h('button', { type: 'button', class: l2class(lecture), onclick }, '音声を入れ直す'), input, bar);
  }

  function renderHead() {
    const l = lecture;
    head.replaceChildren(
      h('p', {}, h('a', { href: `#/s/${l.subject_id}` }, `← ${l.subject_name}`)),
      h('h1', {}, `${l.subject_name} 第${l.number}回 `, h('span', { class: 'meta' }, l.date)),
      h('p', { class: 'row' }, h('span', { class: `badge ${l.status}`, id: 'status' }, statusLabel(l))),
    );
    notices.replaceChildren();
    if (flash) notices.append(h('p', { class: 'notice error' }, flash));
    if (failedFiles.length) notices.append(h('div', { class: 'notice error' }, '送れなかったファイル（「メモ・レジュメ」から足し直せます）：', h('ul', {}, failedFiles.map((f) => h('li', {}, f)))));
    const buttons = h('p', { class: 'row' });
    if (l.status === 'error') notices.append(h('p', { class: 'notice error' }, l.error_message ?? 'エラーが起きました'));
    if (l.needs_audio || l.status === 'error') buttons.append(audioPicker());
    if (l.status === 'error' && !l.needs_audio) buttons.append(h('button', { type: 'button', onclick: () => act(`/api/lectures/${lectureId}/retry`, 'やり直せませんでした') }, 'やり直す'));
    if (l.status === 'done' || (l.status === 'error' && (l.step === 'attach' || l.step === 'summarize'))) {
      buttons.append(h('button', { type: 'button', onclick: () => act(`/api/lectures/${lectureId}/resummarize`, '要約を作り直せませんでした') }, '要約を作り直す'));
    }
    buttons.append(h('button', { type: 'button', class: 'danger', onclick: async () => {
      if (!confirm('この授業を消します。よろしいですか？')) return;
      try {
        await apiFetch(`/api/lectures/${lectureId}`, { method: 'DELETE' });
        location.hash = `#/s/${l.subject_id}`;
      } catch (err) {
        alert(errorText(err));
      }
    } }, '削除'));
    notices.append(buttons);
  }

  function renderTabs() {
    tabBar.replaceChildren(...TABS.map(([key, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === key), 'data-tab': key, onclick: () => { tab = key; renderTabs(); renderPanel(); } }, label)));
  }

  const timeLink = (t) => {
    const sec = parseTime(t);
    if (sec === null) return null;
    return h('button', { type: 'button', class: 'time', onclick: () => { pendingJump = sec; tab = 'transcript'; renderTabs(); renderPanel(); } }, `[${formatTime(sec)}]`);
  };

  function renderSummary() {
    const s = lecture.summary;
    if (!s) return h('p', { class: 'meta' }, isWorking(lecture) ? 'いま作っています。終わったらここに出ます。' : 'まだ要約がありません');
    return h('div', { class: 'summary' },
      h('h2', {}, '📌 今日のテーマ'), h('p', {}, s.theme),
      h('h2', {}, '🗺 授業の流れ'), s.flow.length ? h('ol', {}, s.flow.map((f) => h('li', {}, h('strong', {}, f.heading), f.handout_pages ? h('span', { class: 'tag' }, f.handout_pages) : null, h('br'), f.detail))) : h('p', { class: 'meta' }, 'なし'),
      h('h2', {}, '⭐ 大事なポイント'), s.key_points.length ? h('ul', {}, s.key_points.map((k) => h('li', {}, timeLink(k.time), k.point,
        k.not_in_notes ? h('span', { class: 'tag note' }, '📝メモになし') : null,
        k.kind === 'exam' ? h('span', { class: 'tag exam' }, 'テストに出る') : null))) : h('p', { class: 'meta' }, 'なし'),
      h('h2', {}, '📢 連絡事項'), s.announcements.length ? h('ul', {}, s.announcements.map((a) => h('li', {}, timeLink(a.time), a.text))) : h('p', { class: 'meta' }, 'なし'),
    );
  }

  function renderTranscript() {
    const lines = parseTranscript(lecture.transcript);
    if (!lines.length) return h('p', { class: 'meta' }, isWorking(lecture) ? 'いま文字起こししています。' : 'まだ文字起こしがありません');
    const ps = lines.map((line) => h('p', {}, line.sec !== null ? h('span', { class: 'meta' }, `[${formatTime(line.sec)}] `) : null, line.text));
    if (pendingJump !== null) {
      const target = ps[nearestLineIndex(lines, pendingJump)];
      target.classList.add('hit');
      pendingJump = null;
      requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
    }
    return h('div', { class: 'transcript' }, ps);
  }

  function renderNotes() {
    const text = h('textarea', { id: 'edit-note', maxlength: 100000 });
    text.value = lecture.note_text;
    const saved = h('p', { class: 'meta', 'aria-live': 'polite' });
    const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, id: 'add-files' });
    const role = h('select', { id: 'add-role' }, h('option', { value: 'note' }, 'メモの写真'), h('option', { value: 'handout' }, 'レジュメ'));
    const addMsg = h('div', { role: 'alert' });
    const list = h('div', { class: 'thumbs' }, lecture.attachments.map((a) => h('figure', {},
      a.mime === 'application/pdf' ? h('a', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener' }, '📄 PDF を開く') : h('img', { src: `/api/attachments/${a.id}`, alt: a.kind === 'note_image' ? 'メモの写真' : 'レジュメ', loading: 'lazy' }),
      h('figcaption', { class: 'meta' }, a.kind === 'note_image' ? 'メモ' : 'レジュメ', ' ', h('button', { type: 'button', class: 'link', onclick: async () => {
        if (!confirm('このファイルを消します。よろしいですか？')) return;
        try {
          await apiFetch(`/api/attachments/${a.id}`, { method: 'DELETE' });
          await load();
        } catch (err) {
          alert(errorText(err));
        }
      } }, '消す')))));
    return h('div', {},
      h('label', { for: 'edit-note' }, '打ったメモ'), text,
      h('p', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
        try {
          await apiFetch(`/api/lectures/${lectureId}`, { method: 'PATCH', json: { note_text: text.value } });
          lecture.note_text = text.value;
          saved.textContent = '保存しました。要約に反映するには「要約を作り直す」を押してください';
        } catch (err) {
          saved.textContent = errorText(err);
        }
      } }, '保存'), saved),
      h('h2', {}, '写真・PDF'), list,
      h('label', { for: 'add-files' }, 'ファイルを足す'), h('div', { class: 'row' }, role, h('div', { class: 'grow' }, pick)),
      h('p', {}, h('button', { type: 'button', onclick: async () => {
        addMsg.replaceChildren();
        for (const file of pick.files) {
          try {
            await uploadAttachment({ lectureId, kind: kindOf(file, role.value), file });
          } catch (err) {
            addMsg.append(h('p', { class: 'notice error' }, `${file.name}：${errorText(err)}`));
          }
        }
        await load();
      } }, '足す')), addMsg);
  }

  function renderPanel() {
    panel.replaceChildren(tab === 'summary' ? renderSummary() : tab === 'transcript' ? renderTranscript() : renderNotes());
  }

  // 10 秒ごとの読み直しでは、メモ・レジュメのタブ（書きかけのメモ）を描き直さない
  async function load(redraw = true) {
    ({ lecture } = await apiFetch(`/api/lectures/${lectureId}`));
    renderHead();
    renderTabs();
    if (redraw || tab !== 'notes') renderPanel();
    clearTimeout(timer);
    if (isWorking(lecture)) timer = setTimeout(() => load(false).catch(() => {}), POLL_MS);
  }

  try {
    await load();
  } catch (err) {
    if (err.status !== 401) root.append(h('p', { class: 'notice error' }, errorText(err)));
  }
  return () => clearTimeout(timer);
}
