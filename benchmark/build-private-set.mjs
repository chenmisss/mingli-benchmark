/** 私有正式题集构建：sources/private-2026/cases.json → data/private-set.json + 质检报告
 *  用法：node benchmark/build-private-set.mjs [--dry]
 *
 *  策展源 schema（人工审定后的定稿，非爬取原料）：
 *  { "cases": [ {
 *      "case_id": "guji-shenfeng-034",            // 全局唯一
 *      "origin": "guji" | "nianpu" | "contest",   // 子集切片标签（联网检索捷径风险按子集单列）
 *      "provenance": { "book": "...", "chapter": "...", "url": "...", "quote": "结局原文" },
 *      "gender": "male" | "female",
 *      "pillars": {"year":"辛丑","month":"庚寅","day":"甲辰","time":"丙寅"},  // guji：干支为金标
 *      "dayun_text": "庚寅 己丑 …（原文大运，可省）",
 *      "era": [1600, 1911],                        // guji 反推年代范围
 *      "birth_lunar": {"y":1835,"m":2,"d":3,"shichen":"辰"},  // nianpu：旧历生辰（m 闰月为负）
 *      "birth_solar": {"y":1988,"m":3,"d":18,"h":15},          // contest：公历直给
 *      "questions": [ { "q":"此造财运的实际结局是?", "options":["A. …","B. …","C. …","D. …"],
 *                       "answer":"B", "fact_basis":"对应结局原文点" } ]
 *  } ] }
 *
 *  质检闸（任一不过即整案剔除，报告列明）：
 *   G1 干支自洽+可反推（guji：pillarSanity + reverseSearch 于 era 内 ≥1 解）
 *   G2 历日可换算（nianpu：lunarToSolarPillars 不抛错）
 *   G3 schema 合法（validateRecord）
 *   G4 题面去重（对主库 benchmark-v1.json + 私有集内部，dedupKey）
 *   G5 命主去重（同四柱/同生辰跨案即拒——防同一命例两书重复入库）
 *  软警告（不剔除，输出供人工改写）：
 *   W1 答案字母分布失衡（某字母 >35%）
 *   W2 正确选项为最长/最短且长度偏离中位 >30%（探针诱饵）
 *   W3 子时件（早晚子时流派歧义）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateRecord, classify, dedupKey } from './schema.mjs';
import { pillarSanity, reverseSearch, lunarToSolarPillars } from './pillar-verify.mjs';
import { PROBES, pick } from './probe.mjs';
import { aggregate, bootstrapCI } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.PRIV_SRC || path.join(HERE, 'sources/private-2026/cases.json');
const MAIN = path.join(HERE, 'data/benchmark-v1.json');
const OUT = path.join(HERE, 'data/private-set.json');
const REPORT = path.join(HERE, 'data/private-quality-report.json');
const DRY = process.argv.includes('--dry');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const mainRecords = JSON.parse(fs.readFileSync(MAIN, 'utf8')).records;
const mainDedup = new Set(mainRecords.map(dedupKey));

const records = [];
const rejected = [];
const warnings = [];
const seenSubjects = new Map(); // 命主指纹 → case_id（G5）
const seenDedup = new Set();

const pillarStr = (p) => `${p.year} ${p.month} ${p.day} ${p.time}`;

for (const c of src.cases || []) {
  const rej = (why) => rejected.push({ case_id: c.case_id, why });
  const warn = (what) => warnings.push({ case_id: c.case_id, what });
  if (!c.case_id || !Array.isArray(c.questions) || !c.questions.length) { rej('缺 case_id 或无题'); continue; }
  if (!c.provenance?.book && !c.provenance?.url) { rej('缺出处'); continue; }

  // origin 是切片标签（synthetic=安慰剂对照；modern=现代论坛真实命例[自述级金标,在世者匿名化]）；
  // 输入形态按字段判定：pillars→反推闸 / birth_lunar→换算 / birth_solar→直取
  if (!['guji', 'nianpu', 'contest', 'synthetic', 'modern'].includes(c.origin)) { rej(`未知 origin: ${c.origin}`); continue; }
  let birth = null;         // 记录级 birth（guji 风格为 null，四柱内嵌题面）
  let pillars = c.pillars || null;
  let subjectFp = null;     // 命主指纹

  if (c.pillars) {
    const sane = pillarSanity(pillars);
    if (sane.length) { rej(`G1 干支不自洽: ${sane.join('; ')}`); continue; }
    const [start, end] = c.era || [1500, 1949];
    const rs = reverseSearch(pillars, { start, end });
    if (!rs.ok) { rej(`G1 反推无解(${start}-${end}): ${rs.reason}`); continue; }
    if (rs.zishiAmbiguous) warn('W3 子时件（四柱内嵌题面，已绕开流派差异）');
    subjectFp = `pillars:${pillarStr(pillars)}:${c.gender}`;
    c._reverse = { n: rs.candidates.length, first: rs.candidates[0] };
  } else if (c.birth_lunar) {
    const b = c.birth_lunar;
    let conv;
    try { conv = lunarToSolarPillars(b.y, b.m, b.d, b.shichen); }
    catch (e) { rej(`G2 历日换算失败: ${e.message}`); continue; }
    if (conv.zishiAmbiguous) warn('W3 子时件（生辰给至日，题面注明时辰段）');
    birth = { year: conv.solar.year, month: conv.solar.month, day: conv.solar.day, hour: conv.solar.hour, minute: 0 };
    pillars = conv.pillars;
    subjectFp = `birth:${birth.year}-${birth.month}-${birth.day}-${birth.hour}:${c.gender}`;
  } else if (c.birth_solar) {
    const b = c.birth_solar;
    birth = { year: b.y, month: b.m, day: b.d, hour: b.h ?? 12, minute: b.min ?? 0 };
    subjectFp = `birth:${birth.year}-${birth.month}-${birth.day}-${birth.hour}:${c.gender}`;
  } else { rej('缺生辰输入(pillars/birth_lunar/birth_solar 三选一)'); continue; }

  if (seenSubjects.has(subjectFp)) { rej(`G5 命主重复（与 ${seenSubjects.get(subjectFp)} 同盘）`); continue; }
  seenSubjects.set(subjectFp, c.case_id);

  // 组题：四柱输入（guji 风格）内嵌题面；birth 输入走记录字段，系统自行排盘
  const genderWord = c.gender === 'female' ? '坤造' : '乾造';
  const preamble = (c.pillars)
    ? `${genderWord}：${pillarStr(pillars)}。${c.dayun_text ? `行运：${c.dayun_text}。` : ''}`
    : '';

  const caseRecords = [];
  let bad = null;
  for (let qi = 0; qi < c.questions.length; qi++) {
    const q = c.questions[qi];
    const rec = {
      id: `p2026-${c.case_id}-q${qi + 1}`,
      year: 2026,
      subject_id: `p2026-${c.case_id}`,
      birth,
      gender: c.gender,
      question: `${preamble}${String(q.q).trim()}`,
      options: q.options.map(String),
      answer: q.answer,
      category: classify(q.q, q.options.map(String)),
      split: 'holdout',
      origin: c.origin, // 切片标签：评分端按此对比古籍/年谱切片(污染指纹)
      ...(c.control === true ? { control: true } : {}), // 安慰剂对照：不计排名分,单独统计
      source: `private-2026 ${c.origin}:${c.provenance?.book || c.provenance?.url || ''}`,
    };
    const errs = validateRecord(rec);
    if (!rec.answer) errs.push('私有集不收无答案题（服务端会静默丢弃）');
    if (errs.length) { bad = `G3 ${rec.id}: ${errs.join('; ')}`; break; }
    // 撞主库=真重复(疑复制赛事题);集内按"命主+题面"判重——不同命主共用模板题(如寿数四档)是合法设计
    const dk = dedupKey(rec);
    const dkScoped = `${rec.subject_id}|${dk}`;
    if (mainDedup.has(dk)) { bad = `G4 ${rec.id} 题面与主库既有题重复`; break; }
    if (seenDedup.has(dkScoped)) { bad = `G4 ${rec.id} 同命主题面重复`; break; }
    seenDedup.add(dkScoped);
    caseRecords.push(rec);

    // W2 探针诱饵：正确选项长度异常
    const lens = rec.options.map(o => o.replace(/^[A-E][.、)\s]*/, '').length).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)] || 1;
    const ansLen = rec.options[['A', 'B', 'C', 'D', 'E'].indexOf(q.answer)]?.replace(/^[A-E][.、)\s]*/, '').length ?? 0;
    if ((ansLen === Math.max(...lens) || ansLen === Math.min(...lens)) && Math.abs(ansLen - median) / median > 0.3) {
      warn(`W2 ${rec.id} 正确选项长度异常(${ansLen} vs 中位${median})，疑探针诱饵，建议改写`);
    }
  }
  if (bad) { rej(bad); continue; }
  records.push(...caseRecords);
}

