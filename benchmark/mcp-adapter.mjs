/** MCP 适配层：stdio JSON-RPC 2.0（最小实现，零依赖），与 HTTP 共用 BenchService
 *  node benchmark/mcp-adapter.mjs   （供 MCP 客户端以 stdio 方式接入）
 *  工具与设计稿一致：register_team / list_exam_sets / get_exam_paper / submit_answers / get_task / get_leaderboard
 */
import { BenchService } from './core-service.mjs';

const svc = new BenchService();

const TOOLS = [
  { name: 'register_team', description: '注册参赛应用，返回 api_key（联网/非联网赛道二选一）', inputSchema: { type: 'object', properties: { name: { type: 'string' }, track: { type: 'string', enum: ['online', 'offline'] }, contact: { type: 'string' } }, required: ['name'] } },
  { name: 'list_exam_sets', description: '列出考集（公开dev/私有holdout）与版本、配额', inputSchema: { type: 'object', properties: { api_key: { type: 'string' } }, required: ['api_key'] } },
  { name: 'get_exam_paper', description: '领题（永不含答案；每应用固定乱序）', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, set_id: { type: 'string' } }, required: ['api_key', 'set_id'] } },
  { name: 'submit_answers', description: '交卷（离线答案模式），服务端评分 top1/topk/Brier/ECE/CI；私有集不回逐题对错', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, set_id: { type: 'string' }, dataset_version: { type: 'string' }, answers: { type: 'object' }, meta: { type: 'object' } }, required: ['api_key', 'set_id', 'dataset_version', 'answers'] } },
  { name: 'get_task', description: '查询评分任务', inputSchema: { type: 'object', properties: { api_key: { type: 'string' }, task_id: { type: 'string' } }, required: ['api_key', 'task_id'] } },
  { name: 'get_leaderboard', description: '榜单（联网/非联网分赛道）', inputSchema: { type: 'object', properties: { set_id: { type: 'string' } }, required: ['set_id'] } },
];

async function callTool(name, args) {
  switch (name) {
    case 'register_team': return svc.registerApp(args);
    case 'list_exam_sets': return svc.listSets(args.api_key);
    case 'get_exam_paper': return svc.getPaper(args.api_key, args.set_id);
    case 'submit_answers': return svc.submitAnswers(args.api_key, args);
    case 'get_task': return svc.getTask(args.api_key, args.task_id);
    case 'get_leaderboard': return svc.leaderboard(args.set_id);
    default: { const e = new Error(`unknown tool: ${name}`); e.status = 404; throw e; }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }) + '\n');
    try {
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'shenji-bench', version: '0.1.0' }, capabilities: { tools: {} } });
      else if (msg.method === 'notifications/initialized') { /* no reply for notification */ }
      else if (msg.method === 'tools/list') reply({ tools: TOOLS });
      else if (msg.method === 'tools/call') {
        const out = await callTool(msg.params.name, msg.params.arguments || {});
        reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } else if (msg.id !== undefined) reply(null, { code: -32601, message: `method not found: ${msg.method}` });
    } catch (e) {
      reply(null, { code: e.status || -32000, message: e.message });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
