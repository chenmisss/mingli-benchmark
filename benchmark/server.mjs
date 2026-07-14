/** 参考 HTTP 服务。OpenAPI 见 benchmark/openapi.yaml
 *  本地: node benchmark/server.mjs [--port 8787]
 *  Cloud Run: 读 process.env.PORT，绑 0.0.0.0（设 BENCH_ON_CLOUDRUN=1 或提供 PORT）
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { BenchService } from './core-service.mjs';
import { MCP_TOOLS, callMcpTool, initializeResult } from './mcp-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createApp(svc = new BenchService()) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const key = (req) => String(req.headers['x-api-key'] || '');
  // 客户端指纹原料：Cloud Run 的 x-forwarded-for 首跳 + UA；core层加盐哈希后只存哈希
  const clientOf = (req) => ({
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '',
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  });

  app.post('/v1/apps/register', wrap((req) => svc.registerApp(req.body || {}, clientOf(req))));
  app.get('/v1/sets', wrap((req) => svc.listSets(key(req))));
  app.get('/v1/papers/:setId', wrap((req) => svc.getPaper(key(req), req.params.setId)));
  app.get('/v1/datasets/:setId', wrap((req) => svc.downloadDataset(key(req), req.params.setId)));
  app.post('/v1/submissions', wrap((req) => svc.submitAnswers(key(req), req.body || {}, clientOf(req))));
  app.post('/v1/submissions/endpoint', wrap((req) => svc.submitEndpoint(key(req), req.body || {})));
  app.get('/v1/tasks/:taskId', wrap((req) => svc.getTask(key(req), req.params.taskId)));
  app.get('/v1/leaderboard/:setId', wrap((req) => svc.leaderboard(req.params.setId)));
  app.get('/v1/health', (req, res) => res.json({ ok: true, dataset_version: svc.datasetVersion }));

  // 远程 MCP：无会话 Streamable HTTP。POST 返回 JSON；本服务不提供服务端 SSE 通知流。
  // API key 作为工具参数传递，便于智能体先注册、再在同一会话内完成领题与提交。
  app.post('/mcp', async (req, res) => {
    const origin = String(req.headers.origin || '');
    const allowedOrigins = new Set(['https://bench.sjms.ai', 'https://sjms.ai']);
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'origin not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    const msg = req.body;
    if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return res.status(400).json({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (msg.id === undefined) {
      // MCP 通知没有响应体；202 表示已接收。
      return res.status(202).end();
    }
    const reply = (result) => res.json({ jsonrpc: '2.0', id: msg.id, result });
    try {
      if (msg.method === 'initialize') return reply(initializeResult(msg.params?.protocolVersion));
      if (msg.method === 'ping') return reply({});
      if (msg.method === 'tools/list') return reply({ tools: MCP_TOOLS });
      if (msg.method === 'tools/call') {
        const out = await callMcpTool(svc, msg.params?.name, msg.params?.arguments || {}, clientOf(req));
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      }
      return res.status(404).json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    } catch (error) {
      return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 500).json({
        jsonrpc: '2.0', id: msg.id, error: { code: error.status || -32000, message: error.message },
      });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'This MCP server uses POST-only Streamable HTTP without an SSE notification stream.' }));
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP sessions do not require DELETE.' }));

  // 排行榜落地页 + OpenAPI（静态）
  app.get('/openapi.yaml', (req, res) => res.type('text/yaml').sendFile(path.join(HERE, 'openapi.yaml')));
  app.use(express.static(path.join(HERE, 'public')));
  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const onCloudRun = !!process.env.PORT || process.env.BENCH_ON_CLOUDRUN === '1';
  const port = Number(process.env.PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8787));
  const host = process.env.BENCH_HOST || (onCloudRun ? '0.0.0.0' : '127.0.0.1'); // Cloud Run 需 0.0.0.0；本地默认仅本机
  const start = async () => {
    let svc;
    if (onCloudRun) {
      const { FirestoreStore } = await import('./firestore-store.mjs'); // 惰性载入，仅云端
      const store = new FirestoreStore({ prefix: process.env.BENCH_FS_PREFIX || 'bench_' });
      svc = new BenchService({
        store,
        disableHostedEndpoint: process.env.BENCH_ALLOW_ENDPOINT !== '1', // 云端默认关托管endpoint（消SSRF面）
        requireRegToken: process.env.BENCH_REG_TOKEN || null,
      });
      await svc.init(); // 从 Firestore 载入既有 apps/subs
      console.log('[bench] loaded from Firestore:', Object.keys(svc.apps).length, 'apps,', Object.keys(svc.subs).length, 'subs');
    } else {
      svc = new BenchService();
    }
    createApp(svc).listen(port, host, () => console.log(`[bench] server on http://${host}:${port}${onCloudRun ? ' (cloud run + firestore)' : ' (local)'}`));
  };
  start().catch(e => { console.error('[bench] startup failed:', e); process.exit(1); });
}
