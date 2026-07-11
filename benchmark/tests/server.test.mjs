import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { BenchService, optionPermutation, assertPublicHost, datasetHash } from '../core-service.mjs';
import { createApp } from '../server.mjs';

let server, base, svc, tmp, mockServer, mockUrl;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-var-'));
  svc = new BenchService({ varDir: tmp, quotaPerSet: 3, rateLimitPerMin: 500, allowPrivateEndpoints: true, disableHostedEndpoint: false }); // 显式开托管endpoint测功能；安全默认(关)单独测
  server = createApp(svc).listen(0);
  base = `http://localhost:${server.address().port}`;
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const { records } = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ answers: Object.fromEntries(records.map(r => [r.id, 'A'])) }));
    });
  }).listen(0);
  mockUrl = `http://localhost:${mockServer.address().port}/predict`;
});
after(() => { server.close(); mockServer.close(); });

const j = async (method, p, body, key) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const poll = async (taskId, key) => { for (let i = 0; i < 60; i++) { const t = await j('GET', `/v1/tasks/${taskId}`, null, key); if (t.body.status !== 'running') return t; await new Promise(r => setTimeout(r, 40)); } throw new Error('poll timeout'); };
const strip = (s) => s.replace(/^[A-E][.、)\s]*/, '');
// 白盒：用服务端 gold 造某集显示空间的完美答案
const perfectAnswers = (setId, appId) => {
  const out = {};
  for (const r of svc.sets[setId].records) {
    if (svc.sets[setId].goldPublic) { out[r.id] = r.answer; continue; }
    const goldText = strip(r.options.find(x => x.trim().charAt(0) === r.answer));
    out[r.id] = svc._displayOptions(appId, setId, r).find(x => strip(x) === goldText).trim().charAt(0);
  }
  return out;
};

let apiKey, appId, version;

test('注册+列考集（public_dev/public_test/private；private官方quota=1）', async () => {
  const r = await j('POST', '/v1/apps/register', { name: '测试青囊', track: 'offline' });
  assert.equal(r.status, 200);
  apiKey = r.body.apiKey; appId = r.body.appId; version = r.body.datasetVersion;
  assert.ok(apiKey.startsWith('bk_'));
  const sets = await j('GET', '/v1/sets', null, apiKey);
  assert.deepEqual(sets.body.map(s => s.set_id).sort(), ['private', 'public_dev', 'public_test']);
  assert.ok(sets.body.every(s => s.requires_full_coverage === true));
  const priv = sets.body.find(s => s.set_id === 'private');
  assert.equal(priv.official, true);
  assert.equal(priv.quota_per_app, 1);
});

test('[Medium] API key 以哈希存储，明文不落盘', () => {
  const app = Object.values(svc.apps)[0];
  assert.ok(app.keyHash && !('apiKey' in app), 'app 记录不得含明文 key');
  assert.ok(!fs.readFileSync(path.join(tmp, 'apps.json'), 'utf8').includes('bk_'), 'apps.json 不得含明文 key');
});

test('[High] 数据版本哈希覆盖题面内容（改题干即升级）', () => {
  const rec = { id: 'a', year: 2024, subject_id: 's', birth: null, gender: null, question: 'Q1', options: ['A.1', 'B.2', 'C.3', 'D.4'], answer: 'A', category: 'other', split: 'holdout' };
  assert.equal(datasetHash([rec], 'v1'), datasetHash([rec], 'v1'), '同内容同版本');
  assert.notEqual(datasetHash([rec], 'v1'), datasetHash([{ ...rec, question: 'Q1改' }], 'v1'), '改题干必须升级版本');
});

test('无key访问401；领题gold永不下发', async () => {
  assert.equal((await j('GET', '/v1/papers/public_test')).status, 401);
  for (const setId of ['public_dev', 'public_test']) {
    const r = await j('GET', `/v1/papers/${setId}`, null, apiKey);
    assert.equal(r.status, 200);
    assert.ok(r.body.records.every(rec => !('answer' in rec) && !('split' in rec)), `${setId} 泄漏gold`);
  }
});

test('[Critical] 一题攻击无法登顶：不满覆盖不入榜', async () => {
  const perfect = perfectAnswers('public_test', appId);
  const oneId = Object.keys(perfect)[0];
  const sub = await j('POST', '/v1/submissions', { set_id: 'public_test', dataset_version: version, answers: { [oneId]: perfect[oneId] } }, apiKey);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.admitted, false, '单题提交 coverage<100% 不得入榜');
  const lb = await j('GET', '/v1/leaderboard/public_test');
  assert.equal(lb.body.tracks.offline.length + lb.body.tracks.online.length, 0, '无满覆盖提交时榜单为空');
});

