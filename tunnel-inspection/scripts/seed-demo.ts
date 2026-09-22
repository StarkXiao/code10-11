/**
 * 演示数据：一条隧道、6 个段落、6 条形态各异的裂缝（含 12 个月测缝计历史读数），
 * 灌入后执行一次全量评估，直观看到「汇聚 → 识别 → 派发」的结果。
 *
 * 用法：npm run seed   （会清空业务表重来，幂等）
 */
import { openDb } from '../src/db.js';
import { evaluateAll } from '../src/services/evaluate.js';

const db = openDb();
const NOW = Date.now();
const MONTH = 30.4375 * 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// 确定性噪声，让曲线像真数据
const noise = (i: number) => Math.sin(i * 12.9898) * 0.004;

db.transaction(() => {
  for (const t of ['observations', 'review_tasks', 'alerts', 'gauges', 'images', 'cracks', 'segments', 'tunnels']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }

  db.prepare(`INSERT INTO tunnels (code, name, line, created_at) VALUES ('QYL', '青云岭隧道', 'G85 下行线', ?)`).run(iso(400 * 86_400_000));
  const seg = (code: string, start: number, team: string) =>
    Number(
      db.prepare(
        `INSERT INTO segments (tunnel_id, code, start_chainage_m, end_chainage_m, responsible_team, created_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      ).run(code, start, start + 100, team, iso(400 * 86_400_000)).lastInsertRowid,
    );
  const segments = [
    seg('QYL-K12+300~K12+400', 12300, '巡检一组'),
    seg('QYL-K12+400~K12+500', 12400, '巡检一组'),
    seg('QYL-K12+500~K12+600', 12500, '巡检二组'),
  ];

  const crack = (segmentId: number, type: string, loc: string) => {
    const id = Number(
      db.prepare(
        `INSERT INTO cracks (segment_id, code, crack_type, location_desc, discovered_at, created_at)
         VALUES (?, '', ?, ?, ?, ?)`,
      ).run(segmentId, type, loc, iso(380 * 86_400_000), iso(380 * 86_400_000)).lastInsertRowid,
    );
    db.prepare(`UPDATE cracks SET code = ? WHERE id = ?`).run(`CR-${String(id).padStart(5, '0')}`, id);
    return id;
  };

  const gauge = (crackId: number, code: string) =>
    Number(
      db.prepare(`INSERT INTO gauges (crack_id, code, installed_at) VALUES (?, ?, ?)`)
        .run(crackId, code, iso(370 * 86_400_000)).lastInsertRowid,
    );

  /** 按月灌历史读数：width = base + rate*i + noise */
  const feed = (gaugeId: number, crackId: number, base: number, rate: number, months: number) => {
    for (let i = months - 1; i >= 0; i--) {
      const w = Math.max(0.01, base + rate * (months - 1 - i) + noise(i));
      db.prepare(
        `INSERT INTO observations (crack_id, observed_at, width_mm, source, gauge_id, created_at)
         VALUES (?, ?, ?, 'gauge', ?, ?)`,
      ).run(crackId, iso(i * MONTH), Number(w.toFixed(3)), gaugeId, iso(i * MONTH));
    }
  };

  // CR-00001 稳定裂缝 → normal
  const c1 = crack(segments[0], 'longitudinal', '拱顶中线');
  feed(gauge(c1, 'CG-001'), c1, 0.08, 0.0005, 12);

  // CR-00002 缝宽接近限值 70% → watch
  const c2 = crack(segments[0], 'circumferential', '拱腰右侧');
  feed(gauge(c2, 'CG-002'), c2, 0.145, 0.001, 12);

  // CR-00003 按当前速率约 45 天后超限 → warning（窗口预警）
  const c3 = crack(segments[1], 'longitudinal', '左边墙腰部');
  feed(gauge(c3, 'CG-003'), c3, 0.1, 0.008, 12);

  // CR-00004 新装测缝计 3 个月，速率 0.06mm/月 → warning（速率预警）
  const c4 = crack(segments[1], 'oblique', '拱肩左侧');
  feed(gauge(c4, 'CG-004'), c4, 0.05, 0.06, 3);

  // CR-00005 已超限 → exceeded
  const c5 = crack(segments[2], 'transverse', '仰拱填充面');
  feed(gauge(c5, 'CG-005'), c5, 0.16, 0.01, 12);

  // CR-00006 只有 2 条人工量测 → insufficient_data
  const c6 = crack(segments[2], 'map', '右边墙网状');
  for (const [ago, w] of [[60, 0.1], [30, 0.11]] as const) {
    db.prepare(
      `INSERT INTO observations (crack_id, observed_at, width_mm, source, created_at) VALUES (?, ?, ?, 'manual', ?)`,
    ).run(c6, iso(ago * 86_400_000), w, iso(ago * 86_400_000));
  }

  // 一次巡检影像：识别出 CR-00005 的最新宽度 + 一条新裂缝
  const imgId = Number(
    db.prepare(`INSERT INTO images (segment_id, uri, taken_at, inspector, created_at) VALUES (?, ?, ?, '张工', ?)`)
      .run(segments[2], 'oss://insp/2026-09/QYL-K12+5xx.jpg', iso(2 * 86_400_000), iso(2 * 86_400_000)).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO observations (crack_id, observed_at, width_mm, source, image_id, polygon, created_at)
     VALUES (?, ?, 0.27, 'image', ?, '[[0.12,0.31],[0.44,0.78]]', ?)`,
  ).run(c5, iso(2 * 86_400_000), imgId, iso(2 * 86_400_000));
})();

const summary = evaluateAll(db);
console.log('演示数据已灌入并完成全量评估：\n');
console.log(`评估裂缝 ${summary.evaluated} 条，分级分布：`, summary.byLevel);
console.log(`新开预警 ${summary.newAlerts} 条，新派复核任务 ${summary.newTasks} 单\n`);

const rows = db.prepare(
  `SELECT c.code, c.last_level, s.code AS segment, a.level AS alert, t.priority, t.status, t.assignee, t.due_at
   FROM cracks c
   JOIN segments s ON s.id = c.segment_id
   LEFT JOIN alerts a ON a.crack_id = c.id AND a.status = 'open'
   LEFT JOIN review_tasks t ON t.crack_id = c.id AND t.status IN ('pending','accepted','in_progress')
   ORDER BY c.id`,
).all();
console.table(rows);
db.close();
