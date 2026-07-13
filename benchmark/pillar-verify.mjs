/** 四柱↔公历 校验工具（私有集数据质量闸）
 *  用途：
 *   1. reverseSearch(pillars, range)  古籍命例只给干支 → 反推候选公历生辰。
 *      0 解 = 干支有误（OCR/转录/五虎遁不合）→ 剔题；≥1 解 = 干支自洽。
 *   2. lunarToSolarPillars(...)       年谱历日（旧历年月日+时辰）→ 公历 + 四柱。
 *   3. wuhuDun / wushuDun             五虎遁月干、五鼠遁时干独立校验（不依赖历法引擎的旁证）。
 *  历法引擎：lunar-javascript（年柱以立春为界、月柱以节为界——子平标准）。
 *  ⚠️ 子时件（时支=子）存在早晚子时流派分歧，reverseSearch 会标 zishi_ambiguous，
 *     此类命例出题时四柱须内嵌题面、不给公历时刻，绕开流派差异。
 */
import pkg from 'lunar-javascript';
const { Solar, Lunar } = pkg;

export const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
export const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const SHICHEN_HOUR = { 子: 0, 丑: 2, 寅: 4, 卯: 6, 辰: 8, 巳: 10, 午: 12, 未: 14, 申: 16, 酉: 18, 戌: 20, 亥: 22 };

export function splitGZ(gz) {
  const g = gz.charAt(0), z = gz.charAt(1);
  if (!GAN.includes(g) || !ZHI.includes(z)) throw new Error(`非法干支: ${gz}`);
  return [g, z];
}

/** 五虎遁：年干+月支 → 月干（正月建寅起）。与历法引擎相互独立，用作旁证 */
export function wuhuDun(yearGan, monthZhi) {
  const first = { 甲: '丙', 己: '丙', 乙: '戊', 庚: '戊', 丙: '庚', 辛: '庚', 丁: '壬', 壬: '壬', 戊: '甲', 癸: '甲' }[yearGan];
  const offset = (ZHI.indexOf(monthZhi) - ZHI.indexOf('寅') + 12) % 12;
  return GAN[(GAN.indexOf(first) + offset) % 10];
}

/** 五鼠遁：日干+时支 → 时干 */
export function wushuDun(dayGan, timeZhi) {
  const first = { 甲: '甲', 己: '甲', 乙: '丙', 庚: '丙', 丙: '戊', 辛: '戊', 丁: '庚', 壬: '庚', 戊: '壬', 癸: '壬' }[dayGan];
  return GAN[(GAN.indexOf(first) + ZHI.indexOf(timeZhi)) % 10];
}

/** 干支自洽预检（不查历法，只查遁法）：返回错误串数组 */
export function pillarSanity({ year, month, day, time }) {
  const errs = [];
  let yg, mz, dg, tz, mg, tg;
  try { [yg] = splitGZ(year); [mg, mz] = splitGZ(month); [dg] = splitGZ(day); if (time) [tg, tz] = splitGZ(time); }
  catch (e) { return [e.message]; }
  if (wuhuDun(yg, mz) !== mg) errs.push(`月干不合五虎遁: ${year}年${month}月 应为${wuhuDun(yg, mz)}${mz}`);
  if (time && wushuDun(dg, tz) !== tg) errs.push(`时干不合五鼠遁: ${day}日${time}时 应为${wushuDun(dg, tz)}${tz}`);
  return errs;
}

function eightCharAt(y, m, d, hour) {
  const ec = Solar.fromYmdHms(y, m, d, hour, 30, 0).getLunar().getEightChar();
  return { year: ec.getYear(), month: ec.getMonth(), day: ec.getDay(), time: ec.getTime() };
}

/** 反推：四柱 → [start,end] 年代内所有匹配公历时刻（时刻取时辰正中±，子时另标歧义） */
export function reverseSearch({ year, month, day, time }, { start = 1500, end = 1949 } = {}) {
  const sanity = pillarSanity({ year, month, day, time });
  if (sanity.length) return { ok: false, reason: sanity.join('; '), candidates: [] };
  const [, tz] = time ? splitGZ(time) : [null, null];
  const zishiAmbiguous = tz === '子';
  const candidates = [];
  // 年柱 60 年一遇：按"公历年立春后的年柱"筛出候选年，再在其立春~次年立春区间内逐日找月柱+日柱
  for (let y = start; y <= end; y++) {
    const midFeb = eightCharAt(y, 2, 20, 12); // 立春后：该公历年的主年柱
    if (midFeb.year !== year) continue;
    // 该年柱覆盖 y年立春 ~ y+1年立春；逐日扫这一区间找月柱+日柱
    const from = new Date(Date.UTC(y, 1, 1));   // 2月1日起（含立春前缓冲）
    const to = new Date(Date.UTC(y + 1, 1, 20)); // 次年2月20日止
    for (let t = from.getTime(); t <= to.getTime(); t += 86400_000) {
      const dt = new Date(t);
      const [gy, gm, gd] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
      // 交节日当天月柱随时辰变化（如立冬上午仍属戌月）→ 不能只在正午探测：
      // 有时辰则按目标时辰全柱比对；无时辰则探 2/12/22 点覆盖交节两侧
      const probeHours = time ? [SHICHEN_HOUR[tz]] : [2, 12, 22];
      for (const hour of probeHours) {
        const p = eightCharAt(gy, gm, gd, hour);
        if (p.year !== year || p.month !== month || p.day !== day) continue;
        if (time && p.time !== time) continue;
        candidates.push({ y: gy, m: gm, d: gd, hour: time ? hour : null, zishiAmbiguous });
        break;
      }
    }
  }
  return { ok: candidates.length > 0, reason: candidates.length ? null : '年代范围内无匹配日期（疑干支转录有误）', candidates, zishiAmbiguous };
}

