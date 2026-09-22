import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { HttpError, parseBody } from '../lib/http.js';
import { evaluateCrack } from '../services/evaluate.js';
import { insertCrack } from './cracks.js';

/**
 * 巡检影像汇聚入口。
 *
 * 一张影像可携带多条裂缝识别结果（detections）：
 *  - crack_id 已存在 → 追加一条 source='image' 的宽度观测；
 *  - new_crack → 现场新发现，先建裂缝档案再写观测。
 * 全部写入在一个事务里；完成后立即对受影响裂缝做趋势评估，
 * 超限/预警的当场生成复核任务——这就是「汇聚 → 识别 → 派发」的主链路。
 */
const detectionSchema = z.object({
  crack_id: z.number().int().optional(),
  new_crack: z
    .object({
      crack_type: z.enum(['longitudinal', 'transverse', 'circumferential', 'oblique', 'map']),
      location_desc: z.string().optional(),
    })
    .optional(),
  width_mm: z.number().nonnegative(),
  polygon: z.array(z.tuple([z.number(), z.number()])).optional(),
  length_m: z.number().positive().optional(),
});

const imageSchema = z.object({
  segment_id: z.number().int(),
  uri: z.string().min(1),
  taken_at: z.string(),
  inspector: z.string().optional(),
  detections: z.array(detectionSchema).default([]),
});

export function imagesRouter(db: DB): Router {
  const r = Router();

  r.post('/', (req, res) => {
    const body = parseBody(imageSchema, req.body);
    if (!db.prepare(`SELECT id FROM segments WHERE id = ?`).get(body.segment_id)) {
      throw new HttpError(404, 'NOT_FOUND', `段落 ${body.segment_id} 不存在`);
    }
    for (const d of body.detections) {
      if (!d.crack_id && !d.new_crack) {
        throw new HttpError(400, 'VALIDATION', '每条识别结果必须带 crack_id 或 new_crack');
      }
      if (d.crack_id && !db.prepare(`SELECT id FROM cracks WHERE id = ?`).get(d.crack_id)) {
        throw new HttpError(404, 'NOT_FOUND', `裂缝 ${d.crack_id} 不存在`);
      }
    }

    const now = nowIso();
    const run = db.transaction(() => {
      const imageId = Number(
        db.prepare(`INSERT INTO images (segment_id, uri, taken_at, inspector, created_at) VALUES (?,?,?,?,?)`)
          .run(body.segment_id, body.uri, body.taken_at, body.inspector ?? null, now).lastInsertRowid,
      );
      const detections = body.detections.map((d) => {
        const crackId =
          d.crack_id ??
          insertCrack(db, body.segment_id, d.new_crack!.crack_type, d.new_crack!.location_desc ?? null, body.taken_at);
        const obsId = Number(
          db.prepare(
            `INSERT INTO observations (crack_id, observed_at, width_mm, source, image_id, polygon, length_m, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(crackId, body.taken_at, d.width_mm, 'image', imageId,
            d.polygon ? JSON.stringify(d.polygon) : null, d.length_m ?? null, now).lastInsertRowid,
        );
        return { observation_id: obsId, crack_id: crackId, created_crack: !d.crack_id };
      });
      return { imageId, detections };
    });
    const { imageId, detections } = run();

    // 事件驱动评估：受影响的裂缝各跑一次（去重）
    const evaluations = [...new Set(detections.map((d) => d.crack_id))].map((cid) =>
      evaluateCrack(db, cid),
    );
    res.status(201).json({ image_id: imageId, detections, evaluations });
  });

  r.get('/', (req, res) => {
    const cond = req.query.segment_id ? `WHERE i.segment_id = ${Number(req.query.segment_id)}` : '';
    res.json(
      db
        .prepare(
          `SELECT i.*, (SELECT COUNT(*) FROM observations o WHERE o.image_id = i.id) AS detection_count
           FROM images i ${cond} ORDER BY i.taken_at DESC`,
        )
        .all(),
    );
  });

  return r;
}
