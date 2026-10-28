// 入口：画面と API（fetch）と見回り（scheduled）
import { handleRequest } from './router.js';
import { createAi } from './ai/index.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env, { ai: createAi(env), now: Date.now() });
  },
  async scheduled() {},
};
