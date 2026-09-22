import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { HttpError, parseBody } from '../lib/http.js';
import { evaluateCrack } from '../services/evaluate.js';

const CRACK_TYPES = ['longitudinal', 'transverse', 'circumferential', 'oblique', 'map'] as const;

const crackSchema = z.object({
  segment_id: z.number().int(),
  crack_type: z.enum(CRACK_TYPES),
  location_desc: z.string().optional(),
  discovered_at: z.string().optional(),
});

export function cracksRouter(db: DB): Router {
  const r = Router();

  r.post('/', (req, res) => {
    const body = parseBody(crackSchema, req.body);
    if (!db.prepare(`SELECT id FROM segments WHERE id = ?`).get(body.segment_id)) {
      throw new HttpError(404, 'NOT_FOUND', `段落 ${body.segment_id} 不存在`);
    }
    const id = insertCrack(db, body.segment_id, body.crack_type, body.location_desc ?? null,
      body.discovered_at ?? nowIso());
    res.status(201).json(db.prepare(`SELECT * FROM cracks WHERE id = ?`).get(id));
  });

  r.get('/', (req, res) => {
    const cond: string[] = [`c.status = 'active'`];
    const args: unknown[] = [];
    if (req.query.segment_id) {
      cond.push('c.segment_id = ?');
      args.push(Number(req.query.segment_id));
    }
    if (req.query.level) {
      cond.push('c.last_level = ?');
      args.push(String(req.query.level));
    }
    res.json(
      db
        .prepare(
          `SELECT c.*, s.code AS segment_code, s.responsible_team
           FROM cracks c JOIN segments s ON s.id = c.segment_id
           WHERE ${cond.join(' AND ')} ORDER BY c.id`,
        )
        .all(...args),
    );
  });

  r.get('/:id', (req, res) => {
    const crack = db
      .prepare(
        `SELECT c.*, s.code AS segment_code, s.start_chainage_m, s.end_chainage_m, s.lining_type,
                s.responsible_team, t.name AS tunnel_name
         FROM cracks c
         JOIN segments s ON s.id = c.segment_id
         JOIN tunnels t ON t.id = s.tunnel_id
         WHERE c.id = ?`,
      )
      .get(Number(req.params.id));
    if (!crack) throw new HttpError(404, 'NOT_FOUND', '裂缝不存在');
    const crackId = Number(req.params.id);
    res.json({
      ...crack,
      observations: db
        .prepare(`SELECT * FROM observations WHERE crack_id = ? ORDER BY observed_at DESC LIMIT 50`)
        .all(crackId),
      open_alert: db.prepare(`SELECT * FROM alerts WHERE crack_id = ? AND status = 'open'`).get(crackId) ?? null,
      open_task: db
        .prepare(
          `SELECT * FROM review_tasks WHERE crack_id = ? AND status IN ('pending','accepted','in_progress')`,
        )
        .get(crackId) ?? null,
    });
  });

  /** 实时趋势评估（只计算、不落预警）；要触发预警/派单走 POST /api/cracks/:id/evaluate */
  r.get('/:id/trend', (req, res) => {
    res.json(evaluateCrack(db, mustExist(db, Number(req.params.id)), new Date()).assessment);
  });

  /** 事件驱动评估：新数据入库后调用，必要时开预警与复核任务 */
  r.post('/:id/evaluate', (req, res) => {
    res.json(evaluateCrack(db, mustExist(db, Number(req.params.id))));
  });

  return r;
}

function mustExist(db: DB, id: number): number {
  if (!db.prepare(`SELECT id FROM cracks WHERE id = ?`).get(id)) {
    throw new HttpError(404, 'NOT_FOUND', `裂缝 ${id} 不存在`);
  }
  return id;
}

/** 建裂缝并生成业务编号 CR-00001（先插后补编号，保证唯一且可读）。 */
export function insertCrack(
  db: DB,
  segmentId: number,
  crackType: string,
  locationDesc: string | null,
  discoveredAt: string,
): number {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO cracks (segment_id, code, crack_type, location_desc, discovered_at, created_at)
       VALUES (?, '', ?, ?, ?, ?)`,
    )
    .run(segmentId, crackType, locationDesc, discoveredAt, now);
  const id = Number(info.lastInsertRowid);
  db.prepare(`UPDATE cracks SET code = ? WHERE id = ?`).run(`CR-${String(id).padStart(5, '0')}`, id);
  return id;
}
