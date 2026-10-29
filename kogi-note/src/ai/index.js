// AI の差し替え口。見回りや API はここが返すオブジェクトだけを使う
import { createGemini } from './gemini.js';
import { config } from '../config.js';

export function createAi(env) {
  const cfg = config(env);
  return createGemini({ apiKey: env.GEMINI_API_KEY, model: cfg.geminiModel, baseUrl: cfg.geminiBaseUrl, fetch: globalThis.fetch.bind(globalThis) });
}
