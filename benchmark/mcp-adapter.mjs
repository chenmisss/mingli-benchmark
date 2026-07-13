/** MCP 适配层：stdio JSON-RPC 2.0（最小实现，零依赖），与 HTTP 共用 BenchService
 *  node benchmark/mcp-adapter.mjs   （供 MCP 客户端以 stdio 方式接入）
 *  工具与设计稿一致：register_team / list_exam_sets / get_exam_paper / submit_answers / get_task / get_leaderboard
 */
import { BenchService } from './core-service.mjs';
import { MCP_TOOLS, callMcpTool, initializeResult } from './mcp-tools.mjs';

const svc = new BenchService();

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
      if (msg.method === 'initialize') reply(initializeResult(msg.params?.protocolVersion));
      else if (msg.method === 'notifications/initialized') { /* no reply for notification */ }
      else if (msg.method === 'tools/list') reply({ tools: MCP_TOOLS });
      else if (msg.method === 'tools/call') {
        const out = await callMcpTool(svc, msg.params.name, msg.params.arguments || {});
        reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } else if (msg.id !== undefined) reply(null, { code: -32601, message: `method not found: ${msg.method}` });
    } catch (e) {
      reply(null, { code: e.status || -32000, message: e.message });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
