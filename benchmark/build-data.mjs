/**
 * 数据构建：多源题库 → 统一schema → 去重 → train/dev/holdout 切分（命主聚类防泄漏）
 * 用法：node benchmark/build-data.mjs   （BAZIQA_DATA_DIR 可覆盖 contest8 数据目录）
 * 产物：benchmark/data/benchmark-v1.json + benchmark/data/data-quality-report.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classify, validateRecord, subjectClusterKey, dedupKey, SPLITS } from './schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAZIQA = process.env.BAZIQA_DATA_DIR || path.join(ROOT, 'benchmark/sources/baziqa');

// 切分策略（时间切分：越新越接近真实"未见过"）：
// holdout=2024/2025（一次性终验）；dev=2021-2023（调参）；train=其余（含无答案年份，仅作语料/污染探针）
const SPLIT_BY_YEAR = (y) => (y >= 2024 ? 'holdout' : y >= 2021 ? 'dev' : 'train');

const records = [];
const push = (year, subjectId, birth, gender, qnum, question, options, answer, sourceNote) => {
  records.push({
    id: `y${year}-${subjectId}-q${qnum}`,
    year, subject_id: `y${year}-${subjectId}`,
    birth: birth ? { year: birth.year, month: birth.month, day: birth.day, hour: birth.hour ?? 12, minute: birth.minute ?? 0 } : null,
    gender, question: String(question).trim(),
    options: options.map((o, i) => {
      const t = String(o).trim();
      return /^[A-E]/.test(t) ? t.replace(/^([A-E])[\s.、．)]*/, '$1. ') : `${'ABCDE'[i]}. ${t}`;
    }),
    answer: answer || null,
    category: classify(question, options.map(String)),
    split: SPLIT_BY_YEAR(year),
    source: sourceNote,
  });
};

// ---- 源1：BaziQA contest8_2021-2025（金标已过2022/2023/2024官方键交叉验证） ----
for (const year of [2021, 2022, 2023, 2024, 2025]) {
  const fp = `${BAZIQA}/contest8_${year}.json`;
  if (!fs.existsSync(fp)) { console.warn(`跳过缺失源: ${fp}`); continue; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  for (const s of data) {
    if (!s || !s.questions || !s.profile) continue;
    const b = s.profile.birth;
    s.questions.forEach((q, qi) => {
      const opts = q.options.map(String);
      push(year, s.person_id, b, s.profile.gender, qi + 1, q.question, opts, String(q.answer || '').trim().charAt(0) || null, `BaziQA contest8_${year}`);
    });
  }
}

// ---- 源2：2010-2012（train-2010-2012.json，一手官网转录；birth为字符串，答案在gold） ----
{
  const SHICHEN = { 子: 0, 丑: 2, 寅: 4, 卯: 6, 辰: 8, 巳: 10, 午: 12, 未: 14, 申: 16, 酉: 18, 戌: 20, 亥: 22 };
  const fp = path.join(ROOT, 'train-data/train-2010-2012.json');
  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const yk of Object.keys(data)) {
      if (!/^y20\d\d$/.test(yk)) continue;
      const year = Number(yk.slice(1));
      for (const s of (data[yk].subjects || [])) {
        const qs = s.qs || [];
        if (!qs.length) { console.warn(`  ${yk}/${s.id}: 无题面(仅golds)，跳过`); continue; }
        const bm = String(s.birth || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*([子丑寅卯辰巳午未申酉戌亥])時\s*(男|女)/);
        if (!bm) { console.warn(`  ${yk}/${s.id}: birth解析失败`); continue; }
        const birth = { year: +bm[1], month: +bm[2], day: +bm[3], hour: SHICHEN[bm[4]], minute: 0 };
        const gender = bm[5] === '男' ? 'male' : 'female';
        qs.forEach((q, qi) => {
          const gold = q.gold ? String(q.gold).trim().charAt(0) : null;
          push(year, s.id, birth, gender, qi + 1, q.q, q.opts.map(String), gold, `官网转录 ${year}`);
        });
      }
    }
  }
}

