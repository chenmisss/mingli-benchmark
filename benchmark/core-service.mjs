/** 评测台核心服务（协议无关）：HTTP 与 MCP 适配层共用
 *  审计(Needs-revision)修复：全集口径评分+满覆盖入榜门槛、粗粒度反预言机、私有集机制、
 *  完整内容版本哈希、endpoint强制online、SSRF加固(HTTPS/禁重定向/响应限长/逐跳复查/异步)、
 *  API key哈希存储、原子写。本地参考实现：文件态存储 benchmark/var/。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { fileURLToPath } from 'url';
import { aggregate, bootstrapCI, mulberry32 } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAR = process.env.BENCH_VAR_DIR || path.join(HERE, 'var');
const SCHEMA_VERSION = '1';
const MAX_ENDPOINT_BYTES = 1_000_000; // endpoint 响应体上限，防 DoS
// 反作弊参数走 env：生产真值不可从开源代码读出（TRS事件：45.0%成绩恰好停在代码可见的0.45线上）
const ALERT_THRESH = Number(process.env.BENCH_ALERT_THRESH || 0.45);
const FP_SALT = process.env.BENCH_FP_SALT || 'bench-fp-dev-salt';
const PAPER_WINDOW_MS = Number(process.env.BENCH_PAPER_WINDOW_H || 6) * 3600_000; // 官方集领题→交卷时窗
const REQUIRE_REASONING = process.env.BENCH_REQUIRE_REASONING !== '0'; // 硬性推理链:每题须附reasoning才入榜(默认开,置'0'关)
const REASON_MIN = Number(process.env.BENCH_REASON_MIN || 0.9); // 需附非空reasoning的答案占比下限

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** 客户端指纹：加盐哈希(IP+UA)，只存哈希不存原文；用于马甲聚类审计，绝不下发 */
const clientFp = (client) => (client && (client.ip || client.ua)) ? sha(`${FP_SALT}|${client.ip || ''}|${client.ua || ''}`).slice(0, 16) : null;

/** 选项确定性重排：按(app,set,record)生成 displayPos→originalPos（Fisher-Yates，同参恒同）；仅私有/测试集 */
export function optionPermutation(appId, setId, recordId, n) {
  const rng = mulberry32(parseInt(sha(`${appId}|${setId}|${recordId}`).slice(0, 8), 16));
  const perm = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  return perm;
}

/** 数据集完整内容哈希：覆盖题面/选项/切分/生辰/schema，任一变化即版本升级 */
export function datasetHash(records, baseVersion) {
  const canon = records.map(r => ({
    id: r.id, year: r.year, subject_id: r.subject_id, birth: r.birth, gender: r.gender,
    question: r.question, options: r.options, answer: r.answer, category: r.category, split: r.split,
    origin: r.origin, control: r.control, secondhand: r.secondhand, // 私有集专用字段；主库无此字段时为undefined→JSON序列化自动省略,既有哈希不变
  })).sort((a, b) => (a.id < b.id ? -1 : 1));
  return `${baseVersion}#s${SCHEMA_VERSION}#${sha(JSON.stringify(canon)).slice(0, 12)}`;
}

/** SSRF 防护：拒绝环回/私网/链路本地(含云元数据169.254.169.254)/保留段主机 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:');
}
export async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) { if (isPrivateIp(hostname)) throw Object.assign(new Error('endpoint resolves to private/loopback address'), { status: 400 }); return; }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw Object.assign(new Error('endpoint host not allowed'), { status: 400 });
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch { throw Object.assign(new Error('endpoint host does not resolve'), { status: 400 }); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw Object.assign(new Error('endpoint resolves to private/loopback address'), { status: 400 });
}

/** 逐题命中(0/1)的配对置换检验（按命主聚类符号翻转），用于榜单相邻显著性 */
function pairedPermHits(hitsA, hitsB, subjectById, { P = 5000, seed = 42 } = {}) {
  const bySubj = new Map();
  for (const id of Object.keys(hitsA)) {
    if (!(id in hitsB)) continue;
    const s = subjectById[id] || id;
    bySubj.set(s, (bySubj.get(s) || 0) + (hitsA[id] - hitsB[id]));
  }
  const diffs = [...bySubj.values()];
  if (!diffs.length) return null;
  const obs = Math.abs(diffs.reduce((a, b) => a + b, 0));
  const rng = mulberry32(seed);
  let ge = 0;
  for (let p = 0; p < P; p++) { let s = 0; for (const d of diffs) s += rng() < 0.5 ? d : -d; if (Math.abs(s) >= obs - 1e-12) ge++; }
  return (ge + 1) / (P + 1);
}

const coarseBucket = (x) => { const lo = Math.floor(x * 10) * 10; return `${lo}%–${lo + 10}%`; };

