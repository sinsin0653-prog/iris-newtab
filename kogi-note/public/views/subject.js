import { h, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';
import { statusLabel, isWorking } from '../lib/status.js';

const POLL_MS = 10000;

export async function render(root, [subjectId]) {
  let timer = null;
  const title = h('h1', {}, '…');
  const listBox = h('div');
  const actions = h('div', { class: 'row' });

  async function load() {
    const { subject, lectures } = await apiFetch(`/api/subjects/${subjectId}/lectures`);
    title.textContent = subject.name;
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

  root.append(h('p', {}, h('a', { href: '#/' }, '← 科目の一覧')), title, actions, listBox);
  try {
    await load();
  } catch (err) {
    if (err.status !== 401) root.append(h('p', { class: 'notice error' }, errorText(err)));
  }
  return () => clearTimeout(timer);
}
