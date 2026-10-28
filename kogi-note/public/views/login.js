import { h, errorText } from '../lib/dom.js';
import { apiFetch } from '../api.js';

export function render(root) {
  const input = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const msg = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const button = h('button', { class: 'primary', type: 'submit' }, '入る');
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true;
    msg.hidden = true;
    try {
      await apiFetch('/api/login', { method: 'POST', json: { password: input.value } });
      location.hash = '#/';
    } catch (err) {
      msg.textContent = errorText(err);
      msg.hidden = false;
      input.select();
    } finally {
      button.disabled = false;
    }
  } },
  h('h1', {}, 'ログイン'),
  h('label', { for: 'password' }, 'パスワード'),
  input, msg,
  h('p', {}, button));
  root.append(form);
  input.focus();
}