test('满覆盖入榜；public_test即时揭晓精确成绩', async () => {
  const perfect = perfectAnswers('public_test', appId);
  const sub = await j('POST', '/v1/submissions', { set_id: 'public_test', dataset_version: version, answers: perfect, meta: { model: 'oracle' } }, apiKey);
  assert.equal(sub.body.admitted, true);
  const task = await j('GET', `/v1/tasks/${sub.body.task_id}`, null, apiKey);
  assert.equal(task.body.result.top1, 1, 'public_test 答案已公开→揭晓精确');
  assert.equal(task.body.result.coverage, 1);
  const lb = await j('GET', '/v1/leaderboard/public_test');
  assert.ok(lb.body.tracks.offline.some(r => r.top1 === 1), '满分提交上榜');
});

test('[Critical] 缺答按错计入全集分母', () => {
  const perfect = perfectAnswers('public_test', appId);
  const half = Object.fromEntries(Object.entries(perfect).slice(0, 40)); // 只答一半且全对
  const { metrics } = svc._score('public_test', half, appId);
  assert.equal(metrics.scoreableN, 80);
  assert.equal(metrics.answeredN, 40);
  assert.ok(Math.abs(metrics.top1 - 0.5) < 1e-9, '全集top1=40/80=50%（缺答记错）');
  assert.equal(metrics.conditionalTop1, 1, '条件口径=已答全对=100%');
});

test('选项重映射：public_test打乱、public_dev不变、确定性', async () => {
  const k = (await j('POST', '/v1/apps/register', { name: '映射队' }, )).body.apiKey;
  const reg = await j('POST', '/v1/apps/register', { name: '映射队2' });
  const paper = (await j('GET', '/v1/papers/public_test', null, reg.body.apiKey)).body;
  const rec = paper.records[0];
  const orig = svc.sets.public_test.records.find(r => r.id === rec.id);
  assert.deepEqual([...rec.options.map(strip)].sort(), [...orig.options.map(strip)].sort(), '重排是同一集合');
  const devPaper = (await j('GET', '/v1/papers/public_dev', null, reg.body.apiKey)).body;
  const dOrig = svc.sets.public_dev.records.find(r => r.id === devPaper.records[0].id);
  assert.deepEqual(devPaper.records[0].options.map(strip), dOrig.options.map(strip), 'public_dev不重映射');
  assert.deepEqual(optionPermutation('X', 'public_test', 'r', 4), optionPermutation('X', 'public_test', 'r', 4));
  assert.notDeepEqual(optionPermutation('X', 'public_test', 'r', 4), optionPermutation('Y', 'public_test', 'r', 4));
});

test('public_dev可下载含gold；public_test/private下载403', async () => {
  assert.ok((await j('GET', '/v1/datasets/public_dev', null, apiKey)).body.records.every(r => r.answer));
  assert.equal((await j('GET', '/v1/datasets/public_test', null, apiKey)).status, 403);
  assert.equal((await j('GET', '/v1/datasets/private', null, apiKey)).status, 403);
});

test('版本不符409；重复提交409', async () => {
  const perfect = perfectAnswers('public_test', appId);
  assert.equal((await j('POST', '/v1/submissions', { set_id: 'public_test', dataset_version: 'v0#stale', answers: perfect }, apiKey)).status, 409);
  assert.equal((await j('POST', '/v1/submissions', { set_id: 'public_test', dataset_version: version, answers: perfect, meta: { model: 'oracle' } }, apiKey)).status, 409, '相同答案重复提交拒绝');
});

test('配额上限429', async () => {
  const reg = await j('POST', '/v1/apps/register', { name: '配额队' });
  const k = reg.body.apiKey;
  const perfect = perfectAnswers('public_dev', reg.body.appId);
  const ids = Object.keys(perfect);
  for (let i = 0; i < 3; i++) { const a = { ...perfect }; a[ids[i]] = 'A'; a[ids[i + 3]] = 'B'; await j('POST', '/v1/submissions', { set_id: 'public_dev', dataset_version: version, answers: a }, k); }
  const a = { ...perfect }; a[ids[9]] = 'C';
  assert.equal((await j('POST', '/v1/submissions', { set_id: 'public_dev', dataset_version: version, answers: a }, k)).status, 429);
});

test('[High] 托管endpoint强制online、异步返回running', async () => {
  const reg = await j('POST', '/v1/apps/register', { name: '端点队', track: 'offline' }); // 注册offline
  const k = reg.body.apiKey;
  const r = await j('POST', '/v1/submissions/endpoint', { set_id: 'public_test', dataset_version: version, endpoint_url: mockUrl, meta: { uses_network: false } }, k); // 谎报false
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'running', '异步：立即返回running');
  const task = await poll(r.body.task_id, k);
  assert.equal(task.body.status, 'done');
  assert.equal(task.body.track, 'online', 'endpoint无视自报强制online');
});

