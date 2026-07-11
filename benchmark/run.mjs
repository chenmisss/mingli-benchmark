/** Benchmark runner CLI（固定seed，可复现）
 * node benchmark/run.mjs --splits dev,holdout --baselines random,majority,rules[,fable5] --seed 42 --k 2 \
 *   [--fable5-file benchmark/fable5/holdout-answers.json] [--out benchmark/results]
 * 泄漏防护：基线只拿到去答案记录（strip）；majority/rules 的分布信息仅取自 train。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aggregate, bootstrapCI, pairedPermutation, slices } from './metrics.mjs';
import { randomBaseline, majorityBaseline, rulesBaseline, answersFileBaseline } from './baselines.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SPLITS = arg('splits', 'dev,holdout').split(',');
const BASELINES = arg('baselines', 'random,majority,rules').split(',');
const SEED = Number(arg('seed', '42'));
const K = Number(arg('k', '2'));
const OUT = arg('out', path.join(HERE, 'results'));
const F5FILE = arg('fable5-file', path.join(HERE, 'fable5/holdout-answers.json'));

export const stripAnswer = (r) => { const { answer, ...rest } = r; return rest; };

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (!isMain) { /* 被import时仅暴露工具函数，不执行评测主流程 */ }
else {
const { records, version } = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, 'data/benchmark-v1.json'), 'utf8'));
  return { records: d.records, version: d.version };
})();
const train = records.filter(r => r.split === 'train' && r.answer);

fs.mkdirSync(OUT, { recursive: true });
const results = { version, seed: SEED, k: K, ranAt: new Date().toISOString(), splits: {} };

for (const split of SPLITS) {
  const evalRecords = records.filter(r => r.split === split && r.answer);
  const publicRecords = evalRecords.map(stripAnswer); // 基线可见面
  const preds = {};
  const invalidBaselines = new Set(); // 数据污染的基线：成绩无效，不参与显著性
  for (const b of BASELINES) {
    if (b === 'random') preds[b] = randomBaseline(publicRecords, { seed: SEED });
    else if (b === 'majority') preds[b] = majorityBaseline(publicRecords, train);
    else if (b === 'rules') preds[b] = rulesBaseline(publicRecords, train);
    else if (b === 'fable5') {
      if (!fs.existsSync(F5FILE)) { console.warn(`fable5 答案文件缺失(${F5FILE})，跳过`); continue; }
      preds[b] = answersFileBaseline(publicRecords, F5FILE);
      try {
        const meta = JSON.parse(fs.readFileSync(F5FILE, 'utf8'))._meta || {};
        if (meta.mode === 'demo-only' || meta.contamination_disclosure) invalidBaselines.add(b);
      } catch { /* 无 _meta 视为有效 */ }
    } else console.warn(`未知基线: ${b}`);
  }
  const splitOut = { n: evalRecords.length, baselines: {}, pairwise: {}, invalid_baselines: [...invalidBaselines] };
  for (const [name, p] of Object.entries(preds)) {
    const agg = aggregate(evalRecords, p, { k: K });
    const ci = bootstrapCI(evalRecords, p, { seed: SEED });
    splitOut.baselines[name] = { ...agg, ci95: ci, coverage: Object.keys(p).length / evalRecords.length, slices: slices(evalRecords.filter(r => p[r.id]), p, { k: K }), invalid: invalidBaselines.has(name) || undefined, invalid_reason: invalidBaselines.has(name) ? '数据污染(答案文件_meta标注demo-only/contamination)，成绩无效不可引用' : undefined };
  }
  const names = Object.keys(preds).filter(n => !invalidBaselines.has(n)); // 显著性检验排除污染基线
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const t = pairedPermutation(evalRecords, preds[names[i]], preds[names[j]], { seed: SEED });
    if (t) splitOut.pairwise[`${names[i]}_vs_${names[j]}`] = t;
  }
  results.splits[split] = splitOut;
}

const stamp = `seed${SEED}`;
fs.writeFileSync(path.join(OUT, `results-${stamp}.json`), JSON.stringify(results, null, 1));

// 论文表格（markdown）
let md = `# Benchmark v1 结果（seed=${SEED}, k=${K}）\n\n`;
for (const [split, so] of Object.entries(results.splits)) {
  md += `## ${split}（可评分 n=${so.n}）\n\n| 基线 | top1 | top${K} | Brier | ECE | 95%CI(top1) | 覆盖率 |\n|---|---|---|---|---|---|---|\n`;
  for (const [name, m] of Object.entries(so.baselines)) {
    const pct = (x) => x == null ? '—' : (100 * x).toFixed(1) + '%';
    const tag = m.invalid ? ' ⚠️无效(污染)' : '';
    md += `| ${name}${tag} | ${pct(m.top1)} | ${pct(m[`top${K}`])} | ${m.brier?.toFixed(3) ?? '—'} | ${m.ece?.toFixed(3) ?? '—'} | ${m.ci95 ? `[${pct(m.ci95.lo)}, ${pct(m.ci95.hi)}]` : '—'} | ${pct(m.coverage)} |\n`;
  }
  if (so.invalid_baselines?.length) md += `\n> ⚠️ ${so.invalid_baselines.join(', ')} 成绩因数据污染无效，不可引用、不参与显著性检验。\n`;
  md += `\n配对置换检验（top1，按命主聚类，已排除无效基线）：\n`;
  for (const [pair, t] of Object.entries(so.pairwise)) md += `- ${pair}: p=${t.p.toFixed(4)}（聚类数=${t.clusters}）\n`;
  md += '\n';
}
fs.writeFileSync(path.join(OUT, `results-${stamp}.md`), md);
console.log(md);
console.log(`→ ${OUT}/results-${stamp}.{json,md}`);
}
