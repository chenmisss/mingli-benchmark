/**
 * 擂台防刷监控：扫描 bench_subs，列出满覆盖且 top1 超阈值(默认 45%)的可疑提交。
 * public_test 答案已在网上，>45% 高度可疑（可能直接扒公开答案刷分）→ 人工核查。
 * 用法: node monitor-suspicious.mjs            # 默认阈值 0.45
 *       THRESH=0.5 node monitor-suspicious.mjs
 * 退出码: 0=无异常  2=发现可疑（方便 launchd/cron 触发通知）
 */
import { Firestore } from '@google-cloud/firestore';

const THRESH = Number(process.env.THRESH || 0.45);
const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0258832136' });

const apps = {};
(await db.collection('bench_apps').get()).forEach(d => { const a = d.data(); apps[a.appId] = a.name; });

const subs = await db.collection('bench_subs').get();
const flagged = [];
subs.forEach(d => {
  const s = d.data();
  if (s.status === 'done' && s.admitted && (s.result?.top1 ?? 0) > THRESH) {
    flagged.push({ app: apps[s.appId] || s.appId, appId: s.appId, top1: s.result.top1, set: s.setId, at: s.submittedAt || '' });
  }
});
flagged.sort((a, b) => b.top1 - a.top1);

if (flagged.length) {
  console.log(`⚠️  [BENCH ALERT] ${flagged.length} 条可疑高分（top1 > ${(THRESH * 100).toFixed(0)}%，疑似扒公开答案刷分）：`);
  for (const f of flagged) console.log(`   ${(f.top1 * 100).toFixed(1)}%  ${f.app}  [${f.set}]  ${String(f.at).slice(0, 16)}  (app=${f.appId})`);
  process.exit(2);
} else {
  console.log(`✓ 无 top1 > ${(THRESH * 100).toFixed(0)}% 的可疑提交（共扫描 ${subs.size} 条提交）`);
  process.exit(0);
}
