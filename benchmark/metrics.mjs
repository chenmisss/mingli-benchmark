/** 评分与统计：top1/topk/Brier/ECE/命主聚类bootstrap CI/配对置换检验/切片。全部固定seed可复现。 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** pred: {ranked:['B','A',...], probs?:{A:0.4,...}}；rec 含 gold（仅评分器可见） */
export function scoreOne(rec, pred) {
  const gold = rec.answer;
  const ranked = pred?.ranked || [];
  const letters = rec.options.map(o => o.trim().charAt(0));
  const n = letters.length;
  const top1 = ranked.length ? (ranked[0] === gold ? 1 : 0) : null;
  const probs = {};
  let psum = 0;
  for (const L of letters) { const p = Math.max(0, Number(pred?.probs?.[L] ?? 0)); probs[L] = p; psum += p; }
  if (psum <= 0) { for (const L of letters) probs[L] = 1 / n; }
  else { for (const L of letters) probs[L] /= psum; }
  let brier = 0;
  for (const L of letters) { const y = L === gold ? 1 : 0; brier += (probs[L] - y) ** 2; }
  const conf = Math.max(...letters.map(L => probs[L]));
  const confHit = letters.reduce((best, L) => (probs[L] > probs[best] ? L : best), letters[0]) === gold ? 1 : 0;
  return { top1, brier, conf, confHit, chance: 1 / n };
}

export function topkHit(rec, pred, k) {
  return (pred?.ranked || []).slice(0, k).includes(rec.answer) ? 1 : 0;
}

/** 汇总一组记录的指标 */
export function aggregate(records, preds, { k = 2 } = {}) {
  const rows = records.filter(r => r.answer && preds[r.id]);
  const n = rows.length;
  if (!n) return { n: 0 };
  let t1 = 0, tk = 0, brier = 0, chance = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
  for (const r of rows) {
    const s = scoreOne(r, preds[r.id]);
    t1 += s.top1 ?? 0; tk += topkHit(r, preds[r.id], k); brier += s.brier; chance += s.chance;
    const b = Math.min(9, Math.floor(s.conf * 10));
    bins[b].n++; bins[b].conf += s.conf; bins[b].hit += s.confHit;
  }
  let ece = 0;
  for (const b of bins) if (b.n) ece += (b.n / n) * Math.abs(b.hit / b.n - b.conf / b.n);
  return { n, top1: t1 / n, [`top${k}`]: tk / n, brier: brier / n, ece, chance: chance / n };
}

/** 命主聚类 bootstrap CI（top1），同seed同结果 */
export function bootstrapCI(records, preds, { B = 2000, seed = 42 } = {}) {
  const rows = records.filter(r => r.answer && preds[r.id]);
  const bySubj = new Map();
  for (const r of rows) { if (!bySubj.has(r.subject_id)) bySubj.set(r.subject_id, []); bySubj.get(r.subject_id).push(r); }
  const subjects = [...bySubj.keys()];
  if (!subjects.length) return null;
  const rng = mulberry32(seed);
  const accs = [];
  for (let b = 0; b < B; b++) {
    let hit = 0, tot = 0;
    for (let i = 0; i < subjects.length; i++) {
      const s = subjects[Math.floor(rng() * subjects.length)];
      for (const r of bySubj.get(s)) { hit += scoreOne(r, preds[r.id]).top1 ?? 0; tot++; }
    }
    accs.push(tot ? hit / tot : 0);
  }
  accs.sort((a, b2) => a - b2);
  return { lo: accs[Math.floor(0.025 * B)], hi: accs[Math.ceil(0.975 * B) - 1] };
}

/** 配对置换检验（top1差，按命主聚类符号翻转，双侧p） */
export function pairedPermutation(records, predsA, predsB, { P = 10000, seed = 42 } = {}) {
  const rows = records.filter(r => r.answer && predsA[r.id] && predsB[r.id]);
  const bySubj = new Map();
  for (const r of rows) {
    const dA = scoreOne(r, predsA[r.id]).top1 ?? 0;
    const dB = scoreOne(r, predsB[r.id]).top1 ?? 0;
    bySubj.set(r.subject_id, (bySubj.get(r.subject_id) || 0) + (dA - dB));
  }
  const diffs = [...bySubj.values()];
  if (!diffs.length) return null;
  const obs = Math.abs(diffs.reduce((a, b) => a + b, 0));
  const rng = mulberry32(seed);
  let ge = 0;
  for (let p = 0; p < P; p++) {
    let s = 0;
    for (const d of diffs) s += rng() < 0.5 ? d : -d;
    if (Math.abs(s) >= obs - 1e-12) ge++;
  }
  return { p: (ge + 1) / (P + 1), obsDiffTotal: obs, clusters: diffs.length };
}

/** 切片：年份 × 类别 */
export function slices(records, preds, { k = 2 } = {}) {
  const out = { byYear: {}, byCategory: {} };
  const groups = (keyFn) => {
    const g = new Map();
    for (const r of records) { const key = keyFn(r); if (!g.has(key)) g.set(key, []); g.get(key).push(r); }
    return g;
  };
  for (const [y, rs] of groups(r => r.year)) out.byYear[y] = aggregate(rs, preds, { k });
  for (const [c, rs] of groups(r => r.category)) out.byCategory[c] = aggregate(rs, preds, { k });
  return out;
}