// ---- 源2b：2012/2013（train-data/hkjfma-2012-2013.json，官网"過往活動"纯文本页一手转录，
//      答案公报已与存档原页逐字机器比对；2013-P4为猜时辰题:birth=null、生辰日期在题面 ----
{
  const fp = path.join(ROOT, 'train-data/hkjfma-2012-2013.json');
  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const yk of ['y2012', 'y2013']) {
      const year = Number(yk.slice(1));
      for (const s of (data[yk]?.subjects || [])) {
        const b = s.birth ? { year: s.birth.y, month: s.birth.m, day: s.birth.d, hour: s.birth.hour, minute: s.birth.minute ?? 0 } : null;
        const dateTag = s.birth ? `${s.birth.y}${String(s.birth.m).padStart(2, '0')}${String(s.birth.d).padStart(2, '0')}` : 'nobirth';
        const sid = `${s.gender}_${dateTag}_P${String(s.person_no).padStart(2, '0')}`;
        for (const q of s.questions) {
          const opts = Object.entries(q.options).map(([L, t]) => `${L}. ${t}`);
          push(year, sid, b, s.gender, q.no, q.question, opts, String(q.answer || '').trim().charAt(0) || null, `官网转录 ${year}(答案公报已比对原页)`);
        }
      }
    }
  }
}

// ---- 源3：2017（train-data/questions-2017.json；无答案键→unscored语料） ----
{
  const fp = path.join(ROOT, 'train-data/questions-2017.json');
  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const [si, s] of (data.subjects || []).entries()) {
      s.questions.forEach((q) => push(2017, s.person_id || `s${si + 1}`, s.birth, s.gender, q.qnum, q.question, q.options, q.answer, 'train-data/questions-2017.json (无官方键,unscored)'));
    }
  }
}

// ---- 源4：2018（监管审计版：以structured subjects×题号范围为边界；text只供题面/选项；40题必须全进） ----
{
  const txtFp = path.join(ROOT, 'train-data/text-2018-questions.txt');
  const goldFp = path.join(ROOT, 'train-data/questions-2018-structured.json');
  if (fs.existsSync(txtFp) && fs.existsSync(goldFp)) {
    const raw = fs.readFileSync(txtFp, 'utf8');
    const goldDoc = JSON.parse(fs.readFileSync(goldFp, 'utf8'));
    const golds = goldDoc.golds.map(g => String(g).trim().charAt(0));
    if (golds.length !== 40) throw new Error(`2018 golds≠40: ${golds.length}`);
    // 全文按 Q 编号切题（不做命主分段，规避 birth=null 命例的边界误并）
    const qmap = new Map();
    for (const qc of raw.split(/\n(?=Q\d+\s*[:：])/)) {
      const qm = qc.match(/^Q(\d+)\s*[:：]\s*([^\n]+)/);
      if (!qm) continue;
      const qnum = +qm[1];
      // 选项行：A-D 开头；后续非A-D/Q开头的行视为上一选项的续行合并
      const lines = qc.split('\n').slice(1);
      const opts = [];
      for (const ln of lines) {
        const om = ln.match(/^\s*([A-D])(?:[\s.、)]+|(?=[一-鿿]))(.+)$/);
        if (om) opts.push(`${om[1]}. ${om[2].trim()}`);
        else if (opts.length && ln.trim() && !/^(Q\d+|香港|台灣|中國|澳門|馬來|新加坡|命例|Question|Male|Female|http)/.test(ln.trim())) {
          opts[opts.length - 1] += ' ' + ln.trim();
        }
      }
      if (qmap.has(qnum)) throw new Error(`2018 Q${qnum} 重复出现`);
      qmap.set(qnum, { question: qm[2].trim(), options: opts.slice(0, 4) });
    }
    for (let q = 1; q <= 40; q++) {
      if (!qmap.has(q)) throw new Error(`2018 Q${q} 缺失于text解析`);
      if (qmap.get(q).options.length !== 4) throw new Error(`2018 Q${q} 选项${qmap.get(q).options.length}个`);
    }
    // 题号→命主：按 structured subjects 顺序及其 qs 长度分配（含 8/8b 双命例与 birth=null 命例6）
    let cursor = 1;
    for (const s of goldDoc.subjects) {
      const nq = (s.qs || []).length;
      const birth = s.birth ? { year: s.birth.y, month: s.birth.m, day: s.birth.d, hour: s.birth.h, minute: 0 } : null;
      const gender = s.birth ? (s.birth.g === 'male' ? 'male' : 'female') : null;
      for (let q = cursor; q < cursor + nq; q++) {
        const item = qmap.get(q);
        push(2018, `s${s.n}`, birth, gender, q, item.question, item.options, golds[q - 1], '2018官方题面+8出题人官方键');
      }
      cursor += nq;
    }
    if (cursor !== 41) throw new Error(`2018 题号分配错位: cursor=${cursor}`);
  }
}

