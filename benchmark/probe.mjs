/** 泄漏/污染探针：纯题面文字启发式的可预测性 = "无命理知识、不看命盘"的下限。
 *  透明化目的：若某启发式显著高于机会水平，说明该考集题面本身漏答案（出题人指纹），
 *  任何系统的高分需先扣掉这部分才算"真本事"。回答"高分是算命准还是读题准"。
 *  node benchmark/probe.mjs [--seed 42]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aggregate, bootstrapCI } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const stripLetter = (o) => o.replace(/^[A-E][.、)\s]*/, '');
const lettersOf = (r) => r.options.map(o => o.trim().charAt(0));
const numCount = (s) => (s.match(/\d/g) || []).length;

// 每个探针：records → {recordId: {ranked, probs}}，只用题面文字，绝不看 answer/命盘
export function pick(records, scorer) {
  const out = {};
  for (const r of records) {
    const L = lettersOf(r);
    const texts = r.options.map(stripLetter);
    const idx = scorer(texts, r);
    const chosen = L[idx];
    out[r.id] = { ranked: [chosen, ...L.filter(x => x !== chosen)], probs: Object.fromEntries(L.map(x => [x, x === chosen ? 1 : 0])) };
  }
  return out;
}

export const PROBES = {
  longest: (t) => t.indexOf(t.reduce((a, b) => b.length > a.length ? b : a)),
  shortest: (t) => t.indexOf(t.reduce((a, b) => b.length < a.length ? b : a)),
  most_numeric: (t) => { let bi = 0, bs = -1; t.forEach((x, i) => { const s = numCount(x) * 100 + x.length; if (s > bs) { bs = s; bi = i; } }); return bi; },
  // 位置偏置：固定选某位置的最高 acc（泄漏上界）；选项重映射后此项在线上被消除
  pos_A: () => 0, pos_B: () => 1, pos_C: () => 2, pos_D: () => 3,
};

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
const seed = Number(process.argv.includes('--seed') ? process.argv[process.argv.indexOf('--seed') + 1] : 42);
const { records } = JSON.parse(fs.readFileSync(path.join(HERE, 'data/benchmark-v1.json'), 'utf8'));
const out = { seed, generatedAt: new Date().toISOString(), note: '探针只用题面文字，不看命盘；acc显著高于chance即题面漏答案。位置偏置(pos_*)在线上因选项重映射已消除，此处报原始数据用于证明必要性。', splits: {} };
for (const split of ['train', 'dev', 'holdout']) {
  const rs = records.filter(r => r.split === split && r.answer);
  if (!rs.length) continue;
  const chance = rs.reduce((a, r) => a + 1 / r.options.length, 0) / rs.length;
  const posAccs = ['pos_A', 'pos_B', 'pos_C', 'pos_D'].map(p => aggregate(rs, pick(rs, PROBES[p]), { k: 1 }).top1);
  const entry = { n: rs.length, chance, probes: {}, position_bias_max: Math.max(...posAccs) };
  for (const name of ['longest', 'shortest', 'most_numeric']) {
    const preds = pick(rs, PROBES[name]);
    const agg = aggregate(rs, preds, { k: 1 });
    const ci = bootstrapCI(rs, preds, { seed });
    entry.probes[name] = { top1: agg.top1, ci95: ci, leaks: ci.lo > chance }; // CI下界>chance视为显著漏
  }
  out.splits[split] = entry;
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, `results/probe-seed${seed}.json`), JSON.stringify(out, null, 1));

let md = `# 题面泄漏探针（seed=${seed}）\n\n只用题面文字、不看命盘的启发式准确率。**leaks=真**表示该考集题面本身漏答案。\n\n`;
for (const [split, e] of Object.entries(out.splits)) {
  md += `## ${split}（n=${e.n}，机会水平=${(e.chance * 100).toFixed(1)}%）\n\n| 探针 | top1 | 95%CI | 显著漏? |\n|---|---|---|---|\n`;
  for (const [name, p] of Object.entries(e.probes)) md += `| ${name} | ${(p.top1 * 100).toFixed(1)}% | [${(p.ci95.lo * 100).toFixed(1)}, ${(p.ci95.hi * 100).toFixed(1)}] | ${p.leaks ? '⚠️ 是' : '否'} |\n`;
  md += `| 位置偏置(上界,线上已消除) | ${(e.position_bias_max * 100).toFixed(1)}% | — | ${e.position_bias_max > e.chance + 0.05 ? '⚠️ 若不重映射' : '否'} |\n\n`;
}
fs.writeFileSync(path.join(HERE, `results/probe-seed${seed}.md`), md);
console.log(md);
console.log(`→ results/probe-seed${seed}.{json,md}`);
}