export class BenchService {
  constructor({ dataFile = path.join(HERE, 'data/benchmark-v1.json'), privateFile = path.join(HERE, 'data/private-set.json'),
    varDir = VAR, quotaPerSet = 5, rateLimitPerMin = 30, k = 2, allowPrivateEndpoints = false, requireRegToken = null, disableHostedEndpoint = true, store = null } = {}) {
    fs.mkdirSync(varDir, { recursive: true });
    this.store = store; // 云端 Firestore 适配（鸭子类型: loadAll/putApp/putSub/putRevealed）；null=本地文件态
    this.varDir = varDir; this.k = k; this.quotaPerSet = quotaPerSet; this.rateLimitPerMin = rateLimitPerMin;
    this.allowPrivateEndpoints = allowPrivateEndpoints; // 仅测试放行 http/localhost；生产恒 false
    this.requireRegToken = requireRegToken; // 生产可设注册令牌，抑制女巫式无限注册
    this.requireReasoning = REQUIRE_REASONING; // 硬性推理链闸(env BENCH_REQUIRE_REASONING=0 可关，测试可实例后覆盖)
    this.disableHostedEndpoint = disableHostedEndpoint; // 安全默认=true：托管endpoint默认关（消SSRF面），须显式 disableHostedEndpoint:false 才开
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    this.records = raw.records;
    // 私有正式题集（未公开）：默认不存在→空，等新赛季题接入
    const priv = fs.existsSync(privateFile) ? (JSON.parse(fs.readFileSync(privateFile, 'utf8')).records || []) : [];
    this.datasetVersion = datasetHash([...this.records, ...priv], raw.version || 'v1');
    // 考集：public_dev(公开开发集,gold可下载) / public_test(2024-25题答案已公开,仅自查,非官方) / private(服务端私有,官方排名唯一依据)
    // goldPublic=能否下载gold；revealResults=能否即时看精确成绩(gold已公开则无秘密可保护)；
    // official=是否产生官方排名。反预言机(粗粒度)只对 revealResults=false 的私有集生效；
    // 满覆盖入榜门槛对所有集生效(挡一题攻击)。
    this.sets = {
      public_dev: { records: this.records.filter(r => r.split === 'dev' && r.answer), goldPublic: true, revealResults: true, official: false, practice: true, disclosure: '【练习区】公开开发集，gold 可下载，仅供调参与接入自测，答案公开可查、不计入擂台排名' },
      public_test: { records: this.records.filter(r => r.split === 'holdout' && r.answer), goldPublic: false, revealResults: true, official: false, practice: true, disclosure: '【练习区】题目与答案已随赛事(2024-2025)公开在网上，可自测但答案可查、能刷分，不计入擂台排名；真实水平以 private 擂台榜为准' },
      // 擂台榜：答案服务端私有、永不公开、不可下载——无题可查、无答案可查，天然刷不了；即时判分只回总分(逐题对错不下发)，
      //   加每队选项乱序+客户端指纹+跳分报警，即时出分也无法当 oracle 反推。这才是公平比准确率的唯一口径。
      private: { records: priv.filter(r => r.answer), goldPublic: false, revealResults: true, official: true, disclosure: '【擂台榜·官方唯一口径】服务端私有题集，答案永不公开、不可下载；每家仅一次正式作答、即时判分上榜。含少量诊断题不计入排名（与计分题混排、不单独标注，用于质量与污染监测）' },
    };
    this.appsFile = path.join(varDir, 'apps.json');
    this.subsFile = path.join(varDir, 'submissions.json');
    this.auditFile = path.join(varDir, 'audit.log');
    if (store) { this.apps = {}; this.subs = {}; } // 云端：待 init() 从 Firestore 载入
    else {
      this.apps = fs.existsSync(this.appsFile) ? JSON.parse(fs.readFileSync(this.appsFile, 'utf8')) : {};
      this.subs = fs.existsSync(this.subsFile) ? JSON.parse(fs.readFileSync(this.subsFile, 'utf8')) : {};
    }
    this.rateBuckets = new Map();
    this.revealed = new Set(); // 官方集赛后揭晓精确成绩的集合
  }

  /** 云端启动前调用：从 Firestore 载入 apps/subs/revealed（文件态无需调用） */
  async init() {
    if (this.store) {
      const s = await this.store.loadAll();
      this.apps = s.apps || {}; this.subs = s.subs || {}; this.revealed = new Set(s.revealed || []);
    }
    return this;
  }

