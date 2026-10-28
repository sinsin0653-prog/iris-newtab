// Gemini のニセモノ（Task 5・6 の REST の形だけを返す）
const http = require('http');

const SUMMARY = {
  theme: 'テストのテーマ',
  flow: [{ heading: '導入', detail: '説明', handout_pages: 'p.1' }],
  key_points: [{ point: '大事なポイント', time: '00:10', not_in_notes: true, kind: 'exam' }],
  announcements: [{ text: '来週は小テスト', time: '00:20' }],
};
const TRANSCRIPT = '[00:00] テストの講義です。\n[00:10] ここが大事なポイントです。\n[00:20] 来週は小テストです。';

function startMockGemini() {
  let seq = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, size: body.length });
      const url = `http://127.0.0.1:${server.address().port}`;
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.headers['x-goog-api-key'] !== 'x') return send(403, { error: { message: 'bad key' } });
      if (req.method === 'POST' && req.url === '/upload/v1beta/files') {
        seq += 1;
        return send(200, {}, { 'x-goog-upload-url': `${url}/upload/session/${seq}`, 'x-goog-upload-chunk-granularity': '8388608' });
      }
      if (req.method === 'POST' && req.url.startsWith('/upload/session/')) {
        const id = req.url.split('/').pop();
        if (req.headers['x-goog-upload-command'] === 'query') return send(200, {}, { 'x-goog-upload-size-received': '0' });
        if (String(req.headers['x-goog-upload-command']).includes('finalize')) {
          return send(200, { file: { name: `files/f${id}`, uri: `${url}/v1beta/files/f${id}`, state: 'ACTIVE', expirationTime: new Date(Date.now() + 48 * 3600e3).toISOString() } });
        }
        return send(200, {}, { 'x-goog-upload-status': 'active' });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1beta/files/')) return send(200, { name: req.url.slice(8), state: 'ACTIVE' });
      if (req.method === 'DELETE' && req.url.startsWith('/v1beta/files/')) return send(200, {});
      if (req.method === 'POST' && req.url.includes(':generateContent')) {
        const json = JSON.parse(body.toString());
        const text = json.generationConfig?.responseSchema ? JSON.stringify(SUMMARY) : TRANSCRIPT;
        return send(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
      }
      return send(404, { error: { message: `mock: ${req.method} ${req.url}` } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startMockGemini };
