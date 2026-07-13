/** 对照题(安慰剂/阴性对照)机制测试：
 *  1. 对照题不进排名指标(top1/hits/scoreableN)  2. 对照题单独统计(control.n/top1/chance)
 *  3. 覆盖率含对照题(跳对照题→不入榜)  4. 对照题超机会水平→审计报警
 *  5. origin 切片统计  6. datasetHash 对无新字段的旧数据保持不变
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BenchService, optionPermutation, datasetHash } from '../core-service.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ctl-'));
const OPTS = ['A. 甲案', 'B. 乙案', 'C. 丙案', 'D. 丁案'];
const mkRec = (id, answer, extra = {}) => ({
  id, year: 2026, subject_id: `s-${id}`, birth: { year: 1980, month: 1, day: 15, hour: 10, minute: 0 },
  gender: 'male', question: `测试题${id}?`, options: OPTS, answer, category: 'other', split: 'holdout', ...extra,
});

/** 在显示空间构造"命中原始答案 X"的作答字母 */
const displayLetterFor = (appId, setId, rec, originalLetter) => {
  const perm = optionPermutation(appId, setId, rec.id, rec.options.length);
  const oi = 'ABCDE'.indexOf(originalLetter);
  return 'ABCDE'[perm.indexOf(oi)];
};

function freshSvc(records, varSuffix) {
  const svc = new BenchService({ varDir: path.join(tmp, varSuffix) });
  svc.sets.testctl = { records, goldPublic: false, revealResults: true, official: false, disclosure: 'test' };
  return svc;
}

test('对照题不计排名分且单独统计；origin切片；hits不含对照', () => {
  const records = [
    mkRec('r1', 'A', { origin: 'nianpu' }), mkRec('r2', 'B', { origin: 'nianpu' }),
    mkRec('r3', 'C', { origin: 'guji' }), mkRec('r4', 'D', { origin: 'guji' }),
    mkRec('c1', 'A', { origin: 'synthetic', control: true }), mkRec('c2', 'B', { origin: 'synthetic', control: true }),
  ];
  const svc = freshSvc(records, 'v1');
  const app = svc.registerApp({ name: '对照测试', track: 'offline' });
  // 计分题全对 + 对照题全错（答非金标）
  const ans = {};
  for (const r of records) {
    const target = r.control ? (r.answer === 'A' ? 'B' : 'A') : r.answer;
    ans[r.id] = displayLetterFor(app.appId, 'testctl', r, target);
  }
  const sub = svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.equal(t.result.scoreableN, 4, '计分题数=4(对照排除)');
  assert.equal(t.result.top1, 1, '排名分只看计分题=满分');
  assert.equal(t.result.coverage, 1, '全答→覆盖率1');
  assert.equal(t.result.control.n, 2);
  assert.equal(t.result.control.top1, 0, '对照题全错');
  assert.ok(Math.abs(t.result.control.chance - 0.25) < 1e-9);
  assert.deepEqual(Object.keys(t.hits).sort(), ['r1', 'r2', 'r3', 'r4'], 'hits不含对照题');
  assert.equal(t.result.slices.nianpu.n, 2);
  assert.equal(t.result.slices.guji.top1, 1);
  assert.ok(sub.task_id);
});

test('领题视图剥净元标注：control/origin/source/answer/split 均不下发', () => {
  const records = [mkRec('r1', 'A', { origin: 'nianpu' }), mkRec('c1', 'B', { origin: 'synthetic', control: true })];
  const svc = freshSvc(records, 'v6');
  const app = svc.registerApp({ name: '剥离测试', track: 'offline' });
  const paper = svc.getPaper(app.apiKey, 'testctl');
  for (const r of paper.records) {
    for (const k of ['control', 'origin', 'source', 'answer', 'split']) {
      assert.ok(!(k in r), `领题记录不得含 ${k} 字段: ${JSON.stringify(r)}`);
    }
  }
});

test('跳过对照题→覆盖率<1→不入榜', () => {
  const records = [mkRec('r1', 'A', { origin: 'nianpu' }), mkRec('r2', 'B', { origin: 'guji' }), mkRec('c1', 'C', { origin: 'synthetic', control: true })];
  const svc = freshSvc(records, 'v2');
  const app = svc.registerApp({ name: '跳题队', track: 'offline' });
  const ans = { r1: displayLetterFor(app.appId, 'testctl', records[0], 'A'), r2: displayLetterFor(app.appId, 'testctl', records[1], 'B') }; // 漏答c1
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.ok(t.result.coverage < 1);
  assert.equal(t.admitted, false, '跳对照题不得入榜');
});

test('对照题显著超机会水平→control_above_chance审计报警', () => {
  const records = [mkRec('r1', 'A', { origin: 'nianpu' }), mkRec('r2', 'B', { origin: 'guji' })];
  for (let i = 0; i < 12; i++) records.push(mkRec(`c${i}`, 'ABCD'[i % 4], { origin: 'synthetic', control: true }));
  const svc = freshSvc(records, 'v3');
  const audits = [];
  svc.audit = (appId, action, detail) => audits.push({ action, ...detail });
  const app = svc.registerApp({ name: '泄漏队', track: 'offline' });
  const ans = {};
  for (const r of records) ans[r.id] = displayLetterFor(app.appId, 'testctl', r, r.answer); // 全对(含对照全对=泄漏特征)
  const warn = console.warn; console.warn = () => {};
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  console.warn = warn;
  assert.ok(audits.some(a => a.action === 'control_above_chance' && a.n === 12 && a.controlTop1 === 1), `应有对照报警: ${JSON.stringify(audits)}`);
});

test('无对照题的集：result不含control/slices,行为与旧版一致', () => {
  const records = [mkRec('r1', 'A'), mkRec('r2', 'B')];
  const svc = freshSvc(records, 'v4');
  const app = svc.registerApp({ name: '旧版队', track: 'offline' });
  const ans = { r1: displayLetterFor(app.appId, 'testctl', records[0], 'A'), r2: displayLetterFor(app.appId, 'testctl', records[1], 'B') };
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.equal(t.result.control, undefined);
  assert.equal(t.result.slices, undefined);
  assert.equal(t.result.top1, 1);
});

test('datasetHash: origin/control为undefined时与旧schema哈希完全一致', () => {
  const r = mkRec('h1', 'A');
  const oldStyle = datasetHash([r], 'v1');
  const withUndef = datasetHash([{ ...r, origin: undefined, control: undefined }], 'v1');
  assert.equal(oldStyle, withUndef, '旧数据哈希不得因新字段声明而漂移');
  const withOrigin = datasetHash([{ ...r, origin: 'nianpu' }], 'v1');
  assert.notEqual(oldStyle, withOrigin, '新字段有值时必须改变哈希');
});
