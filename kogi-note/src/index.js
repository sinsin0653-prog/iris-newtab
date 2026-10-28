// 入口：画面と API（fetch）と見回り（scheduled）

export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
  async scheduled() {},
};