test('[High] SSRF：内网/环回/元数据/明文http被拒', async () => {
  for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', 'localhost', '::1', '172.16.0.1']) {
    await assert.rejects(() => assertPublicHost(h), /private|not allowed|not resolve/, `应拒绝 ${h}`);
  }
  const denySvc = new BenchService({ varDir: tmp + '-deny', quotaPerSet: 3, disableHostedEndpoint: false }); // 开endpoint以测SSRF拒绝路径
  const app = denySvc.registerApp({ name: 'ssrf队', track: 'online' });
  await assert.rejects(() => denySvc.submitEndpoint(app.apiKey, { set_id: 'public_test', dataset_version: denySvc.datasetVersion, endpoint_url: 'https://169.254.169.254/latest/meta-data' }), /private|not allowed/, 'https云元数据地址仍须拒绝');
  await assert.rejects(() => denySvc.submitEndpoint(app.apiKey, { set_id: 'public_test', dataset_version: denySvc.datasetVersion, endpoint_url: 'http://example.com/predict' }), /https/, '明文http必须拒绝');
});

test('[Critical] 官方private集默认不揭晓精确成绩', () => {
  const lb = svc.leaderboard('private');
  assert.equal(lb.official, true);
  assert.equal(lb.results_revealed, false);
  assert.ok(!('tracks' in lb), '未揭晓集不得回逐条榜');
});

test('[阻塞1修复] 托管endpoint安全默认关闭', () => {
  const secure = new BenchService({ varDir: tmp + '-secure' }); // 默认(disableHostedEndpoint=true)
  const app = secure.registerApp({ name: '默认队', track: 'online' });
  return assert.rejects(() => secure.submitEndpoint(app.apiKey, { set_id: 'public_test', dataset_version: secure.datasetVersion, endpoint_url: 'https://example.com/p' }), /disabled/, '默认应关托管endpoint');
});

test('[阻塞2修复] 非揭晓集零泄露：无分数/桶/名次，只回提交数', () => {
  const s = new BenchService({ varDir: tmp + '-leak' });
  s.sets.public_test.revealResults = false; // 强制非揭晓，走私有集路径
  const app = s.registerApp({ name: '泄露测试', track: 'offline' });
  const paper = s.getPaper(app.apiKey, 'public_test');
  const ans = Object.fromEntries(paper.records.map(r => [r.id, 'A']));
  const sub = s.submitAnswers(app.apiKey, { set_id: 'public_test', dataset_version: s.datasetVersion, answers: ans });
  assert.ok(!('coarse' in sub) && !('result' in sub), '提交回执不得含分数/桶');
  const t = s.getTask(app.apiKey, sub.task_id);
  assert.ok(!('coarse' in t) && !('result' in t), 'getTask 非揭晓不得回分数/桶');
  const lb = s.leaderboard('public_test');
  assert.ok(!('tracks' in lb), 'leaderboard 非揭晓不得回逐条');
  assert.equal(lb.submissions_count, 1);
});

test('榜单显著性 p_vs_top/p_vs_prev 且逐题hits不下发', async () => {
  const reg = await j('POST', '/v1/apps/register', { name: '乙队' });
  const perfect = perfectAnswers('public_test', reg.body.appId);
  const noisy = { ...perfect }; Object.keys(noisy).slice(0, 3).forEach(id => noisy[id] = 'A');
  const sub = await j('POST', '/v1/submissions', { set_id: 'public_test', dataset_version: version, answers: noisy, meta: { model: '乙' } }, reg.body.apiKey);
  const t = await j('GET', `/v1/tasks/${sub.body.task_id}`, null, reg.body.apiKey);
  assert.ok(!('hits' in t.body), 'getTask 泄漏逐题对错');
  const lb = (await j('GET', '/v1/leaderboard/public_test')).body;
  assert.ok(lb.note.includes('配对置换'));
  const off = lb.tracks.offline;
  assert.ok(off.length >= 2, '需≥2满覆盖提交');
  assert.equal(off[0].p_vs_top, null);
  assert.ok(typeof off[1].p_vs_top === 'number' && off[1].p_vs_top >= 0 && off[1].p_vs_top <= 1);
});

test('审计日志落盘', () => {
  const acts = new Set(fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l).action));
  for (const a of ['register', 'get_paper', 'submit_answers', 'submit_endpoint']) assert.ok(acts.has(a), `审计缺${a}`);
});

test('[Medium] 原子写：apps/submissions为完整合法JSON', () => {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tmp, 'apps.json'), 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tmp, 'submissions.json'), 'utf8')));
});
