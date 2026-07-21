/**
 * 反向可检索性审计（modern 计分池效度体检）
 * ────────────────────────────────────────────────────────────────────────
 * 背景：modern 计分池来自公开源(元亨利贞/贴吧匿名命例)。题面只给"生辰+性别+问题"(无姓名无地名)，
 *   但**持有同一批源语料的攻击者**可拿生辰在本地语料里反查原帖读结局=白捡分(非命理能力)。
 *   本工具为每条 modern 计分题生成"反查worklist"(八字 + 候选检索式)，供人工/agent 逐条核验其可检索性。
 *
 * 用法：
 *   node audit-findability.mjs               # 打印全部 worklist(JSONL)
 *   node audit-findability.mjs --sample 20   # 随机抽 20 条(种子固定,可复现)
 *
 * 判定与闭环：
 *   1) 对每条的 queries 跑检索(mainstream + **务必包含 Baidu/贴吧**，US 引擎查不到中文论坛=假阴性)；
 *   2) 若能反查到原帖并读出结局答案 → 在 sources/private-2026/cases.json 对应命主标 "findable": true；
 *   3) 重建私有集(build-private-set.mjs)→ 该命主自动移入诊断池(isDiag)、不再计入 top1 排名。
 *   （已跑过一轮 US-WebSearch 抽样8条：datetime+事件 与 完整八字 两种检索式均只命中泛化"日柱性格"文章、
 *     未命中具体命例=casual web 不可查；但 Baidu/贴吧 与"corpus-holder 本地匹配"未覆盖，仍是残余风险。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Solar } from 'lunar-javascript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(fs.readFileSync(path.join(HERE, 'data/private-set.json'), 'utf8'));
const recs = set.records || [];
const scored = recs.filter(r => r.origin === 'modern' && !r.secondhand && r.control !== true);

const args = process.argv.slice(2);
const sampleIdx = args.indexOf('--sample');
let list = scored;
if (sampleIdx >= 0) {
  const n = Number(args[sampleIdx + 1]) || 20;
  // 固定种子抽样(mulberry32)，可复现
  let a = 0x9e3779b9; const rng = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  list = [...scored].map(r => [rng(), r]).sort((x, y) => x[0] - y[0]).slice(0, n).map(x => x[1]);
}

const bazi = (b) => {
  const s = Solar.fromYmdHms(b.year, b.month, b.day, b.hour, b.minute || 0, 0);
  const e = s.getLunar().getEightChar();
  return `${e.getYear()} ${e.getMonth()} ${e.getDay()} ${e.getTime()}`;
};

let n = 0;
for (const r of list) {
  const b = r.birth;
  const born = `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')} ${String(b.hour).padStart(2, '0')}:${String(b.minute || 0).padStart(2, '0')}`;
  const ba = bazi(b);
  const evt = String(r.question || '').replace(/命主(在)?哪一?年?|[？?]/g, '').trim().slice(0, 18);
  const item = {
    subject_id: r.subject_id, born, gender: r.gender, bazi: ba, question: r.question,
    queries: [
      `"${ba}" 命例`,                             // 完整八字(最强)
      `八字 ${b.year}年 ${r.gender === 'female' ? '女' : '男'}命 ${evt}`, // 生辰+事件
      `贴吧 八字 ${evt} ${b.year}`,               // 贴吧向
    ],
  };
  console.log(JSON.stringify(item));
  n++;
}
console.error(`\n[audit] 计分 modern 命主共 ${new Set(scored.map(r => r.subject_id)).size} 人，本次列出 ${n} 条题的 worklist。判定后在 sources 标 findable:true → 重建即降级。`);
