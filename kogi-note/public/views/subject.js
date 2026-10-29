import { h, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';
import { statusLabel, isWorking } from '../lib/status.js';

const POLL_MS = 10000;

export async function render(root, [subjectId]) {
  let timer = null;
  const title = h('h1', {}, '…');
  const listBox = h('div');
  const actions = h('div', { class: 'row' });
  const glossary = h('textarea', { id: 'glossary', maxlength: 2000, placeholder: '例：帰無仮説、有意水準、p値、ベイズ推定\n（専門用語・人名・固有名詞。聞き間違いが減ります）' });
  const glossaryMsg = h('span', { class: 'meta', 'aria-live': 'polite' });
  const glossaryBox = h('details', { class: 'card' },
    h('summary', {}, '📚 用語リスト（文字起こしのヒント）'),
    h('p', { class: 'meta' }, 'この科目でよく出る言葉を書いておくと、Gemini が聞き取りに迷ったときにこの表記を使います。次に追加する授業から効きます。'),
    glossary,
    h('p', { class: 'row' }, h('button', { type: 'button', id: 'save-glossary', onclick: async () => {
      try {
        await apiFetch(`/api/subjects/${subjectId}`, { method: 'PATCH', json: { glossary: glossary.value } });
        glossaryMsg.textContent = '保存しました';
      } catch (err) {
        glossaryMsg.textContent = errorText(err);
      }
    } }, '保存'), glossaryMsg));

  async function load() {
    const { subject, lectures } = await apiFetch(`/api/subjects/${subjectId}/lectures`);
    title.textContent = subject.name;
    if (document.activeElement !== glossary) glossary.value = subject.glossary ?? '';
    listBox.replaceChildren(lectures.length
      ? h('ul', { class: 'list' }, lectures.map((l) => h('li', {}, h('a', { class: 'card', href: `#/l/${l.id}`, 'data-lecture': l.id },
        h('span', { class: 'grow' }, h('strong', {}, `第${l.number}回`), ' ', h('span', { class: 'meta' }, l.date)),
        h('span', { class: `badge ${l.status}` }, statusLabel(l))))))
      : h('p', { class: 'meta' }, 'まだ授業がありません'));
    clearTimeout(timer);
    if (lectures.some(isWorking)) timer = setTimeout(() => load().catch(() => {}), POLL_MS);
    return subject;
  }

  actions.append(
    h('a', { class: 'button primary', href: `#/s/${subjectId}/new` }, '＋授業を追加'),
    h('button', { type: 'button', onclick: async () => {
      const name = prompt('新しい科目名', title.textContent);
      if (!name?.trim()) return;
      try {
        await apiFetch(`/api/subjects/${subjectId}`, { method: 'PATCH', json: { name } });
        await load();
      } catch (err) {
        alert(errorText(err));
      }
    } }, '名前を変える'),
    h('button', { type: 'button', class: 'danger', onclick: async () => {
      if (!confirm(`「${title.textContent}」と、その授業を全部消します。よろしいですか？`)) return;
      try {
        await apiFetch(`/api/subjects/${subjectId}`, { method: 'DELETE' });
        location.hash = '#/';
      } catch (err) {
        alert(errorText(err));
      }
    } }, '科目を消す'),
  );

  root.append(h('p', {}, h('a', { href: '#/' }, '← 科目の一覧')), title, actions, glossaryBox, listBox);
  try {
    await load();
  } catch (err) {
    if (err.status !== 401) root.append(h('p', { class: 'notice error' }, errorText(err)));
  }
  return () => clearTimeout(timer);
}
