/**
 * 研究三 M5 盲态分析 v2（修正案一锁定版；替代 v1）
 * 修正：CSPRNG 自助、null 剔除分母、平票=无效、Holm(全族91对保守)、TOST±8pp、Fleiss κ、年份题分层、跨轨 Spearman
 * 用法: npx tsx scripts/study3-analyze-v2.ts <ds|gm|op>   （揭盲前仅以 K 码运行）
 */
import fs from 'fs';
import { randomInt } from 'crypto';

const TRACK = process.argv[2] || 'ds';
const KS = Array.from({ length: 14 }, (_, i) => 'K' + (i + 1));
const YEARS = ['2021', '2022', '2023', '2024', '2025'];
const ANNEX = TRACK !== 'ds';
const B = 10000;

interface Item { person: string; ok: number; answered: boolean; yearQ: boolean; votes: (string | null)[] }
const items: Record<string, Item[]> = {};
const DATA_DIR = process.env.BAZIQA_DATA_DIR!;
const qMeta = new Map<string, boolean>(); // person|qi -> 年份题?
for (const y of YEARS) {
  const d = JSON.parse(fs.readFileSync(`${DATA_DIR}/contest8_${y}.json`, 'utf8')).slice(1);
  for (const s of d) s.questions.forEach((q: any, qi: number) =>
    qMeta.set(`${s.person_id}|${qi}`, /(19|20)\d{2}/.test(q.question + q.options.join(' '))));
}

for (const K of KS) {
  items[K] = [];
  for (const Y of YEARS) {
    const f = `study3-results/${TRACK}-${K}-${Y}.json`;
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const r of d.results) {
      let ans: string | null;
      if (ANNEX) ans = r.votes?.[0] ?? null;
      else {
        const tally: Record<string, number> = {};
        for (const v of (r.votes || [])) if (v) tally[v] = (tally[v] || 0) + 1;
        const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        ans = (ranked.length && ranked[0][1] >= 2) ? ranked[0][0] : null; // 平票/无过半 = 无效（修正案二.3）
      }
      items[K].push({ person: r.person, ok: ans && ans === r.gold ? 1 : 0, answered: !!ans, yearQ: qMeta.get(`${r.person}|${r.qi}`) ?? false, votes: r.votes || [] });
    }
  }
}
const persons = [...new Set(Object.values(items).flatMap(a => a.map(i => i.person)))];
console.log(`[${TRACK}] K臂×题 载入完成，命主 ${persons.length}；缺失臂-年 ${KS.flatMap(K => YEARS.filter(Y => !fs.existsSync(`study3-results/${TRACK}-${K}-${Y}.json`))).length}`);

// 答出题口径准确率（分母剔除未答）
function acc(K: string, ps?: Set<string>, strat?: 'year' | 'nonyear'): { p: number; c: number; t: number } {
  let c = 0, t = 0;
  for (const it of items[K]) {
    if (ps && !ps.has(it.person)) continue;
    if (strat === 'year' && !it.yearQ) continue;
    if (strat === 'nonyear' && it.yearQ) continue;
    if (!it.answered) continue;
    c += it.ok; t++;
  }
  return { p: t ? c / t : NaN, c, t };
}
// 命主级自助（有放回抽命主，按命主聚合）
function bootAcc(K: string): number[] {
  const byP = new Map<string, { c: number; t: number }>();
  for (const it of items[K]) { if (!it.answered) continue; const v = byP.get(it.person) || { c: 0, t: 0 }; v.c += it.ok; v.t++; byP.set(it.person, v); }
  const plist = persons.filter(p => byP.has(p));
  const out: number[] = [];
  for (let b = 0; b < B; b++) {
    let c = 0, t = 0;
    for (let i = 0; i < plist.length; i++) { const v = byP.get(plist[randomInt(plist.length)])!; c += v.c; t += v.t; }
    out.push(t ? c / t : NaN);
  }
  return out;
}
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];

