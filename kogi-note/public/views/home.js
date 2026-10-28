import { h, formatDate, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';

export async function render(root) {
  const results = h('div', { 'aria-live': 'polite' });
  const q = h('input', { type: 'search', id: 'search', placeholder: '文字起こしと要約から探す', enterkeyhint: 'search' });
  const searchForm = h('form', { role: 'search', onsubmit: async (e) => {
    e.preventDefault();
    const text = q.value.trim();
    results.replaceChildren();
    if (!text) return;
    try {
      const { results: hits } = await apiFetch(`/api/search?q=${encodeURIComponent(text)}`);
      if (!hits.length) {
        results.append(h('p', { class: 'meta' }, '見つかりませんでした'));
        return;
      }
      results.append(h('ul', { class: 'list' }, hits.map((r) => h('li', {}, h('a', { class: 'card', href: `#/l/${r.lecture_id}` },
        h('span', { class: 'grow' },
          h('strong', {}, `${r.subject_name} 第${r.number}回`), ' ', h('span', { class: 'meta' }, `（${r.date}）`),
          h('br'), h('span', { class: 'meta' }, r.snippet || '要約に一致')))))));
    } catch (err) {
      results.append(h('p', { class: 'notice error' }, errorText(err)));
    }
  } }, q);

  const listBox = h('div');
  const name = h('input', { type: 'text', id: 'new-subject', placeholder: '例：心理学', maxlength: 100 });
  const addForm = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    try {
      await apiFetch('/api/subjects', { method: 'POST', json: { name: name.value } });
      name.value = '';
      await load();
    } catch (err) {
      alert(errorText(err));
    }
  } }, h('div', { class: 'grow' }, name), h('button', { class: 'primary', type: 'submit' }, '＋科目を追加'));

  const warn = h('p', { class: 'notice warn', hidden: true }, '置き場が8割を超えました。いらない授業を消してね');

  async function load() {
    const [{ subjects }, usage] = await Promise.all([apiFetch('/api/subjects'), apiFetch('/api/usage')]);
    warn.hidden = !usage.warn;
    listBox.replaceChildren(subjects.length
      ? h('ul', { class: 'list' }, subjects.map((s) => h('li', {}, h('a', { class: 'card', href: `#/s/${s.id}` },
        h('strong', { class: 'grow' }, s.name),
        h('span', { class: 'meta' }, `${s.lecture_count}回 ・ ${formatDate(s.last_updated)}`)))))
      : h('p', { class: 'meta' }, 'まだ科目がありません。下から追加してね'));
  }

  root.append(h('h1', {}, '科目'), searchForm, results, warn, listBox, h('h2', {}, '科目を追加'), addForm);
  try {
    await load();
  } catch (err) {
    if (err.status !== 401) root.append(h('p', { class: 'notice error' }, errorText(err)));
  }
}
