import { h, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';
import { todayLocal } from '../lib/time.js';
import { uploadAudio, uploadAttachment, kindOf, MAX_AUDIO_BYTES, MAX_PDF_BYTES } from '../upload.js';

const MAX_FILES = 20;

export async function render(root, [subjectId]) {
  const { subject, lectures } = await apiFetch(`/api/subjects/${subjectId}/lectures`);
  const number = h('input', { type: 'number', id: 'number', min: 1, step: 1, value: String(Math.max(0, ...lectures.map((l) => l.number)) + 1) });
  const date = h('input', { type: 'date', id: 'date', value: todayLocal() });
  const audio = h('input', { type: 'file', id: 'audio', accept: 'audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac' });
  const notePhotos = h('input', { type: 'file', id: 'note-photos', accept: 'image/*', multiple: true });
  const noteText = h('textarea', { id: 'note-text', maxlength: 100000, placeholder: '打ったメモがあればここに' });
  const handouts = h('input', { type: 'file', id: 'handouts', accept: 'application/pdf,image/*', multiple: true });
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const status = h('p', { class: 'meta', 'aria-live': 'polite' });
  const msg = h('div', { role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'アップロードする');

  function check() {
    const files = [...notePhotos.files, ...handouts.files];
    if (!audio.files[0]) return '音声を選んでね';
    if (audio.files[0].size > MAX_AUDIO_BYTES) return '音声は2GBまでです';
    if (files.length > MAX_FILES) return 'メモとレジュメは合わせて20個までです';
    const bigPdf = [...handouts.files].find((f) => kindOf(f, 'handout') === 'handout_pdf' && f.size > MAX_PDF_BYTES);
    if (bigPdf) return `「${bigPdf.name}」は20MBを超えています（PDF は20MBまで）`;
    return null;
  }

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    msg.replaceChildren();
    const problem = check();
    if (problem) {
      msg.append(h('p', { class: 'notice error' }, problem));
      return;
    }
    submit.disabled = true;
    bar.hidden = false;
    let lectureId;
    try {
      status.textContent = '授業を作っています…';
      ({ id: lectureId } = await apiFetch('/api/lectures', { method: 'POST', json: { subject_id: subjectId, number: Number(number.value), date: date.value, note_text: noteText.value } }));
    } catch (err) {
      msg.append(h('p', { class: 'notice error' }, errorText(err)));
      submit.disabled = false;
      bar.hidden = true;
      status.textContent = '';
      return;
    }
    const failed = [];
    const items = [...[...notePhotos.files].map((f) => [f, 'note']), ...[...handouts.files].map((f) => [f, 'handout'])];
    for (const [i, [file, role]] of items.entries()) {
      status.textContent = `メモ・レジュメを送っています（${i + 1}/${items.length}）`;
      try {
        await uploadAttachment({ lectureId, kind: kindOf(file, role), file });
      } catch (err) {
        failed.push(`${file.name}：${errorText(err)}`);
      }
    }
    try {
      status.textContent = '音声を送っています…';
      await uploadAudio({ lectureId, file: audio.files[0], onProgress: (r) => { bar.value = r; } });
    } catch (err) {
      sessionStorage.setItem('kogi:flash', `音声を送れませんでした：${errorText(err)}`);
    }
    if (failed.length) sessionStorage.setItem('kogi:failed', JSON.stringify(failed));
    location.hash = `#/l/${lectureId}`;
  } },
  h('label', { for: 'number' }, '第◯回'), number,
  h('label', { for: 'date' }, '日付'), date,
  h('label', { for: 'audio' }, '🎧 音声（必須）'), audio,
  h('label', { for: 'note-photos' }, '✍️ メモの写真（何枚でも）'), notePhotos,
  h('label', { for: 'note-text' }, '✍️ 打ったメモ'), noteText,
  h('label', { for: 'handouts' }, '📄 レジュメ（PDF・写真を何枚でも）'), handouts,
  h('p', {}, submit), bar, status, msg);

  root.append(h('p', {}, h('a', { href: `#/s/${subjectId}` }, `← ${subject.name}`)), h('h1', {}, `${subject.name}：授業を追加`), form);
}