// W1 答案分布
const dist = {};
for (const r of records) dist[r.answer] = (dist[r.answer] || 0) + 1;
for (const [L, n] of Object.entries(dist)) {
  if (n / records.length > 0.35) warnings.push({ case_id: '(全集)', what: `W1 答案${L}占比${(n / records.length * 100).toFixed(0)}% >35%，建议人工调换部分题的正确项位置` });
}

// 题面泄漏探针（同 probe.mjs 口径）：CI 下界 > 机会水平 = 题面漏答案，须改写选项
const probeReport = {};
if (records.length >= 10) {
  const chance = records.reduce((a, r) => a + 1 / r.options.length, 0) / records.length;
  probeReport.chance = chance;
  for (const name of ['longest', 'shortest', 'most_numeric']) {
    const preds = pick(records, PROBES[name]);
    const ci = bootstrapCI(records, preds, { seed: 42 });
    probeReport[name] = { top1: aggregate(records, preds, { k: 1 }).top1, ci95: ci, leaks: ci.lo > chance };
  }
  probeReport.any_leak = ['longest', 'shortest', 'most_numeric'].some(n => probeReport[n].leaks);
}

const report = {
  built_at: new Date().toISOString(),
  input_cases: (src.cases || []).length,
  output_records: records.length,
  by_origin: records.reduce((m, r) => { const o = r.source.match(/private-2026 (\w+):/)?.[1]; m[o] = (m[o] || 0) + 1; return m; }, {}),
  by_category: records.reduce((m, r) => { m[r.category] = (m[r.category] || 0) + 1; return m; }, {}),
  answer_distribution: dist,
  probe: probeReport,
  rejected, warnings,
};

console.log(JSON.stringify(report, null, 1));
if (!DRY) {
  fs.writeFileSync(OUT, JSON.stringify({ version: 'private-2026.1', records }, null, 1));
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(`\n写入 ${OUT}（${records.length} 题）+ ${REPORT}`);
} else {
  console.log('\n[--dry] 未写文件');
}
if (rejected.length) process.exitCode = records.length ? 0 : 1;
