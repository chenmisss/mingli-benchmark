import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let proc, tmp, nextId = 1;
const pending = new Map();

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mcp-'));
  proc = spawn(process.execPath, [path.join(HERE, '../mcp-adapter.mjs')], { env: { ...process.env, BENCH_VAR_DIR: tmp }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });
});
after(() => proc.kill());

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, 8000);
});
const toolCall = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return JSON.parse(r.result.content[0].text);
};

test('MCP: initialize + tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'shenji-bench');
  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['get_exam_paper', 'get_leaderboard', 'get_task', 'list_exam_sets', 'register_team', 'submit_answers']);
});

test('MCP: 注册→领题(无gold)→交卷→评分→榜单 全流程', async () => {
  const reg = await toolCall('register_team', { name: 'MCP测试队', track: 'offline' });
  assert.ok(reg.apiKey);
  const sets = await toolCall('list_exam_sets', { api_key: reg.apiKey });
  assert.ok(sets.find(s => s.set_id === 'public_test'));
  const paper = await toolCall('get_exam_paper', { api_key: reg.apiKey, set_id: 'public_test' });
  assert.ok(paper.records.length > 0);
  assert.ok(paper.records.every(r => !('answer' in r)), 'MCP试卷不得含gold');
  const answers = Object.fromEntries(paper.records.map(r => [r.id, 'C']));
  const sub = await toolCall('submit_answers', { api_key: reg.apiKey, set_id: 'public_test', dataset_version: paper.dataset_version, answers, meta: { model: 'all-C' } });
  const task = await toolCall('get_task', { api_key: reg.apiKey, task_id: sub.task_id });
  assert.equal(task.status, 'done');
  assert.ok(task.result.top1 >= 0);
  const lb = await toolCall('get_leaderboard', { set_id: 'public_test' });
  assert.ok(lb.tracks.offline.length >= 1);
});

test('MCP: 错误传播（未知考集404）', async () => {
  const reg = await toolCall('register_team', { name: '错误队' });
  await assert.rejects(() => toolCall('get_exam_paper', { api_key: reg.apiKey, set_id: 'nope' }), /unknown set/);
});
