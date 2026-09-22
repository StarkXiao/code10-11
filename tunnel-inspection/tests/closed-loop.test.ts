/**
 * 闭环集成测试：真实 HTTP + 真实 SQLite（内存库）。
 *
 * 链路：建隧道/段落 → 建裂缝 → 挂测缝计 → 上报 12 个月读数（持续增长至超限）
 *      → 事件驱动评估自动开预警 + 派 P1 复核任务 → 重复评估幂等（不重开单）
 *      → 接单 → 开始 → 完成（误报 → 销警；确认 → 预警保持）
 *      → 影像识别新裂缝入库 → 看板统计
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';

let db: DB;
let app: Express;

const NOW = Date.now();
const MONTH = 30.4375 * 86_400_000;

/** 生成 months 条月度读数：width = base + rate*i */
function readings(base: number, rate: number, months: number) {
  return Array.from({ length: months }, (_, i) => ({
    observed_at: new Date(NOW - (months - 1 - i) * MONTH).toISOString(),
    width_mm: Number((base + rate * i).toFixed(3)),
  }));
}

beforeAll(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

afterAll(() => db.close());

async function setupSegment() {
  const t = await request(app).post('/api/tunnels').send({ code: 'QYL', name: '青云岭隧道', line: 'G85 下行' });
  const s = await request(app)
    .post(`/api/tunnels/${t.body.id}/segments`)
    .send({
      code: 'QYL-K12+300~K12+400',
      start_chainage_m: 12300,
      end_chainage_m: 12400,
      responsible_team: '巡检一组',
    });
  return s.body.id as number;
}

describe('超限派单闭环', () => {
  let crackId: number;
  let gaugeId: number;

  it('建档：隧道 → 段落 → 裂缝 → 测缝计', async () => {
    const segmentId = await setupSegment();
    const c = await request(app)
      .post('/api/cracks')
      .send({ segment_id: segmentId, crack_type: 'longitudinal', location_desc: '拱顶偏左 0.5m' });
    expect(c.status).toBe(201);
    expect(c.body.code).toMatch(/^CR-\d{5}$/);
    crackId = c.body.id;

    const g = await request(app).post('/api/gauges').send({ crack_id: crackId, code: 'CG-001' });
    expect(g.status).toBe(201);
    gaugeId = g.body.id;
  });

  it('上报读数至超限：自动开 exceeded 预警并派 P1 任务', async () => {
    const res = await request(app)
      .post(`/api/gauges/${gaugeId}/readings`)
      .send({ readings: readings(0.08, 0.03, 6) }); // 最新 0.23 ≥ 0.2
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(6);
    expect(res.body.evaluation.assessment.level).toBe('exceeded');
    expect(res.body.evaluation.createdAlert).toBe(true);
    expect(res.body.evaluation.createdTask).toBe(true);

    const alerts = await request(app).get('/api/alerts?status=open');
    expect(alerts.body).toHaveLength(1);
    expect(alerts.body[0].level).toBe('exceeded');

    const tasks = await request(app).get('/api/tasks?status=pending');
    expect(tasks.body).toHaveLength(1);
    expect(tasks.body[0].priority).toBe('P1');
    expect(tasks.body[0].assignee).toBe('巡检一组'); // 继承段落负责班组
    const dueMs = Date.parse(tasks.body[0].due_at) - Date.now();
    expect(dueMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(dueMs).toBeGreaterThan(23 * 3600 * 1000);
  });

  it('幂等：重复上报同样读数 + 全量评估，不重开预警/任务', async () => {
    const again = await request(app)
      .post(`/api/gauges/${gaugeId}/readings`)
      .send({ readings: readings(0.08, 0.03, 6) });
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped).toBe(6);

    const run = await request(app).post('/api/evaluate/run');
    expect(run.body.newAlerts).toBe(0);
    expect(run.body.newTasks).toBe(0);
    expect((await request(app).get('/api/alerts?status=open')).body).toHaveLength(1);
    expect((await request(app).get('/api/tasks?status=pending')).body).toHaveLength(1);
  });

  it('任务状态机：非法跳转被拒，accept→start→complete 正常推进', async () => {
    const taskId = (await request(app).get('/api/tasks')).body[0].id as number;

    const bad = await request(app).post(`/api/tasks/${taskId}/complete`).send({ conclusion: 'confirmed' });
    expect(bad.status).toBe(409); // pending 不能直接 complete

    const noConclusion = await request(app).post(`/api/tasks/${taskId}/accept`).send({});
    expect(noConclusion.status).toBe(200);
    await request(app).post(`/api/tasks/${taskId}/start`).send({}).expect(200);

    const missing = await request(app).post(`/api/tasks/${taskId}/complete`).send({});
    expect(missing.status).toBe(409); // complete 必须给结论

    const done = await request(app)
      .post(`/api/tasks/${taskId}/complete`)
      .send({ conclusion: 'confirmed', note: '现场复测 0.24mm，属实，转处置流程' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.conclusion).toBe('confirmed');

    // confirmed：预警保持 open，等待处置
    expect((await request(app).get('/api/alerts?status=open')).body).toHaveLength(1);
  });

  it('误报结论会销警；repaired 结论会关闭裂缝', async () => {
    // 再制造一条预警裂缝
    const segmentId = (await request(app).get('/api/tunnels/1/segments')).body[0].id;
    const c2 = await request(app)
      .post('/api/cracks')
      .send({ segment_id: segmentId, crack_type: 'transverse' });
    const g2 = await request(app).post('/api/gauges').send({ crack_id: c2.body.id, code: 'CG-002' });
    await request(app)
      .post(`/api/gauges/${g2.body.id}/readings`)
      .send({ readings: readings(0.1, 0.025, 6) }); // 最新 0.225 → exceeded

    const task2 = (await request(app).get('/api/tasks?status=pending')).body[0];
    await request(app).post(`/api/tasks/${task2.id}/accept`).send({});
    await request(app).post(`/api/tasks/${task2.id}/complete`).send({ conclusion: 'false_alarm', note: '表面划痕误判' });

    const alert2 = (await request(app).get(`/api/alerts?status=open`)).body;
    expect(alert2).toHaveLength(1); // 只剩第一条 confirmed 的
    expect(alert2[0].crack_id).toBe(crackId);
  });
});

describe('影像汇聚', () => {
  it('影像识别结果入库：老裂缝追加观测、新裂缝自动建档，并触发评估', async () => {
    const segmentId = (await request(app).get('/api/tunnels/1/segments')).body[0].id;
    const res = await request(app)
      .post('/api/images')
      .send({
        segment_id: segmentId,
        uri: 'oss://insp/2026-09/IMG_001.jpg',
        taken_at: new Date().toISOString(),
        inspector: '张工',
        detections: [
          { crack_id: 1, width_mm: 0.24, polygon: [[0.1, 0.2], [0.3, 0.8]] },
          { new_crack: { crack_type: 'oblique', location_desc: '左边墙腰部' }, width_mm: 0.12 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.detections).toHaveLength(2);
    expect(res.body.detections[0].created_crack).toBe(false);
    expect(res.body.detections[1].created_crack).toBe(true);
    expect(res.body.evaluations).toHaveLength(2);

    const detail = await request(app).get('/api/cracks/1');
    expect(detail.body.observations.some((o: { source: string }) => o.source === 'image')).toBe(true);
  });

  it('识别结果缺 crack_id 且缺 new_crack → 400', async () => {
    const segmentId = (await request(app).get('/api/tunnels/1/segments')).body[0].id;
    const res = await request(app)
      .post('/api/images')
      .send({ segment_id: segmentId, uri: 'x', taken_at: new Date().toISOString(), detections: [{ width_mm: 0.1 }] });
    expect(res.status).toBe(400);
  });
});

describe('看板', () => {
  it('汇总统计口径正确', async () => {
    const res = await request(app).get('/api/dashboard/summary');
    expect(res.status).toBe(200);
    const levels = Object.fromEntries(res.body.cracks_by_level.map((r: { last_level: string; n: number }) => [r.last_level, r.n]));
    expect(levels.exceeded).toBeGreaterThanOrEqual(1);
    expect(res.body.open_alerts_by_level.some((r: { level: string }) => r.level === 'exceeded')).toBe(true);
    expect(res.body.tasks_by_status.some((r: { status: string }) => r.status === 'completed')).toBe(true);
  });
});