// ---- 源5：2020（train-data/questions-2020.json；birth为字符串；官方答案键未获→unscored） ----
{
  const SHICHEN = { 子: 0, 丑: 2, 寅: 4, 卯: 6, 辰: 8, 巳: 10, 午: 12, 未: 14, 申: 16, 酉: 18, 戌: 20, 亥: 22 };
  const fp = path.join(ROOT, 'train-data/questions-2020.json');
  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const s of (data.subjects || data.papers || [])) {
      // 生辰两种格式：时辰（巳時）或钟点（23:50）
      const bm = String(s.birth || '').match(/(男|女)\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:([子丑寅卯辰巳午未申酉戌亥])時|(\d{1,2}):(\d{2}))/);
      if (!bm) { console.warn(`  2020 ${s.n}: birth解析失败: ${s.birth}`); continue; }
      const birth = bm[5]
        ? { year: +bm[2], month: +bm[3], day: +bm[4], hour: SHICHEN[bm[5]], minute: 0 }
        : { year: +bm[2], month: +bm[3], day: +bm[4], hour: +bm[6], minute: +bm[7] };
      const gender = bm[1] === '男' ? 'male' : 'female';
      (s.qs || []).forEach((q, qi) => {
        push(2020, `s${s.n}`, birth, gender, qi + 1, q.q, (q.opts || []).map(String), null, 'train-data/questions-2020.json (官方键未获,unscored)');
      });
    }
  }
}

// ---- 校验 ----
const report = { built_at: new Date().toISOString(), sources: {}, invalid: [], duplicates: [], leaks_fixed: [], counts: {} };
for (const r of records) report.sources[r.source] = (report.sources[r.source] || 0) + 1;
const valid = [];
for (const r of records) {
  const errs = validateRecord(r);
  if (errs.length) report.invalid.push({ id: r.id, errs });
  else valid.push(r);
}

// ---- 去重（题面级） ----
const seen = new Map();
const deduped = [];
for (const r of valid) {
  const k = dedupKey(r);
  if (seen.has(k)) { report.duplicates.push({ dup: r.id, kept: seen.get(k) }); continue; }
  seen.set(k, r.id);
  deduped.push(r);
}

// ---- 防泄漏：同命主聚类跨 split → 全聚类降到最早的 split（train<dev<holdout 优先保训练侧，泄漏题移出评测集） ----
const order = { train: 0, dev: 1, holdout: 2 };
const clusterSplit = new Map();
for (const r of deduped) {
  const c = subjectClusterKey(r);
  const cur = clusterSplit.get(c);
  if (cur === undefined || order[r.split] < order[cur]) clusterSplit.set(c, r.split);
}
for (const r of deduped) {
  const c = subjectClusterKey(r);
  const target = clusterSplit.get(c);
  if (target !== r.split) { report.leaks_fixed.push({ id: r.id, from: r.split, to: target }); r.split = target; }
}

// ---- 统计 ----
for (const s of SPLITS) {
  const rs = deduped.filter(r => r.split === s);
  report.counts[s] = { total: rs.length, scoreable: rs.filter(r => r.answer).length, subjects: new Set(rs.map(r => r.subject_id)).size };
}
report.counts.all = { total: deduped.length, scoreable: deduped.filter(r => r.answer).length };

const outDir = path.join(ROOT, 'benchmark/data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'benchmark-v1.json'), JSON.stringify({ version: 'v1', records: deduped }, null, 1));
fs.writeFileSync(path.join(outDir, 'data-quality-report.json'), JSON.stringify(report, null, 1));
console.log('sources:', report.sources);
console.log('invalid:', report.invalid.length, ' duplicates:', report.duplicates.length, ' leaks_fixed:', report.leaks_fixed.length);
console.log('counts:', JSON.stringify(report.counts));
if (report.invalid.length) console.log('invalid样例:', JSON.stringify(report.invalid.slice(0, 3)));
