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
    mkRec('r1', 'A', { origin: 'modern' }), mkRec('r2', 'B', { origin: 'modern' }),
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
  assert.equal(t.result.scoreableN, 2, '计分题数=2(对照+古籍均排除,只剩现代2)');
  assert.equal(t.result.top1, 1, '排名分只看计分池(现代)=满分');
  assert.equal(t.result.coverage, 1, '全答→覆盖率1');
  assert.equal(t.result.control.n, 2);
  assert.equal(t.result.control.top1, 0, '对照题全错');
  assert.ok(Math.abs(t.result.control.chance - 0.25) < 1e-9);
  assert.deepEqual(Object.keys(t.hits).sort(), ['r1', 'r2'], 'hits只含计分池(现代),不含对照与古籍');
  assert.equal(t.result.slices.modern.n, 2);
  assert.equal(t.result.slices.guji.top1, 1, '古籍切片仍统计(诊断)');
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

test('古籍诊断池:不计top1排名分,但出切片、算覆盖率、跳题不入榜', () => {
  const records = [
    mkRec('m1', 'A', { origin: 'modern' }), mkRec('m2', 'B', { origin: 'modern' }),
    mkRec('m3', 'A', { origin: 'modern' }), mkRec('m4', 'B', { origin: 'modern' }),
    mkRec('g1', 'A', { origin: 'guji' }), mkRec('g2', 'B', { origin: 'guji' }), mkRec('g3', 'C', { origin: 'guji' }),
  ];
  const svc = freshSvc(records, 'guji1');
  const app = svc.registerApp({ name: '古籍诊断', track: 'offline' });
  // 计分池(nianpu+modern)全对；古籍全对(模拟背书)
  const ans = {};
  for (const r of records) ans[r.id] = displayLetterFor(app.appId, 'testctl', r, r.answer);
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.equal(t.result.scoreableN, 4, '计分池=现代4,不含古籍');
  assert.equal(t.result.top1, 1, '计分池全对→top1=1(古籍不参与)');
  assert.equal(t.result.slices.guji.n, 3, '古籍切片仍统计');
  assert.equal(t.result.slices.guji.top1, 1, '古籍切片得分=1(背书全对)');
  assert.equal(t.result.slices.guji.diagnostic, true, '古籍切片标记diagnostic');
  assert.ok(!t.result.slices.modern.diagnostic, '现代切片非诊断(计分池)');
  assert.equal(t.result.coverage, 1, '覆盖率含古籍(全答→1)');
  assert.deepEqual(Object.keys(t.hits).sort(), ['m1', 'm2', 'm3', 'm4'], 'hits(排名向量)不含古籍');
});

test('古籍答错不拖累排名分:计分池满分则top1=1,即便古籍全错', () => {
  const records = [
    mkRec('n1', 'A', { origin: 'nianpu' }), mkRec('m1', 'A', { origin: 'modern' }),
    mkRec('g1', 'A', { origin: 'guji' }), mkRec('g2', 'B', { origin: 'guji' }),
  ];
  const svc = freshSvc(records, 'guji2');
  const app = svc.registerApp({ name: '古籍全错', track: 'offline' });
  const ans = {};
  for (const r of records) {
    const target = r.origin === 'guji' ? (r.answer === 'A' ? 'B' : 'A') : r.answer; // 古籍全答错
    ans[r.id] = displayLetterFor(app.appId, 'testctl', r, target);
  }
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.equal(t.result.top1, 1, '古籍答错不影响排名分');
  assert.equal(t.result.slices.guji.top1, 0, '古籍切片记录其全错');
});

test('二手转录secondhand:移入诊断池不计排名,单列secondhand切片,领题不下发标记', () => {
  const records = [
    mkRec('m0', 'A', { origin: 'modern' }), mkRec('m1', 'A', { origin: 'modern' }),
    mkRec('s1', 'A', { origin: 'modern', secondhand: true }), mkRec('s2', 'B', { origin: 'modern', secondhand: true }),
  ];
  const svc = freshSvc(records, 'sh1');
  const app = svc.registerApp({ name: '二手测试', track: 'offline' });
  // 计分池(n1,m1)全对；二手(s1,s2)全答错
  const ans = {};
  for (const r of records) {
    const target = r.secondhand ? (r.answer === 'A' ? 'B' : 'A') : r.answer;
    ans[r.id] = displayLetterFor(app.appId, 'testctl', r, target);
  }
  svc.submitAnswers(app.apiKey, { set_id: 'testctl', dataset_version: svc.datasetVersion, answers: ans });
  const t = Object.values(svc.subs).find(s => s.appId === app.appId);
  assert.equal(t.result.scoreableN, 2, '计分池=现代2(二手排除)');
  assert.equal(t.result.top1, 1, '二手答错不拖累排名分');
  assert.equal(t.result.slices.secondhand.n, 2, 'secondhand单列切片');
  assert.equal(t.result.slices.secondhand.top1, 0, 'secondhand切片记录全错');
  assert.equal(t.result.slices.secondhand.diagnostic, true, 'secondhand标记diagnostic');
  assert.ok(!t.result.slices.modern.secondhand, 'secondhand不混入modern切片');
  assert.equal(t.result.slices.modern.n, 2, 'modern切片只含自发m0/m1,不含二手');
  assert.deepEqual(Object.keys(t.hits).sort(), ['m0', 'm1'], 'hits排名向量不含二手');
  // 领题不得下发 secondhand 标记
  const paper = svc.getPaper(app.apiKey, 'testctl');
  assert.ok(paper.records.every(r => !('secondhand' in r)), '领题剥离secondhand');
});