  _atomicWrite(file, obj) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file); // rename 原子，避免半写
  }
  _save() { this._atomicWrite(this.appsFile, this.apps); this._atomicWrite(this.subsFile, this.subs); }
  // 云端逐文档持久化；文件态退回整文件原子写（测试行为不变）
  _persistApp(id) { if (this.store) this.store.putApp(id, this.apps[id]); else this._save(); }
  _persistSub(id) { if (this.store) this.store.putSub(id, this.subs[id]); else this._save(); }
  audit(appId, action, detail) {
    const line = JSON.stringify({ ts: new Date().toISOString(), appId, action, ...detail });
    if (this.store) console.log('[bench-audit]', line); // 云端走 Cloud Logging（本地文件在容器里是临时的）
    try { fs.appendFileSync(this.auditFile, line + '\n'); } catch { /* 只读fs时忽略 */ }
  }
  err(code, message) { const e = new Error(message); e.status = code; return e; }

  rateCheck(key) {
    const now = Date.now();
    const fresh = (this.rateBuckets.get(key) || []).filter(t => now - t < 60_000);
    if (fresh.length >= this.rateLimitPerMin) throw this.err(429, 'rate limit exceeded (per-minute)');
    fresh.push(now); this.rateBuckets.set(key, fresh);
  }
  auth(apiKey) {
    const h = sha(String(apiKey || ''));
    const app = Object.values(this.apps).find(a => a.keyHash === h);
    if (!app) throw this.err(401, 'invalid api key');
    this.rateCheck(app.appId);
    return app;
  }

  registerApp({ name, track = 'offline', contact = '', regToken = '' } = {}, client = null) {
    // 名称先去控制符；U+FFFD=客户端以非UTF-8提交、被解析器替换掉的损坏字节，直接拒绝——
    //   否则脏名进公开榜且原字节已不可复原（曾出现"锟斤拷"式乱码队名）。
    const cleanName = String(name ?? '').replace(/[ -]/g, '').trim();
    if (/�/.test(cleanName)) throw this.err(400, 'name encoding invalid：请以 UTF-8 提交队名（检测到编码损坏字符）');
    if (!cleanName || cleanName.length < 2) throw this.err(400, 'name required');
    if (!['online', 'offline'].includes(track)) throw this.err(400, 'track must be online|offline');
    if (this.requireRegToken && regToken !== this.requireRegToken) throw this.err(403, 'valid registration token required');
    this.rateCheck('register'); // 注册也限速，抑制爆量注册
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const apiKey = 'bk_' + crypto.randomBytes(18).toString('hex');
    const regFp = clientFp(client);
    this.apps[appId] = { appId, keyHash: sha(apiKey), name: cleanName.slice(0, 60), track, contact: String(contact).replace(/[ -]/g, '').slice(0, 120), createdAt: new Date().toISOString(), ...(regFp ? { regFp } : {}) };
    this._persistApp(appId);
    this.audit(appId, 'register', { name: cleanName, track, fp: regFp, ip: client?.ip, ua: client?.ua }); // 原始IP/UA仅入审计日志
    // 明文 key 仅此一次返回。同时给蛇形别名：MCP 工具描述/入参与本 API 其余字段皆蛇形(api_key/set_id/...)，
    //   此前 register 只回驼峰 apiKey，参赛方按 api_key 读得空值→领题 401→"下不来题"。驼峰保留向后兼容。
    return { appId, apiKey, track, datasetVersion: this.datasetVersion,
             app_id: appId, api_key: apiKey, dataset_version: this.datasetVersion };
  }

  listSets(apiKey) {
    const app = this.auth(apiKey);
    this.audit(app.appId, 'list_sets', {});
    return Object.entries(this.sets).map(([id, s]) => ({ set_id: id, n: s.records.length, gold_public: s.goldPublic, official: s.official, disclosure: s.disclosure, dataset_version: this.datasetVersion, quota_per_app: s.official ? 1 : this.quotaPerSet, requires_full_coverage: true }));
  }

  _displayOptions(appId, setId, rec) {
    const perm = optionPermutation(appId, setId, rec.id, rec.options.length);
    return perm.map((orig, disp) => `${'ABCDE'[disp]}. ${rec.options[orig].replace(/^[A-E][.、)\s]*/, '')}`);
  }

  /** 参赛方安全记录视图：剥答案与一切服务端元标注。origin/control/secondhand 绝不可下发——诊断题一旦可识别即失效 */
  _publicRecord(appId, setId, set, r) {
    const { answer, split, source, origin, control, secondhand, ...pub } = r;
    if (!set.goldPublic) pub.options = this._displayOptions(appId, setId, r);
    return pub;
  }

  /** 领题：永不含答案；每应用固定乱序（防跨队伍串答案位次） */
  getPaper(apiKey, setId) {
    const app = this.auth(apiKey);
    const set = this.sets[setId];
    if (!set) throw this.err(404, 'unknown set');
    const rng = mulberry32(parseInt(sha(app.appId + setId).slice(0, 8), 16));
    const order = set.records.map((_, i) => i).sort(() => rng() - 0.5);
    // 官方集领题计时：首次领题起算交卷时窗（堵"领题后无限期离线查证"）
    if (set.official) {
      app.paperAt = app.paperAt || {};
      if (!app.paperAt[setId]) { app.paperAt[setId] = new Date().toISOString(); this._persistApp(app.appId); }
    }
    this.audit(app.appId, 'get_paper', { setId });
    return {
      set_id: setId, dataset_version: this.datasetVersion, n: set.records.length, requires_full_coverage: true,
      records: order.map(i => this._publicRecord(app.appId, setId, set, set.records[i])), // 防背题/位置偏置+元标注剥离
    };
  }

  /** 公开开发集下载（含gold，仅 public_dev） */
  downloadDataset(apiKey, setId) {
    const app = this.auth(apiKey);
    const set = this.sets[setId];
    if (!set) throw this.err(404, 'unknown set');
    if (!set.goldPublic) throw this.err(403, 'gold is server-private for this set');
    this.audit(app.appId, 'download_dataset', { setId });
    return { set_id: setId, dataset_version: this.datasetVersion, records: set.records };
  }

  _score(setId, answers, appId) {
    const set = this.sets[setId];
    // 🆕 对照题(record.control===true,安慰剂/阴性对照)：金标为随机指定,与命盘无真实关系。
    //    不计入排名指标(top1/brier/hits),单独统计——任何系统在对照题上显著超机会水平=答案泄漏/出题指纹,
    //    对照题上的置信度=对噪声的诚实度。参赛方领题时不可区分(题面同风格,选项同样重排)。
    const isCtrl = (r) => r.control === true;
    // 🆕 诊断池(不计排名分):①古籍太典型(几乎必在训练语料),计入top1会让"背过原书"系统白捡分;
    //    ②二手转录(命理师转载读者私信,secondhand)真实性弱于自发多楼求测帖——均摘出计分、只保留切片对比。
    //    对照题同池。计分池=自发采集的年谱+现代求测帖,官方排名唯一口径。
    // 诊断池(不计排名分)：古籍(背书)/年谱历史人物(生平在史书,可从答案反推身份)/二手转录/对照。
    //   计分池=仅现代真实普通人命例——查无此人、事迹网上找不到，真正污染不了。
    // findable=经反向可检索性审计确认"能从公开源反查到结局"的现代命例——移出计分池(否则有源语料的攻击者可白捡分)
    const isDiag = (r) => r.control === true || r.origin === 'guji' || r.origin === 'nianpu' || r.secondhand === true || r.findable === true;
    const preds = {}, hits = {}, ctrlHits = {}, diagHits = {};
    for (const r of set.records) {
      const a = answers[r.id];
      if (!a) continue;
      let letter = typeof a === 'string' ? a : a.answer;
      const L = r.options.map(o => o.trim().charAt(0));
      if (!set.goldPublic && appId) { // 显示空间→原始空间逆映射
        const perm = optionPermutation(appId, setId, r.id, r.options.length);
        const d = 'ABCDE'.indexOf(letter);
        if (d < 0 || d >= perm.length) continue;
        letter = 'ABCDE'[perm[d]];
      }
      if (!L.includes(letter)) continue;
      const conf = typeof a === 'object' && a.confidence ? Math.min(0.99, Math.max(1 / L.length, a.confidence)) : 0.6;
      const rest = (1 - conf) / (L.length - 1);
      preds[r.id] = { ranked: [letter, ...L.filter(x => x !== letter)], probs: Object.fromEntries(L.map(x => [x, x === letter ? conf : rest])) };
      const hit = letter === r.answer ? 1 : 0;
      // 三个互斥池:对照(随机金标)/诊断(古籍,真金标但太典型)/计分(年谱+现代)
      if (isCtrl(r)) ctrlHits[r.id] = hit;
      else if (isDiag(r)) diagHits[r.id] = hit;
      else hits[r.id] = hit;
    }
    const scored = set.records.filter(r => !isDiag(r)); // 计分池=年谱+现代(排除对照与古籍)
    const controls = set.records.filter(isCtrl);
    const scoreableN = scored.length;
    const answeredN = scored.filter(r => preds[r.id]).length;
    const correct = Object.values(hits).reduce((a, b) => a + b, 0);
    const officialTop1 = scoreableN ? correct / scoreableN : 0; // 全集口径：缺答记错（防一题攻击）
    const coverage = set.records.length ? Object.keys(preds).length / set.records.length : 0; // 覆盖率含对照题：跳题不入榜
    const agg = aggregate(scored, preds, { k: this.k }); // 条件口径(仅已答)，满覆盖时与全集一致
    const ci = bootstrapCI(scored, preds, { seed: 42 });
    const metrics = { top1: officialTop1, conditionalTop1: agg.top1, [`top${this.k}`]: agg[`top${this.k}`], brier: agg.brier, ece: agg.ece, ci95: ci, coverage, answeredN, scoreableN };
    if (controls.length) {
      const cCorrect = Object.values(ctrlHits).reduce((a, b) => a + b, 0);
      const cChance = controls.reduce((a, r) => a + 1 / r.options.length, 0) / controls.length;
      const cAnswered = controls.filter(r => preds[r.id]);
      const meanTopConf = cAnswered.length ? cAnswered.reduce((a, r) => a + (preds[r.id].probs[preds[r.id].ranked[0]] || 0), 0) / cAnswered.length : null;
      metrics.control = { n: controls.length, top1: cCorrect / controls.length, chance: cChance, mean_top_conf: meanTopConf };
    }
    // 来源切片（诊断用）：古籍/二手切片显著高于自发年谱/现代切片=背原书或转录污染指纹。
    //    诊断切片不计排名分但仍统计——"测谎仪"：读得出污染行为，却不让它抬高排名。
    //    切片键：二手转录单列 'secondhand'（不论其 origin），其余按 origin。
    const allHit = { ...hits, ...diagHits };
    const sliceRecs = set.records.filter(r => !isCtrl(r)); // 年谱+现代+古籍(含二手)
    const sliceKey = (r) => r.findable ? 'findable' : (r.secondhand ? 'secondhand' : r.origin);
    const isDiagSlice = (k) => k === 'guji' || k === 'secondhand' || k === 'nianpu' || k === 'findable';
    const keys = [...new Set(sliceRecs.map(sliceKey).filter(Boolean))];
    if (keys.length > 1) {
      metrics.slices = {};
      for (const k of keys) {
        const rs = sliceRecs.filter(r => sliceKey(r) === k);
        const answered = rs.filter(r => r.id in allHit);
        metrics.slices[k] = {
          n: rs.length, answered: answered.length,
          top1: answered.length ? answered.reduce((a, r) => a + allHit[r.id], 0) / answered.length : 0,
          diagnostic: isDiagSlice(k) || undefined, // 标记:不计入排名分
        };
      }
    }
    return { metrics, hits, coverage };
  }

  // 🆕 榜单读取时按【当前】计分池定义重算：提交时存的 result.top1 用的是"提交当日"的池定义，
  //   池定义变过(如年谱从计分池移入诊断池)后，旧提交口径会与新提交不一致(旧的把年谱算进了分子分母)。
  //   用 _score 对存下的 answersRaw 重跑，全榜永远同一口径、自愈未来的池调整。answersRaw 缺失/异常则回退存档。
  _rescore(s) {
    try {
      if (s.answersRaw && this.sets[s.setId]) {
        const ans = typeof s.answersRaw === 'string' ? JSON.parse(s.answersRaw) : s.answersRaw;
        const { metrics, hits } = this._score(s.setId, ans, s.appId);
        return { top1: metrics.top1, hits, coverage: metrics.coverage, ci95: metrics.ci95, brier: metrics.brier, ece: metrics.ece, top2: metrics[`top${this.k}`] };
      }
    } catch (e) { console.warn(`[leaderboard] rescore fallback ${s.taskId}: ${e.message}`); }
    const r = s.result || {};
    return { top1: r.top1, hits: s.hits || {}, coverage: r.coverage, ci95: r.ci95, brier: r.brier, ece: r.ece, top2: r[`top${this.k}`] };
  }

  _record(app, setId, mode, answers, extra = {}) {
    const set = this.sets[setId];
    const quota = set.official ? 1 : this.quotaPerSet; // 擂台每家仅一次正式作答:一次定分,杜绝反复交把分数当oracle刷
    const mine = Object.values(this.subs).filter(s => s.appId === app.appId && s.setId === setId);
    if (mine.length >= quota) throw this.err(429, `quota exceeded (${quota}/set)`);
    const { metrics, hits, coverage } = this._score(setId, answers, app.appId);
    const admitted = coverage >= 1; // 满覆盖才入榜；否则缺答记错且不进榜
    // 🆕 防刷监控：满覆盖且 top1 逼近满分（公开集答案已在网上，>45% 高度可疑=可能直接扒答案刷分）
    if (admitted && metrics.top1 > ALERT_THRESH) {
      console.warn(`[BENCH ALERT] suspicious high score: app=${app.appId}(${this.apps[app.appId]?.name || ''}) set=${setId} top1=${(metrics.top1 * 100).toFixed(1)}% — 疑似扒公开答案刷分，请人工核查`);
      this.audit(app.appId, 'suspicious_high_score', { setId, top1: metrics.top1, threshold: ALERT_THRESH });
    }
    // 🆕 对照题报警：随机金标上显著超机会水平(>2SE)=泄漏/出题指纹,与算力命理水平无关
    const ctrl = metrics.control;
    if (admitted && ctrl && ctrl.n >= 10) {
      const se = Math.sqrt(ctrl.chance * (1 - ctrl.chance) / ctrl.n);
      if (ctrl.top1 > ctrl.chance + 2 * se) {
        console.warn(`[BENCH ALERT] control slice above chance: app=${app.appId}(${this.apps[app.appId]?.name || ''}) set=${setId} control_top1=${(ctrl.top1 * 100).toFixed(1)}% chance=${(ctrl.chance * 100).toFixed(1)}% n=${ctrl.n} — 对照题金标为随机指定,超2SE即疑泄漏,请人工核查`);
        this.audit(app.appId, 'control_above_chance', { setId, controlTop1: ctrl.top1, chance: ctrl.chance, n: ctrl.n });
      }
    }
    return {
      taskId: 'task_' + crypto.randomBytes(8).toString('hex'), appId: app.appId, setId, mode, status: 'done', admitted,
      track: 'online', meta: { model: String(extra.model || '').slice(0, 80) },
      result: metrics, hits, dupHash: extra.dupHash, submittedAt: new Date().toISOString(),
    };
  }

  _publicView(task) {
    const set = this.sets[task.setId];
    const reveal = set.revealResults || this.revealed.has(task.setId); // 私有官方集赛后才揭晓精确
    if (reveal) { const { hits, dupHash, ...pub } = task; return pub; }
    // 官方私有集未揭晓：绝不回任何分数信息（连粗粒度桶也不回），只回是否受理/是否满覆盖，彻底断掉逐题探分
    return { taskId: task.taskId, setId: task.setId, status: task.status, admitted: task.admitted, mode: task.mode, submittedAt: task.submittedAt,
      note: task.admitted ? '已受理，正式成绩与名次赛后统一揭晓' : '覆盖不足100%，本次不入榜（缺答按错计）' };
  }

  /** 离线答案提交 */
  submitAnswers(apiKey, { set_id, dataset_version, answers, meta = {} }, client = null) {
    const app = this.auth(apiKey);
    const set = this.sets[set_id];
    if (!set) throw this.err(404, 'unknown set');
    if (dataset_version !== this.datasetVersion) throw this.err(409, `dataset_version mismatch: server=${this.datasetVersion}`);
    if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) throw this.err(400, 'answers required');
    // 🆕 硬性推理链闸(默认开)：每题须附 reasoning(≥10字)才收——无推理链不入榜。在扣正式作答次数/入库前拦截，
    //   退回让补齐重交(不消耗官方集"一次定分")。兼作源匹配防线:粘现成答案的答不出逐题命理依据。
    const _av = Object.values(answers);
    const reasonedFrac = _av.length ? _av.filter(a => a && typeof a === 'object' && typeof a.reasoning === 'string' && a.reasoning.trim().length >= 10).length / _av.length : 0;
    if (this.requireReasoning && set.official && reasonedFrac < REASON_MIN) { // 仅官方擂台强制；public_test 练习集不拦
      throw this.err(400, `无推理链不入榜：answers 每项须为 {answer:'A', reasoning:'作答依据(≥10字)'}；当前仅 ${(reasonedFrac * 100).toFixed(0)}% 附推理(需≥${(REASON_MIN * 100).toFixed(0)}%)。补齐后重交，未消耗正式作答次数。`);
    }
    // 擂台集交卷时窗：须先领题，且在窗口内交卷（防"领题占坑无限拖"）。持续复测友好：交卷后清 paperAt，
    //   下一轮复测重新领题→重新计时。答案不可查，窗口非防泄漏，只防占坑。
    if (set.official) {
      const pa = app.paperAt?.[set_id];
      if (!pa) throw this.err(409, 'official set requires fetching the exam paper first (GET /v1/papers/private)');
      if (Date.now() - Date.parse(pa) > PAPER_WINDOW_MS) throw this.err(409, `submission window expired: fetch the paper again to re-measure (must submit within ${PAPER_WINDOW_MS / 3600_000}h of paper fetch)`);
    }
    const dupHash = sha(app.appId + set_id + JSON.stringify(answers));
    if (Object.values(this.subs).some(s => s.appId === app.appId && s.setId === set_id && s.dupHash === dupHash)) throw this.err(409, 'duplicate submission');
    const task = this._record(app, set_id, 'offline_file', answers, { model: meta.model, dupHash });
    task.track = meta.uses_network ? 'online' : app.track; // 离线文件模式本身无网络行为，信任自报
    const fp = clientFp(client);
    if (fp) task.fp = fp;
    task.answersRaw = answers; // 显示空间原始作答留存(服务端私有):字母级事后取证用,可经optionPermutation逆映射复原
    // 🆕 file 提交监督性证据：领题→交卷用时 + 推理链留存比例。offline_file 本质"未监督"(服务端未观测作答过程)，
    //   这些字段供榜单标注与事后取证：用时畸短=没真答、无推理链=无法复核，都是可疑信号。
    const paMs = app.paperAt?.[set_id] ? Date.parse(app.paperAt[set_id]) : null;
    if (paMs) { task.solveSeconds = Math.max(0, Math.round((Date.parse(task.submittedAt) - paMs) / 1000)); task.paperAt = app.paperAt[set_id]; }
    task.reasonedFrac = Math.round(reasonedFrac * 100) / 100; // 带非空reasoning的答案占比(裸字母=0，见上方推理链闸)
    if (task.solveSeconds != null && _av.length) task.secPerQ = Math.round((task.solveSeconds / _av.length) * 10) / 10;
    this.subs[task.taskId] = task; this._persistSub(task.taskId);
    this.audit(app.appId, 'submit_answers', { set_id, taskId: task.taskId, admitted: task.admitted, track: task.track, fp, ip: client?.ip, ua: client?.ua });
    return { task_id: task.taskId, status: task.status, ...this._publicView(task) };
  }

  /** 托管endpoint：异步后台拉取评分（立即返回running）；强制online；SSRF/DoS加固 */
  async submitEndpoint(apiKey, { set_id, dataset_version, endpoint_url, meta = {} }, { fetchImpl = fetch, batchSize = 10, timeoutMs = 30000 } = {}) {
    const app = this.auth(apiKey);
    if (this.disableHostedEndpoint) throw this.err(403, 'hosted endpoint mode disabled; use offline answer-file submission (POST /v1/submissions)');
    const set = this.sets[set_id];
    if (!set) throw this.err(404, 'unknown set');
    if (dataset_version !== this.datasetVersion) throw this.err(409, `dataset_version mismatch: server=${this.datasetVersion}`);
    let u;
    try { u = new URL(endpoint_url); } catch { throw this.err(400, 'invalid endpoint_url'); }
    if (this.allowPrivateEndpoints) { if (!/^https?:$/.test(u.protocol)) throw this.err(400, 'endpoint must be http(s)'); }
    else { if (u.protocol !== 'https:') throw this.err(400, 'endpoint must be https (明文传输可能泄漏私有题面)'); await assertPublicHost(u.hostname); }
    const quota = set.official ? 1 : this.quotaPerSet;
    if (Object.values(this.subs).filter(s => s.appId === app.appId && s.setId === set_id).length >= quota) throw this.err(429, `quota exceeded (${quota}/set)`);
    const taskId = 'task_' + crypto.randomBytes(8).toString('hex');
    const task = { taskId, appId: app.appId, setId: set_id, status: 'running', mode: 'hosted_endpoint', endpoint: endpoint_url, track: 'online', meta: { model: String(meta.model || '').slice(0, 80) }, submittedAt: new Date().toISOString() };
    this.subs[taskId] = task; this._persistSub(taskId);
    this.audit(app.appId, 'submit_endpoint', { set_id, taskId, endpoint: endpoint_url });
    // 异步后台评分，不阻塞请求（防同步等待拖垮服务）
    const bg = this._runEndpoint(task, app, set_id, u, { fetchImpl, batchSize, timeoutMs });
    this._pending = (this._pending || Promise.resolve()).then(() => bg).catch(() => {});
    return { task_id: taskId, status: 'running' };
  }

  async _runEndpoint(task, app, set_id, u, { fetchImpl, batchSize, timeoutMs }) {
    const set = this.sets[set_id];
    const pub = set.records.map(r => this._publicRecord(app.appId, set_id, set, r));
    const callOnce = async (batch) => {
      if (!this.allowPrivateEndpoints) await assertPublicHost(u.hostname); // 逐批复查，抗 DNS rebinding
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(task.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset_version: this.datasetVersion, records: batch }), signal: ctrl.signal, redirect: 'error' });
        if (!resp.ok) throw new Error(`endpoint ${resp.status}`);
        if (Number(resp.headers.get('content-length') || 0) > MAX_ENDPOINT_BYTES) throw new Error('endpoint response too large');
        const txt = await resp.text();
        if (txt.length > MAX_ENDPOINT_BYTES) throw new Error('endpoint response too large');
        return JSON.parse(txt);
      } finally { clearTimeout(t); }
    };
    const answers = {};
    try {
      for (let i = 0; i < pub.length; i += batchSize) {
        const batch = pub.slice(i, i + batchSize);
        let got;
        try { got = await callOnce(batch); } catch { got = await callOnce(batch); } // 单次重试
        for (const [id, a] of Object.entries(got.answers || {})) answers[id] = a;
      }
      const scored = this._record(app, set_id, 'hosted_endpoint', answers, { model: task.meta.model });
      Object.assign(task, { status: 'done', admitted: scored.admitted, result: scored.result, hits: scored.hits, dupHash: sha(app.appId + set_id + JSON.stringify(answers)) });
    } catch (e) { task.status = 'failed'; task.error = String(e.message).slice(0, 200); }
    this._persistSub(task.taskId);
  }

  getTask(apiKey, taskId) {
    const app = this.auth(apiKey);
    const t = this.subs[taskId];
    if (!t || t.appId !== app.appId) throw this.err(404, 'task not found');
    if (t.status !== 'done') { const { hits, dupHash, ...pub } = t; return pub; }
    return this._publicView(t);
  }

  /** 官方私有集赛后揭晓（本地参考用；生产走赛程控制） */
  revealSet(setId) { this.revealed.add(setId); if (this.store) this.store.putRevealed([...this.revealed]); return { set_id: setId, revealed: true }; }

  leaderboard(setId) {
    const set = this.sets[setId];
    const subjectById = {};
    if (set) for (const r of set.records) subjectById[r.id] = r.subject_id;
    const reveal = set ? (set.revealResults || this.revealed.has(setId)) : false;
    // 只收满覆盖入榜的完成态提交
    const doneAll = Object.values(this.subs).filter(s => s.setId === setId && s.status === 'done' && s.admitted && s.result?.scoreableN);
    // 🆕 硬性推理链：无推理链(reasonedFrac<REASON_MIN)不入榜——历史裸字母提交据此隐藏(env BENCH_REQUIRE_REASONING=0 可关)
    const done = (this.requireReasoning && set?.official) ? doneAll.filter(s => (s.reasonedFrac ?? 0) >= REASON_MIN) : doneAll; // 仅官方擂台按推理链过滤
    const hiddenNoReasoning = doneAll.length - done.length;
    // 未揭晓的集（官方私有集）：绝不泄露任何逐条信息（分数/桶/名次/p值），只回收到的提交数
    if (set && !reveal) {
      return { set_id: setId, dataset_version: this.datasetVersion, official: set.official || false, results_revealed: false,
        submissions_count: doneAll.length, note: '官方私有集，成绩与名次赛后统一揭晓；期间不返回任何逐条结果' };
    }
    // 🆕 展示全部满覆盖提交（不按应用去重）：让大家看到每个项目的测试/迭代次数=擂台活跃度，哪怕重名也都列。
    // 单应用提交次数已由 quotaPerSet 限制，不会被单人刷屏。
    // 全榜(跨赛道)统一按 top1 排一次：p_vs_top 一律对"全榜第一"，避免前端合并展示时出现两个"—"、
    // 及联网项误对联网内部第一（同一批题、同一命主，配对检验跨赛道机械上成立）
    // 🆕 每条提交按当前计分池定义实时重算(见 _rescore)，避免不同日期提交口径不一(如年谱曾计分后移入诊断)
    const sc = new Map(done.map(s => [s.taskId, this._rescore(s)]));
    const rows = done
      .map(s => ({ _task: s, app: this.apps[s.appId]?.name || s.appId, track: s.track, model: s.meta?.model || '', top1: sc.get(s.taskId).top1, coverage: sc.get(s.taskId).coverage, submittedAt: s.submittedAt }))
      .sort((a, b) => b.top1 - a.top1);
    const allHits = rows.map(r => sc.get(r._task.taskId).hits || {}); // 重算后的 hits(仅当前计分池)，供配对检验
    // 🆕 疑似标注（规则公开透明）：①同源多应用=同一客户端指纹(加盐哈希IP+UA)下≥2个应用上榜(马甲);
    //    ②短时跃升=同源(或同应用)一小时内成绩跃升≥15pp(疑似以即时分数为oracle迭代刷分);③人工标注(运营审计留痕)。
    //    指纹自2026-07-14起采集,此前的历史提交无指纹、只做同应用内比较——不冤枉也不漏当下。
    const groupOf = (s) => s.fp || this.apps[s.appId]?.regFp || `app:${s.appId}`;
    const groups = new Map();
    for (const s of done) { const k = groupOf(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const autoFlags = new Map();
    for (const [k, list] of groups) {
      const multiApp = !String(k).startsWith('app:') && new Set(list.map(s => s.appId)).size >= 2;
      const sorted = [...list].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
      sorted.forEach((s, i) => {
        const fl = [];
        if (multiApp) fl.push('同源多应用');
        for (let j = 0; j < i; j++) {
          if (Date.parse(s.submittedAt) - Date.parse(sorted[j].submittedAt) <= 3600_000 && sc.get(s.taskId).top1 - sc.get(sorted[j].taskId).top1 >= 0.15) { fl.push('短时跃升≥15pp/小时'); break; }
        }
        if (fl.length) autoFlags.set(s.taskId, fl);
      });
    }
    const ranked = rows.map((r, i) => {
      const flags = [...(autoFlags.get(r._task.taskId) || []), ...(this.apps[r._task.appId]?.flag ? [`人工标注:${this.apps[r._task.appId].flag}`] : [])];
      const m = sc.get(r._task.taskId);
      return {
        rank: i + 1, app: r.app, track: r.track, model: r.model, coverage: r.coverage, submittedAt: r.submittedAt,
        // 🆕 监督性：offline_file=未监督(服务端未观测作答)；hosted_endpoint=监督(服务端驱动问答)
        supervised: r._task.mode === 'hosted_endpoint', mode: r._task.mode,
        solveSeconds: r._task.solveSeconds ?? null, secPerQ: r._task.secPerQ ?? null, reasonedFrac: r._task.reasonedFrac ?? null,
        top1: r.top1, [`top${this.k}`]: m.top2, brier: m.brier, ece: m.ece, ci95: m.ci95,
        p_vs_top: i === 0 ? null : pairedPermHits(allHits[0], allHits[i], subjectById),   // 对全榜第一
        p_vs_prev: i === 0 ? null : pairedPermHits(allHits[i - 1], allHits[i], subjectById), // 对全榜上一名
        ...(flags.length ? { flags } : {}),
      };
    });
    // 仍按赛道分组返回(前端合并后按 top1 重排，顺序与此一致；p 已是全榜口径)
    const byTrack = { online: ranked.filter(r => r.track === 'online'), offline: ranked.filter(r => r.track !== 'online') };
    return {
      set_id: setId, dataset_version: this.datasetVersion, official: set?.official || false, results_revealed: reveal,
      note: '仅满100%覆盖的提交入榜(缺答按错)；同一系统的多次提交均展示（可见测试/迭代次数）；p_vs_top/p_vs_prev为命主聚类配对置换检验(对全榜)，p≥0.05即与对照无显著差异，勿据点估计定高下',
      require_reasoning: this.requireReasoning, // 是否硬性要求推理链
      hidden_no_reasoning: hiddenNoReasoning,   // 因无推理链被隐藏的历史提交数(需附逐题 reasoning 重交)
      ranked, // 全榜合并已按 top1 排序：rank/p_vs_top(对榜首)/p_vs_prev 均按此序算。前端应直接按此序渲染，
              // 不要再拿 tracks 二次排序——否则并列时显示序与算 p 的序错位，榜首的"—"会挂到别人头上。
      tracks: byTrack,
    };
  }
}
