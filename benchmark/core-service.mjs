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

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
    origin: r.origin, control: r.control, // 私有集专用字段；主库无此字段时为undefined→JSON序列化自动省略,既有哈希不变
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
      public_dev: { records: this.records.filter(r => r.split === 'dev' && r.answer), goldPublic: true, revealResults: true, official: false, disclosure: '公开开发集，gold 可下载，仅供调参，不产生官方排名' },
      public_test: { records: this.records.filter(r => r.split === 'holdout' && r.answer), goldPublic: false, revealResults: true, official: false, disclosure: '题目与答案已随赛事(2024-2025)公开，答案非秘密故即时揭晓成绩，但仅供自查、不产生官方排名；正式排名须用 private 集' },
      private: { records: priv.filter(r => r.answer), goldPublic: false, revealResults: false, official: true, disclosure: '服务端私有未公开题集(2026.1批：明清年谱历史命例+古籍命例+少量校准对照题[随机金标,不计排名分])，官方排名唯一依据，成绩赛后揭晓；赛季内可能增补，增补即dataset_version升级' },
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

  registerApp({ name, track = 'offline', contact = '', regToken = '' } = {}) {
    if (!name || String(name).length < 2) throw this.err(400, 'name required');
    if (!['online', 'offline'].includes(track)) throw this.err(400, 'track must be online|offline');
    if (this.requireRegToken && regToken !== this.requireRegToken) throw this.err(403, 'valid registration token required');
    this.rateCheck('register'); // 注册也限速，抑制爆量注册
    const appId = 'app_' + crypto.randomBytes(6).toString('hex');
    const apiKey = 'bk_' + crypto.randomBytes(18).toString('hex');
    this.apps[appId] = { appId, keyHash: sha(apiKey), name: String(name).slice(0, 60), track, contact: String(contact).slice(0, 120), createdAt: new Date().toISOString() };
    this._persistApp(appId);
    this.audit(appId, 'register', { name, track });
    return { appId, apiKey, track, datasetVersion: this.datasetVersion }; // 明文 key 仅此一次返回
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

  /** 参赛方安全记录视图：剥答案与一切服务端元标注。origin/control 绝不可下发——对照题一旦可识别即失效 */
  _publicRecord(appId, setId, set, r) {
    const { answer, split, source, origin, control, ...pub } = r;
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
    const preds = {}, hits = {}, ctrlHits = {};
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
      (isCtrl(r) ? ctrlHits : hits)[r.id] = letter === r.answer ? 1 : 0;
    }
    const scored = set.records.filter(r => !isCtrl(r));
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
    // 来源切片（记录带origin才有）：污染指纹对比——古籍切片显著高于年谱切片=背原书嫌疑
    const origins = [...new Set(scored.map(r => r.origin).filter(Boolean))];
    if (origins.length > 1) {
      metrics.slices = {};
      for (const o of origins) {
        const rs = scored.filter(r => r.origin === o);
        metrics.slices[o] = { n: rs.length, top1: rs.length ? rs.reduce((a, r) => a + (hits[r.id] || 0), 0) / rs.length : 0 };
      }
    }
    return { metrics, hits, coverage };
  }

  _record(app, setId, mode, answers, extra = {}) {
    const set = this.sets[setId];
    const quota = set.official ? 1 : this.quotaPerSet; // 官方集只一次正式提交
    const mine = Object.values(this.subs).filter(s => s.appId === app.appId && s.setId === setId);
    if (mine.length >= quota) throw this.err(429, `quota exceeded (${quota}/set)`);
    const { metrics, hits, coverage } = this._score(setId, answers, app.appId);
    const admitted = coverage >= 1; // 满覆盖才入榜；否则缺答记错且不进榜
    // 🆕 防刷监控：满覆盖且 top1 逼近满分（公开集答案已在网上，>45% 高度可疑=可能直接扒答案刷分）
    if (admitted && metrics.top1 > 0.45) {
      console.warn(`[BENCH ALERT] suspicious high score: app=${app.appId}(${this.apps[app.appId]?.name || ''}) set=${setId} top1=${(metrics.top1 * 100).toFixed(1)}% — 疑似扒公开答案刷分，请人工核查`);
      this.audit(app.appId, 'suspicious_high_score', { setId, top1: metrics.top1, threshold: 0.45 });
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
  submitAnswers(apiKey, { set_id, dataset_version, answers, meta = {} }) {
    const app = this.auth(apiKey);
    const set = this.sets[set_id];
    if (!set) throw this.err(404, 'unknown set');
    if (dataset_version !== this.datasetVersion) throw this.err(409, `dataset_version mismatch: server=${this.datasetVersion}`);
    if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) throw this.err(400, 'answers required');
    const dupHash = sha(app.appId + set_id + JSON.stringify(answers));
    if (Object.values(this.subs).some(s => s.appId === app.appId && s.setId === set_id && s.dupHash === dupHash)) throw this.err(409, 'duplicate submission');
    const task = this._record(app, set_id, 'offline_file', answers, { model: meta.model, dupHash });
    task.track = meta.uses_network ? 'online' : app.track; // 离线文件模式本身无网络行为，信任自报
    this.subs[task.taskId] = task; this._persistSub(task.taskId);
    this.audit(app.appId, 'submit_answers', { set_id, taskId: task.taskId, admitted: task.admitted, track: task.track });
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
    const done = Object.values(this.subs).filter(s => s.setId === setId && s.status === 'done' && s.admitted && s.result?.scoreableN);
    // 未揭晓的集（官方私有集）：绝不泄露任何逐条信息（分数/桶/名次/p值），只回收到的提交数
    if (set && !reveal) {
      return { set_id: setId, dataset_version: this.datasetVersion, official: set.official || false, results_revealed: false,
        submissions_count: done.length, note: '官方私有集，成绩与名次赛后统一揭晓；期间不返回任何逐条结果' };
    }
    // 🆕 展示全部满覆盖提交（不按应用去重）：让大家看到每个项目的测试/迭代次数=擂台活跃度，哪怕重名也都列。
    // 单应用提交次数已由 quotaPerSet 限制，不会被单人刷屏。
    // 全榜(跨赛道)统一按 top1 排一次：p_vs_top 一律对"全榜第一"，避免前端合并展示时出现两个"—"、
    // 及联网项误对联网内部第一（同一批题、同一命主，配对检验跨赛道机械上成立）
    const rows = done
      .map(s => ({ _task: s, app: this.apps[s.appId]?.name || s.appId, track: s.track, model: s.meta?.model || '', top1: s.result.top1, coverage: s.result.coverage, submittedAt: s.submittedAt }))
      .sort((a, b) => b.top1 - a.top1);
    const allHits = rows.map(r => r._task.hits || {}); // 先提取，避免引用问题
    const ranked = rows.map((r, i) => ({
      rank: i + 1, app: r.app, track: r.track, model: r.model, coverage: r.coverage, submittedAt: r.submittedAt,
      top1: r.top1, [`top${this.k}`]: r._task.result[`top${this.k}`], brier: r._task.result.brier, ece: r._task.result.ece, ci95: r._task.result.ci95,
      p_vs_top: i === 0 ? null : pairedPermHits(allHits[0], allHits[i], subjectById),   // 对全榜第一
      p_vs_prev: i === 0 ? null : pairedPermHits(allHits[i - 1], allHits[i], subjectById), // 对全榜上一名
    }));
    // 仍按赛道分组返回(前端合并后按 top1 重排，顺序与此一致；p 已是全榜口径)
    const byTrack = { online: ranked.filter(r => r.track === 'online'), offline: ranked.filter(r => r.track !== 'online') };
    return {
      set_id: setId, dataset_version: this.datasetVersion, official: set?.official || false, results_revealed: reveal,
      note: '仅满100%覆盖的提交入榜(缺答按错)；同一系统的多次提交均展示（可见测试/迭代次数）；p_vs_top/p_vs_prev为命主聚类配对置换检验(对全榜)，p≥0.05即与对照无显著差异，勿据点估计定高下',
      tracks: byTrack,
    };
  }
}
