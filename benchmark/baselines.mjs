/** 基线：random / majority(仅用train分布,防泄漏) / rules(历法引擎应期规则) / answers-file(如 Claude Fable 5 自测)
 *  约定：基线只接收去答案记录（runner强制剥离）；输出 {recordId: {ranked, probs}}
 */
import fs from 'fs';
import { mulberry32 } from './metrics.mjs';
import pkg from 'lunar-javascript';
const { Solar } = pkg;

const lettersOf = (rec) => rec.options.map(o => o.trim().charAt(0));

// 种子化 Fisher-Yates（sort(()=>rng()-0.5) 非均匀，20k seed 下首选项 A35/B14/C19/D32%，已修）
function fisherYates(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function randomBaseline(records, { seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const out = {};
  for (const r of records) {
    const L = lettersOf(r);
    out[r.id] = { ranked: fisherYates(L, rng), probs: Object.fromEntries(L.map(x => [x, 1 / L.length])) };
  }
  return out;
}

/** 多数类：答案分布只允许来自train切分（调用方传入trainRecords） */
export function majorityBaseline(records, trainRecords) {
  const counts = {};
  for (const r of trainRecords) if (r.answer) counts[r.answer] = (counts[r.answer] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const rankAll = ['A', 'B', 'C', 'D', 'E'].sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  const out = {};
  for (const r of records) {
    const L = lettersOf(r);
    const ranked = rankAll.filter(x => L.includes(x));
    out[r.id] = { ranked, probs: Object.fromEntries(L.map(x => [x, ((counts[x] || 0) + 1) / (total + L.length)])) };
  }
  return out;
}

// —— 现有应期规则（文档化弱基线；论文一已证其信息量有限，作为下限参照）——
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const CHONG = { 子: '午', 丑: '未', 寅: '申', 卯: '酉', 辰: '戌', 巳: '亥', 午: '子', 未: '丑', 申: '寅', 酉: '卯', 戌: '辰', 亥: '巳' };
const LIUHE = { 子: '丑', 丑: '子', 寅: '亥', 亥: '寅', 卯: '戌', 戌: '卯', 辰: '酉', 酉: '辰', 巳: '申', 申: '巳', 午: '未', 未: '午' };
const WUHE = { 甲: '己', 己: '甲', 乙: '庚', 庚: '乙', 丙: '辛', 辛: '丙', 丁: '壬', 壬: '丁', 戊: '癸', 癸: '戊' };
const yearGZ = (y) => GAN[(y - 4) % 10] + ZHI[(y - 4) % 12];

export function rulesBaseline(records, trainRecords) {
  const majority = majorityBaseline(records, trainRecords);
  const out = {};
  for (const r of records) {
    const L = lettersOf(r);
    if (!r.birth) continue; // 缺生辰：规则基线不作答（coverage体现），随机/多数类仍可评
    let dayGan = null, dayZhi = null;
    try {
      const lunar = Solar.fromYmdHms(r.birth.year, r.birth.month, r.birth.day, r.birth.hour, r.birth.minute || 0, 0).getLunar();
      const dgz = lunar.getDayInGanZhi();
      dayGan = dgz.charAt(0); dayZhi = dgz.charAt(1);
    } catch { /* 生辰异常→退多数类 */ }
    const optYears = r.options.map(o => { const m = o.match(/(19|20)\d{2}/); return m ? Number(m[0]) : null; });
    if (r.category !== 'year' || dayZhi === null || optYears.every(y => y === null)) { out[r.id] = majority[r.id]; continue; }
    const scores = optYears.map((y) => {
      if (y === null) return 0;
      const gz = yearGZ(y); const g = gz.charAt(0); const z = gz.charAt(1);
      let s = 0;
      if (CHONG[dayZhi] === z) s += 2;      // 流年冲日支（婚变/变动应期经典规则）
      if (WUHE[dayGan] === g) s += 2;       // 流年干合日干
      if (LIUHE[dayZhi] === z) s += 1;      // 流年合日支
      if (z === dayZhi) s += 1;             // 伏吟
      return s;
    });
    const order = L.map((x, i) => [x, scores[i], i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    const exp = scores.map(s => Math.exp(s));
    const Z = exp.reduce((a, b) => a + b, 0);
    out[r.id] = { ranked: order.map(o => o[0]), probs: Object.fromEntries(L.map((x, i) => [x, exp[i] / Z])) };
  }
  return out;
}

/** 答案文件基线（Claude Fable 5 自测等）：{"y2024-..-q1": "B" | {"answer":"B","confidence":0.6}} */
export function answersFileBaseline(records, filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const answers = data.answers || data;
  const out = {};
  for (const r of records) {
    const a = answers[r.id];
    if (!a) continue;
    const letter = typeof a === 'string' ? a : a.answer;
    const conf = typeof a === 'object' && a.confidence ? Math.min(0.95, Math.max(0.3, a.confidence)) : 0.6;
    const L = lettersOf(r);
    if (!L.includes(letter)) continue;
    const rest = (1 - conf) / (L.length - 1);
    out[r.id] = { ranked: [letter, ...L.filter(x => x !== letter)], probs: Object.fromEntries(L.map(x => [x, x === letter ? conf : rest])) };
  }
  return out;
}
