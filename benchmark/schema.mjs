/**
 * 命理 Benchmark 统一 schema 与校验（docs/benchmark-mcp-design.md 的落地）
 * 记录粒度 = 单题；命主信息内联（split/去重按命主聚类）
 */

export const SPLITS = ['train', 'dev', 'holdout'];

export const CATEGORIES = ['year', 'family', 'marriage', 'wealth', 'career', 'health', 'origin', 'other'];

/** 题目分类：关键词优先级判定（year=选项或题面含年份数字） */
export function classify(question, options) {
  const all = question + ' ' + options.join(' ');
  if (/(1[5-9]|20)\d{2}/.test(all)) return 'year'; // 15xx起：私有集年谱命例的应期年份在18xx-19xx
  if (/(父|母|兄|弟|姐|妹|叔|子女|仔|孩|六親|六亲)/.test(all)) return 'family';
  if (/(婚|感情|拍拖|配偶|妻|夫)/.test(all)) return 'marriage';
  if (/(財|财|富|貧|贫|錢|钱|投資|投资|債|债)/.test(all)) return 'wealth';
  if (/(事業|事业|職|职|行業|行业|工作|學業|学业|學歷|学历)/.test(all)) return 'career';
  if (/(病|健康|身體|身体|災|灾|傷|伤|亡|去世|死)/.test(all)) return 'health';
  if (/(出身|家境|背景)/.test(all)) return 'origin';
  return 'other';
}

/** 单条记录校验：返回错误串数组（空=合法） */
export function validateRecord(r) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(typeof r.id === 'string' && r.id.length > 0, 'id缺失');
  need(Number.isInteger(r.year) && r.year >= 2010 && r.year <= 2030, `year非法:${r.year}`);
  need(typeof r.subject_id === 'string' && r.subject_id.length > 0, 'subject_id缺失');
  // birth 允许为 null（个别命例官方未公布生辰）；有值则须合法。缺生辰记录仍可被非盘面基线评分
  if (r.birth !== null && r.birth !== undefined) {
    need(Number.isInteger(r.birth.year) && r.birth.year > 1500 && r.birth.year < 2030, 'birth.year非法'); // 下限1500：私有集收明清民国年谱命例（赛事命主均1900后，不受影响）
    need(r.birth.month >= 1 && r.birth.month <= 12, 'birth.month非法');
    need(r.birth.day >= 1 && r.birth.day <= 31, 'birth.day非法');
    need(r.birth.hour >= 0 && r.birth.hour <= 23, 'birth.hour非法');
  }
  need(r.gender === 'male' || r.gender === 'female' || (r.gender === null && r.birth === null), `gender非法:${r.gender}`);
  need(typeof r.question === 'string' && r.question.length >= 2, 'question过短');
  // 4选项为主；2010/2011为5选项(A-E)，机会水平按选项数逐题计
  need(Array.isArray(r.options) && (r.options.length === 4 || r.options.length === 5), `选项数非4/5:${r.options && r.options.length}`);
  if (Array.isArray(r.options)) {
    const letters = r.options.map(o => String(o).trim().charAt(0));
    need(JSON.stringify(letters) === JSON.stringify(['A', 'B', 'C', 'D', 'E'].slice(0, r.options.length)), `选项字母序异常:${letters}`);
  }
  need(r.answer === null || ['A', 'B', 'C', 'D', 'E'].includes(r.answer), `answer非法:${r.answer}`);
  need(CATEGORIES.includes(r.category), `category非法:${r.category}`);
  need(SPLITS.includes(r.split), `split非法:${r.split}`);
  return errs;
}

/** 命主聚类键：同生辰同性别视为同一人（跨年份出现 → 防泄漏归并）；缺生辰按 subject_id 独立成簇 */
export function subjectClusterKey(r) {
  const b = r.birth;
  if (!b) return `nobirth:${r.subject_id}`;
  return `${b.year}-${b.month}-${b.day}-${b.hour}-${r.gender}`;
}

/** 题面去重键：归一化题干+选项 */
export function dedupKey(r) {
  const norm = (s) => String(s).replace(/\s+/g, '').replace(/[，。？！,.?!、]/g, '');
  return norm(r.question) + '|' + r.options.map(norm).join('|');
}
