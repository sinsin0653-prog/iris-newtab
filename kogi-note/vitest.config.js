import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, APP_PASSWORD: 'test-pass', SESSION_SECRET: 'test-secret', GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-model' } },
    })],
    test: { include: ['test/**/*.test.js'], setupFiles: ['./test/setup.js'] },
  };
});
