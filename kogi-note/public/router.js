// # のあとで画面を切り替える
export function startRouter(root, routes) {
  let cleanup = null;
  async function show() {
    const hash = location.hash;
    for (const [re, mod] of routes) {
      const m = re.exec(hash);
      if (!m) continue;
      if (typeof cleanup === 'function') cleanup();
      cleanup = null;
      root.replaceChildren();
      window.scrollTo(0, 0);
      cleanup = await mod.render(root, m.slice(1).map(decodeURIComponent));
      return;
    }
    location.replace('#/');
  }
  window.addEventListener('hashchange', show);
  show();
}
