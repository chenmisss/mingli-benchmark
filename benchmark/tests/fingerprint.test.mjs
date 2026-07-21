/** 反作弊机制测试：客户端指纹、疑似标注(同源多应用/短时跃升/人工)、官方集领题时窗、原始作答留存 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BenchService } from '../core-service.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fp-'));
const OPTS = ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'];
const mkRec = (id, answer) => ({
  id, year: 2026, subject_id: `s-${id}`, birth: { year: 1980, month: 1, day: 15, hour: 10, minute: 0 },
  gender: 'male', question: `题${id}?`, options: OPTS, answer, category: 'other', split: 'holdout',
});
const CLIENT_A = { ip: '203.0.113.7', ua: 'claude-code/2.1 (cli)' };
const CLIENT_B = { ip: '198.51.100.9', ua: 'codex/1.0' };

function freshSvc(records, suffix, { official = false } = {}) {
  const svc = new BenchService({ varDir: path.join(tmp, suffix) });
  svc.sets.t = { records, goldPublic: false, revealResults: !official, official, disclosure: 'test' };
  return svc;
}
const submit = (svc, app, ans, client) => svc.submitAnswers(app.apiKey, { set_id: 't', dataset_version: svc.datasetVersion, answers: ans }, client);

test('指纹落库：注册存regFp、提交存fp(加盐哈希非明文)，且不出现在榜单行', () => {
  const svc = freshSvc([mkRec('r1', 'A')], 'v1');
  const app = svc.registerApp({ name: '指纹队', track: 'offline' }, CLIENT_A);
  const stored = svc.apps[app.appId];
  assert.ok(/^[0-9a-f]{16}$/.test(stored.regFp), 'regFp应为16位hex');
  assert.ok(!JSON.stringify(stored).includes(CLIENT_A.ip), '不得存明文IP');
  svc.getPaper(app.apiKey, 't');
  submit(svc, app, { r1: 'A' }, CLIENT_A);
  const t = Object.values(svc.subs)[0];
  assert.equal(t.fp, stored.regFp, '同客户端注册/提交指纹一致');
  assert.deepEqual(t.answersRaw, { r1: 'A' }, '原始作答留存');
  const lb = svc.leaderboard('t');
  assert.ok(!JSON.stringify(lb).includes(stored.regFp), '指纹绝不下发到榜单');
});

test('同源多应用：同指纹两个应用上榜→两行都标"同源多应用"', () => {
  const svc = freshSvc([mkRec('r1', 'A')], 'v2');
  const a1 = svc.registerApp({ name: '马甲一号', track: 'offline' }, CLIENT_A);
  const a2 = svc.registerApp({ name: '马甲二号', track: 'offline' }, CLIENT_A);
  svc.getPaper(a1.apiKey, 't'); svc.getPaper(a2.apiKey, 't');
  submit(svc, a1, { r1: 'A' }, CLIENT_A);
  submit(svc, a2, { r1: 'B' }, CLIENT_A);
  const rows = [...svc.leaderboard('t').tracks.offline];
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => (r.flags || []).includes('同源多应用')), JSON.stringify(rows.map(r => r.flags)));
  // 对照：不同指纹的第三应用不被标
  const a3 = svc.registerApp({ name: '清白队', track: 'offline' }, CLIENT_B);
  svc.getPaper(a3.apiKey, 't');
  submit(svc, a3, { r1: 'C' }, CLIENT_B);
  const rows2 = svc.leaderboard('t').tracks.offline;
  const clean = rows2.find(r => r.app === '清白队');
  assert.ok(!clean.flags, '不同源不得误标');
});

test('短时跃升：同应用1小时内成绩+≥15pp→标"短时跃升"', () => {
  const recs = 'abcdefghij'.split('').map((c, i) => mkRec(`r${i}`, 'A'));
  const svc = freshSvc(recs, 'v3');
  const app = svc.registerApp({ name: '爬坡队', track: 'offline' }, CLIENT_B);
  svc.getPaper(app.apiKey, 't');
  // 第一笔全错(用显示空间任意字母,可能蒙对些——直接改result更稳)
  submit(svc, app, Object.fromEntries(recs.map(r => [r.id, 'A'])), CLIENT_B);
  submit(svc, app, Object.fromEntries(recs.map(r => [r.id, 'B'])), CLIENT_B);
  const [t1, t2] = Object.values(svc.subs).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  // 固化分差免受置换蒙对扰动：删 answersRaw 让榜单回退到存档分(否则 _rescore 会按真答案重算、忽略此处patch)
  t1.result.top1 = 0.10; t2.result.top1 = 0.45; delete t1.answersRaw; delete t2.answersRaw;
  const rows = svc.leaderboard('t').tracks.offline;
  const hi = rows.find(r => r.top1 === 0.45), lo = rows.find(r => r.top1 === 0.10);
  assert.ok((hi.flags || []).includes('短时跃升≥15pp/小时'), JSON.stringify(hi));
  assert.ok(!(lo.flags || []).includes('短时跃升≥15pp/小时'), '首笔不标');
});

test('人工标注：apps.flag→榜单行带"人工标注:..."', () => {
  const svc = freshSvc([mkRec('r1', 'A')], 'v4');
  const app = svc.registerApp({ name: '被标注队', track: 'offline' }, CLIENT_B);
  svc.getPaper(app.apiKey, 't');
  submit(svc, app, { r1: 'A' }, CLIENT_B);
  svc.apps[app.appId].flag = '疑似刷分(审计留档)';
  const row = svc.leaderboard('t').tracks.offline[0];
  assert.ok((row.flags || []).some(f => f === '人工标注:疑似刷分(审计留档)'), JSON.stringify(row));
});

test('官方集领题时窗：未领题409、过期409、窗口内放行', () => {
  const svc = freshSvc([mkRec('r1', 'A')], 'v5', { official: true });
  const app = svc.registerApp({ name: '时窗队', track: 'offline' }, CLIENT_B);
  assert.throws(() => submit(svc, app, { r1: 'A' }, CLIENT_B), /paper first/, '未领题应409');
  svc.getPaper(app.apiKey, 't');
  svc.apps[app.appId].paperAt.t = new Date(Date.now() - 100 * 3600_000).toISOString();
  assert.throws(() => submit(svc, app, { r1: 'A' }, CLIENT_B), /window expired/, '过期应409');
  svc.apps[app.appId].paperAt.t = new Date().toISOString();
  const sub = submit(svc, app, { r1: 'A' }, CLIENT_B);
  assert.ok(sub.task_id, '窗口内应放行');
});

test('非官方集不受时窗约束(未领题也可提交,兼容离线答案文件流程)', () => {
  const svc = freshSvc([mkRec('r1', 'A')], 'v6');
  const app = svc.registerApp({ name: '直提队', track: 'offline' }, CLIENT_B);
  const sub = submit(svc, app, { r1: 'A' }, CLIENT_B);
  assert.ok(sub.task_id);
});