const boots: Record<string, number[]> = {};
console.log('\nK臂    答出题准确率 [聚类自助95%CI]  作答率  年份题  非年份题  审计旗');
for (const K of KS) {
  boots[K] = bootAcc(K);
  const a = acc(K), ansRate = items[K].length ? items[K].filter(i => i.answered).length / items[K].length : NaN;
  const ay = acc(K, undefined, 'year'), an = acc(K, undefined, 'nonyear');
  console.log(`${K.padEnd(5)} ${(100 * a.p).toFixed(1)}% [${(100 * q(boots[K], .025)).toFixed(1)},${(100 * q(boots[K], .975)).toFixed(1)}] (${a.c}/${a.t})  ${(100 * ansRate).toFixed(0)}%  ${(100 * ay.p).toFixed(1)}%  ${(100 * an.p).toFixed(1)}%  ${ansRate < 0.9 ? '⚑<90%' : ''}`);
}

// 全族 91 对 pairwise：差值 CI + Holm（保守全族）
type Pair = { a: string; b: string; d: number; lo: number; hi: number; pApprox: number };
const pairs: Pair[] = [];
for (let i = 0; i < KS.length; i++) for (let j = i + 1; j < KS.length; j++) {
  const Ki = KS[i], Kj = KS[j];
  const ds = boots[Ki].map((v, ix) => v - boots[Kj][ix]);
  const d = acc(Ki).p - acc(Kj).p, lo = q(ds, .025), hi = q(ds, .975);
  const propNeg = ds.filter(x => x <= 0).length / ds.length;
  const pApprox = 2 * Math.min(propNeg, 1 - propNeg); // 自助双侧 p
  pairs.push({ a: Ki, b: Kj, d, lo, hi, pApprox });
}
pairs.sort((x, y) => x.pApprox - y.pApprox);
console.log('\n显著对（Holm 全族91对保守校正）：');
let anySig = false;
pairs.forEach((pr, rank) => {
  const alpha = 0.05 / (pairs.length - rank);
  if (pr.pApprox < alpha) { anySig = true; console.log(`  ${pr.a}−${pr.b}: Δ=${(100 * pr.d).toFixed(1)}pp [${(100 * pr.lo).toFixed(1)},${(100 * pr.hi).toFixed(1)}] p≈${pr.pApprox.toFixed(4)}`); }
});
if (!anySig) console.log('  （无一对通过全族 Holm）');

// TOST ±8pp 等价对（CI 完全落于 ±8pp 内）
const equiv = pairs.filter(pr => pr.lo > -0.08 && pr.hi < 0.08);
console.log(`\nTOST±8pp 等价成立对数: ${equiv.length}/91`);

// ds 轨 Fleiss κ（3 票）
if (!ANNEX) {
  console.log('\n种子一致性 Fleiss κ：');
  for (const K of KS) {
    const rows = items[K].filter(i => i.votes.length === 3 && i.votes.every(v => v));
    if (!rows.length) { console.log(`${K} 无三票全答题`); continue; }
    const cats = ['A', 'B', 'C', 'D'];
    let Pbar = 0; const pj = [0, 0, 0, 0];
    for (const r of rows) {
      const n = cats.map(c => r.votes.filter(v => v === c).length);
      n.forEach((x, ci) => pj[ci] += x);
      Pbar += (n.reduce((s, x) => s + x * x, 0) - 3) / (3 * 2);
    }
    Pbar /= rows.length;
    const N3 = rows.length * 3, Pe = pj.reduce((s, x) => s + (x / N3) ** 2, 0);
    console.log(`${K}: κ=${((Pbar - Pe) / (1 - Pe)).toFixed(3)} (n=${rows.length})`);
  }
}
console.log(`\n[锁定] 输出重定向保存为 study3-results/LOCKED-${TRACK}-v2.txt 后，三轨齐备方可揭盲`);
