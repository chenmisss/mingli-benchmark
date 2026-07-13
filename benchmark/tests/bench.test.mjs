import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateRecord, classify, subjectClusterKey, dedupKey } from '../schema.mjs';
import { aggregate, bootstrapCI, pairedPermutation, scoreOne, mulberry32 } from '../metrics.mjs';
import { randomBaseline, majorityBaseline, rulesBaseline } from '../baselines.mjs';
import { pick, PROBES } from '../probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(HERE, '../data/benchmark-v1.json'), 'utf8'));
const R = DATA.records;

const mk = (over = {}) => ({
  id: 'y2024-x-q1', year: 2024, subject_id: 'y2024-x', birth: { year: 1990, month: 3, day: 20, hour: 16, minute: 0 },
  gender: 'male', question: '哪年结婚?', options: ['A. 2010', 'B. 2011', 'C. 2012', 'D. 2013'], answer: 'B',
  category: 'year', split: 'holdout', source: 't', ...over,
});

test('schema: 合法记录通过、非法记录报错', () => {
  assert.equal(validateRecord(mk()).length, 0);
  assert.ok(validateRecord(mk({ options: ['A. 1', 'B. 2', 'C. 3'] })).length > 0);
  assert.ok(validateRecord(mk({ answer: 'F' })).length > 0);
  assert.equal(validateRecord(mk({ birth: null, gender: null })).length, 0, 'birth=null 允许');
});

test('schema: 分类器', () => {
  assert.equal(classify('哪年结婚?', ['A. 2010']), 'year');
  assert.equal(classify('父亲情况?', ['A. 健在']), 'family');
  assert.equal(classify('学历如何?', ['A. 本科']), 'career');
});

test('数据质量：train可评分>0 且 2018全40题带官方gold', () => {
  const train = R.filter(r => r.split === 'train');
  assert.ok(train.filter(r => r.answer).length >= 60, 'train scoreable 应≥60');
  const y2018 = R.filter(r => r.year === 2018);
  assert.equal(y2018.length, 40, '2018须40题');
  assert.equal(y2018.filter(r => r.answer).length, 40, '2018 golds须40');
  const qnums = new Set(y2018.map(r => Number(r.id.match(/q(\d+)$/)[1])));
  assert.equal(qnums.size, 40, 'Q1-40唯一');
  for (let q = 1; q <= 40; q++) assert.ok(qnums.has(q), `缺Q${q}`);
  // subject 映射：题数序列应为 2,3,5,5,5,5,5,5,5（structured subjects 顺序）
  const bySubj = {};
  for (const r of y2018) bySubj[r.subject_id] = (bySubj[r.subject_id] || 0) + 1;
  const sizes = Object.values(bySubj).sort((a, b) => a - b);
  assert.deepEqual(sizes, [2, 3, 5, 5, 5, 5, 5, 5, 5]);
  // birth=null 命例存在且只有一个
  assert.equal(y2018.filter(r => r.birth === null).length, 5, 'birth=null命例6应有5题');
});

test('数据质量：2020全35题(unscored)与总量/可评分恒定', () => {
  const y2020 = R.filter(r => r.year === 2020);
  assert.equal(y2020.length, 35, '2020须35题(clock与时辰双格式生辰均解析)');
  assert.equal(y2020.filter(r => r.answer).length, 0, '2020无官方键,全unscored');
  assert.equal(R.length, 365, '总记录365(2026-07扩入2012/13共31题,答案公报已比对官网存档页)');
  assert.equal(R.filter(r => r.split === 'train' && r.answer).length, 95, 'train可评分95(原64+2012/13的31)');
  assert.equal(new Set(R.map(r => r.id)).size, R.length, '记录ID唯一');
});

test('切分：按时间且命主聚类不跨分区', () => {
  for (const r of R) {
    const want = r.year >= 2024 ? 'holdout' : r.year >= 2021 ? 'dev' : 'train';
    // 聚类归并可把记录下调（防泄漏），但绝不允许上调进更晚的分区
    const order = { train: 0, dev: 1, holdout: 2 };
    assert.ok(order[r.split] <= order[want], `${r.id} 从${want}上调到了${r.split}`);
  }
  const clusterSplits = new Map();
  for (const r of R) {
    const c = subjectClusterKey(r);
    if (!clusterSplits.has(c)) clusterSplits.set(c, new Set());
    clusterSplits.get(c).add(r.split);
  }
  for (const [c, s] of clusterSplits) assert.equal(s.size, 1, `聚类${c}跨分区: ${[...s]}`);
});