/** 年谱历日 → 公历+四柱。lunarY=公历纪年的农历年（如道光十五年→1835），lunarM 闰月传负数 */
export function lunarToSolarPillars(lunarY, lunarM, lunarD, shichen) {
  const solar = Lunar.fromYmd(lunarY, lunarM, lunarD).getSolar();
  const hour = shichen ? SHICHEN_HOUR[shichen] : 12;
  const ec = eightCharAt(solar.getYear(), solar.getMonth(), solar.getDay(), hour);
  return {
    solar: { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay(), hour },
    pillars: ec,
    zishiAmbiguous: shichen === '子',
  };
}

// ---- 自检（node benchmark/pillar-verify.mjs）----
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => { if (cond) { pass++; } else { fail++; console.error(`✗ ${name} ${detail}`); } };

  // 1. 往返：任取公历时刻 → 四柱 → 反推必须命中原日期
  for (const [y, m, d, h] of [[1888, 6, 15, 10], [1835, 3, 2, 16], [1901, 11, 8, 8], [1924, 2, 5, 14]]) {
    const p = eightCharAt(y, m, d, h);
    const r = reverseSearch(p, { start: y - 5, end: y + 5 });
    check(`往返${y}-${m}-${d}`, r.ok && r.candidates.some(c => c.y === y && c.m === m && c.d === d), JSON.stringify(r).slice(0, 120));
  }
  // 2. 立春界（判别性用例：1984 正月初一=2月2日，立春=2月4日；2月3日在初一后、立春前，
  //    立春界→癸亥，若引擎按正月初一界则会给甲子——此例能区分两种约定）
  check('立春前癸亥(2月3日)', eightCharAt(1984, 2, 3, 12).year === '癸亥', eightCharAt(1984, 2, 3, 12).year);
  check('立春后甲子', eightCharAt(1984, 2, 5, 12).year === '甲子', eightCharAt(1984, 2, 5, 12).year);
  // 2b. 交节日内时辰决定月柱：1901-11-08 立冬，上午8点应仍属戌月、正午后属亥月
  const jq1 = eightCharAt(1901, 11, 8, 8), jq2 = eightCharAt(1901, 11, 8, 14);
  check('交节日月柱分界', jq1.month !== jq2.month, `${jq1.month} vs ${jq2.month}`);
  // 3. 五虎遁/五鼠遁与引擎一致（抽样对拍 200 天）
  let dunOK = true;
  for (let i = 0; i < 200; i++) {
    const y = 1700 + (i * 7) % 240, m = 1 + (i * 5) % 12, d = 1 + (i * 11) % 28, h = (i * 2) % 24 || 10;
    const p = eightCharAt(y, m, d, h);
    if (wuhuDun(p.year[0], p.month[1]) !== p.month[0]) { dunOK = false; break; }
    if (h >= 1 && h <= 22 && wushuDun(p.day[0], p.time[1]) !== p.time[0]) { dunOK = false; break; }
  }
  check('遁法对拍200天', dunOK);
  // 4. 坏干支必须被拦：月干破坏五虎遁
  const bad = reverseSearch({ year: '甲子', month: '乙丑', day: '丙午', time: '戊戌' });
  check('坏月干拦截', !bad.ok && /五虎遁/.test(bad.reason || ''), bad.reason);
  // 5. 农历换算：道光十五年二月初三 → 公历 1835-03-01（±1天内，用往返验证）
  const np = lunarToSolarPillars(1835, 2, 3, '辰');
  const back = Solar.fromYmdHms(np.solar.year, np.solar.month, np.solar.day, 12, 0, 0).getLunar();
  check('年谱换算往返', back.getMonth() === 2 && back.getDay() === 3, `${np.solar.year}-${np.solar.month}-${np.solar.day} → 农历${back.getMonth()}月${back.getDay()}日`);

  console.log(`pillar-verify 自检: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
