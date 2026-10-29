// 入口
import { startRouter } from './router.js';
import { apiFetch } from './api.js';
import * as home from './views/home.js';
import * as login from './views/login.js';
import * as subject from './views/subject.js';
import * as newLecture from './views/new-lecture.js';
import * as lecture from './views/lecture.js';

const logoutButton = document.getElementById('logout');
logoutButton.addEventListener('click', async () => {
  await apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.hash = '#/login';
});
window.addEventListener('hashchange', () => { logoutButton.hidden = location.hash === '#/login'; });
logoutButton.hidden = location.hash === '#/login';

startRouter(document.getElementById('app'), [
  [/^#\/$/, home],
  [/^#\/login$/, login],
  [/^#\/s\/([^/]+)$/, subject],
  [/^#\/s\/([^/]+)\/new$/, newLecture],
  [/^#\/l\/([^/]+)$/, lecture],
]);