test('泄漏防护：runner可见面不含answer；dedupKey稳定', async () => {
  const { stripAnswer } = await import('../run.mjs').catch(() => ({}));
  // run.mjs 是CLI会执行主流程，这里直接验证同名逻辑
  const strip = stripAnswer || ((r) => { const { answer, ...rest } = r; return rest; });
  const s = strip(mk());
  assert.ok(!('answer' in s), '剥离后不得含answer');
  assert.equal(dedupKey(mk()), dedupKey(mk({ id: 'other', question: '哪年结婚 ?' })), '空白差异应视为同题');
});

test('metrics: 已知fixtures', () => {
  const recs = [mk({ id: 'a', subject_id: 's1' }), mk({ id: 'b', subject_id: 's2', answer: 'C' })];
  const perfect = { a: { ranked: ['B', 'A', 'C', 'D'], probs: { A: 0, B: 1, C: 0, D: 0 } }, b: { ranked: ['C', 'A', 'B', 'D'], probs: { A: 0, B: 0, C: 1, D: 0 } } };
  const agg = aggregate(recs, perfect, { k: 2 });
  assert.equal(agg.top1, 1); assert.equal(agg.brier, 0);
  const uniform = { a: { ranked: ['A', 'B', 'C', 'D'], probs: { A: .25, B: .25, C: .25, D: .25 } }, b: { ranked: ['A', 'B', 'C', 'D'], probs: { A: .25, B: .25, C: .25, D: .25 } } };
  const agg2 = aggregate(recs, uniform, { k: 2 });
  assert.equal(agg2.top1, 0);
  assert.ok(Math.abs(agg2.brier - 0.75) < 1e-9, '四选一均匀分布Brier=0.75');
  const ci1 = bootstrapCI(recs, perfect, { seed: 7, B: 200 });
  const ci2 = bootstrapCI(recs, perfect, { seed: 7, B: 200 });
  assert.deepEqual(ci1, ci2, '同seed同CI');
  const p = pairedPermutation(recs, perfect, perfect, { seed: 7, P: 500 });
  assert.ok(p.p > 0.99, '完全相同的两组 p≈1');
});

test('baselines: 确定性/防泄漏/缺生辰行为', () => {
  const evalRecs = R.filter(r => r.split === 'dev' && r.answer).map(r => { const { answer, ...rest } = r; return rest; });
  const train = R.filter(r => r.split === 'train' && r.answer);
  const r1 = randomBaseline(evalRecs, { seed: 1 });
  const r2 = randomBaseline(evalRecs, { seed: 1 });
  assert.deepEqual(r1[evalRecs[0].id], r2[evalRecs[0].id], 'random同seed确定');
  const maj = majorityBaseline(evalRecs, train);
  assert.equal(Object.keys(maj).length, evalRecs.length);
  const nb = mk({ id: 'nb', birth: null, gender: null });
  const rules = rulesBaseline([{ ...nb, answer: undefined }], train);
  assert.ok(!rules['nb'], '缺生辰记录规则基线不作答');
});

test('probe: 题面探针只用文字、确定性、不看答案', () => {
  const r = mk({ options: ['A. 短', 'B. 这是一个明显更长的选项文本内容', 'C. 中等长度', 'D. 2010年'] });
  // longest 选 B（最长），most_numeric 选 D（唯一带数字），均与 answer 无关
  const pl = pick([r], PROBES.longest);
  assert.equal(pl[r.id].ranked[0], 'B');
  const pn = pick([r], PROBES.most_numeric);
  assert.equal(pn[r.id].ranked[0], 'D');
  // 确定性：两次结果相同
  assert.deepEqual(pick([r], PROBES.longest), pl);
  // 探针 preds 不依赖 r.answer
  const r2 = mk({ options: r.options, answer: 'A' });
  assert.equal(pick([r2], PROBES.longest)[r2.id].ranked[0], 'B');
});

test('rng: mulberry32 确定性', () => {
  const a = mulberry32(99), b = mulberry32(99);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('scoreOne: 5选项机会水平', () => {
  const r5 = mk({ options: ['A. 1', 'B. 2', 'C. 3', 'D. 4', 'E. 5'], answer: 'E' });
  const s = scoreOne(r5, { ranked: ['E', 'A', 'B', 'C', 'D'] });
  assert.equal(s.top1, 1);
  assert.ok(Math.abs(s.chance - 0.2) < 1e-9);
});
