/** Firestore 存储适配（云端用；本地测试仍走文件态，不加载本文件）
 *  apps/subs 各存为集合中一文档一记录（避免单文档 1MB 上限）；写入串行化 + 出错记日志。
 *  与 max-instances=1 搭配：内存态为准，Firestore 做重启/重部署后的持久化。
 */
import { Firestore } from '@google-cloud/firestore';

export class FirestoreStore {
  constructor({ projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT, prefix = 'bench_' } = {}) {
    this.db = new Firestore({ projectId });
    this.appsCol = `${prefix}apps`;
    this.subsCol = `${prefix}subs`;
    this.metaRef = this.db.collection(`${prefix}meta`).doc('state');
    this._queue = Promise.resolve(); // 串行化写入，避免并发覆盖
  }

  async loadAll() {
    const [appsSnap, subsSnap, meta] = await Promise.all([
      this.db.collection(this.appsCol).get(),
      this.db.collection(this.subsCol).get(),
      this.metaRef.get(),
    ]);
    const apps = {}, subs = {};
    appsSnap.forEach(d => { apps[d.id] = d.data(); });
    subsSnap.forEach(d => { subs[d.id] = d.data(); });
    const revealed = meta.exists ? (meta.data().revealed || []) : [];
    return { apps, subs, revealed };
  }

  _q(fn) { this._queue = this._queue.then(fn).catch(e => console.error('[bench-store] write failed:', e.message)); }
  // JSON 往返：剥掉 undefined / Set 等 Firestore 不接受的值
  _clean(o) { return JSON.parse(JSON.stringify(o)); }

  putApp(id, app) { this._q(() => this.db.collection(this.appsCol).doc(id).set(this._clean(app))); }
  putSub(id, sub) { this._q(() => this.db.collection(this.subsCol).doc(id).set(this._clean(sub))); }
  putRevealed(arr) { this._q(() => this.metaRef.set({ revealed: arr }, { merge: true })); }
  async flush() { await this._queue; } // 优雅关停时可等待写完
}
