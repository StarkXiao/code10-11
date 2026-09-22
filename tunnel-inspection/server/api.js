import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeCrack, evaluateAlarms, dispatchTask, aggregateDaily } from './analysis.js';
import { synthReading, mulberry32 } from './seed.js';

const DAY = 86400000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

const fmtChainage = (m) => `K${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, '0')}`;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new HttpError(413, '请求体过大（>20MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

export function createServer(store, { publicDir }) {
  const db = () => store.db;
  const nextId = (p) => store.nextId(p);

  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) + '$',
    );
    routes.push({ method, regex, keys, handler });
  };

  const crackView = (c) => ({
    id: c.id,
    code: c.code,
    sectionId: c.sectionId,
    chainage: c.chainage,
    chainageLabel: fmtChainage(c.chainage),
    position: c.position,
    type: c.type,
    status: c.status,
    firstSeenAt: c.firstSeenAt,
    analysis: c.analysis,
  });

  const findCrack = (id) => {
    const c = db().cracks.find((x) => x.id === id || x.code === id);
    if (!c) throw new HttpError(404, `裂缝不存在：${id}`);
    return c;
  };

  // ---------- 总览 ----------
  add('GET', '/api/overview', () => {
    const d = db();
    const openAlarms = d.alarms.filter((a) => a.status !== '已闭环');
    const sectionHealth = d.sections.map((s) => {
      const cracks = d.cracks.filter((c) => c.sectionId === s.id);
      let level = 'none';
      const order = { none: 0, normal: 1, warning: 2, critical: 3 };
      for (const c of cracks) {
        const lv = c.analysis?.level || 'normal';
        if (order[lv] > order[level]) level = lv;
      }
      return { sectionId: s.id, code: fmtChainage(s.startM), level, crackCount: cracks.length };
    });
    const topGrowing = d.cracks
      .filter((c) => c.analysis && c.analysis.rate > 0)
      .sort((a, b) => b.analysis.rate - a.analysis.rate)
      .slice(0, 5)
      .map((c) => ({ id: c.id, code: c.code, chainageLabel: fmtChainage(c.chainage), position: c.position, rate: c.analysis.rate, level: c.analysis.level }));
    const todayStart = Math.floor(Date.now() / DAY) * DAY;
    return {
      tunnel: d.tunnels[0],
      counts: {
        sections: d.sections.length,
        cracks: d.cracks.length,
        monitoring: d.cracks.filter((c) => c.status === '监测中').length,
        gaugesOnline: d.gauges.filter((g) => g.status === '在线').length,
        alarmsOpen: openAlarms.length,
        alarmsCritical: openAlarms.filter((a) => a.level === 'critical').length,
        alarmsWarning: openAlarms.filter((a) => a.level === 'warning').length,
        tasksPending: d.tasks.filter((t) => t.status === '待复核').length,
        tasksDoing: d.tasks.filter((t) => t.status === '复核中').length,
        tasksDone: d.tasks.filter((t) => t.status === '已完成').length,
        readingsToday: d.readings.filter((r) => r.ts >= todayStart).length,
      },
      sectionHealth,
      topGrowing,
      recentAlarms: [...d.alarms].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6).map(alarmView),
    };
  });

  // ---------- 基础数据 ----------
  add('GET', '/api/tunnels', () => db().tunnels);
  add('GET', '/api/sections', () =>
    db().sections.map((s) => ({ ...s, code: fmtChainage(s.startM) })),
  );
  add('GET', '/api/config', () => db().config);

  add('PUT', '/api/config/thresholds', ({ body }) => {
    const t = body || {};
    const cur = db().config.thresholds;
    for (const k of ['widthWarn', 'widthAlarm', 'rateWarn', 'rateAlarm', 'accelAlarm', 'windowDays']) {
      if (t[k] !== undefined) {
        const v = Number(t[k]);
        if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, `阈值 ${k} 必须为正数`);
        cur[k] = v;
      }
    }
    if (cur.widthWarn >= cur.widthAlarm) throw new HttpError(400, '预警阈值必须小于超限阈值');
    const result = evaluateAlarms(db(), nextId);
    store.save();
    return { thresholds: cur, reevaluated: result };
  });

  // ---------- 裂缝 ----------
  add('GET', '/api/cracks', ({ query }) => {
    let list = db().cracks;
    if (query.sectionId) list = list.filter((c) => c.sectionId === query.sectionId);
    if (query.status) list = list.filter((c) => c.status === query.status);
    if (query.level) list = list.filter((c) => c.analysis?.level === query.level);
    if (query.trend) list = list.filter((c) => c.analysis?.trend === query.trend);
    return list.map(crackView);
  });

  add('POST', '/api/cracks', ({ body }) => {
    const { sectionId, chainage, position, type } = body || {};
    const sec = db().sections.find((s) => s.id === sectionId);
    if (!sec) throw new HttpError(400, '段落不存在');
    const ch = Number(chainage);
    if (!Number.isFinite(ch) || ch < sec.startM || ch >= sec.endM) {
      throw new HttpError(400, `里程须在 ${fmtChainage(sec.startM)} ~ ${fmtChainage(sec.endM)} 之间`);
    }
    if (!position || !type) throw new HttpError(400, '部位与裂缝类型必填');
    const crack = {
      id: nextId('CRK'),
      code: `LF-${String(db().counters.CRK).padStart(4, '0')}`,
      sectionId,
      chainage: ch,
      position,
      type,
      status: '监测中',
      firstSeenAt: Date.now(),
      scenario: null,
      analysis: null,
    };
    db().cracks.push(crack);
    store.save();
    return crackView(crack);
  });

  add('GET', '/api/cracks/:id', ({ params }) => {
    const c = findCrack(params.id);
    const gauge = db().gauges.find((g) => g.crackId === c.id);
    const readings = gauge ? db().readings.filter((r) => r.gaugeId === gauge.id) : [];
    const daily = aggregateDaily(readings);
    const sec = db().sections.find((s) => s.id === c.sectionId);
    return {
      ...crackView(c),
      sectionCode: sec ? fmtChainage(sec.startM) : null,
      gauge: gauge || null,
      series: daily.map((p) => ({ ts: p.day * DAY, width: Math.round(p.width * 1000) / 1000 })),
      images: db().images.filter((im) => im.crackId === c.id).map(imageView),
      alarms: db().alarms.filter((a) => a.crackId === c.id).sort((a, b) => b.createdAt - a.createdAt).map(alarmView),
      tasks: db().tasks.filter((t) => t.crackId === c.id).sort((a, b) => b.dispatchedAt - a.dispatchedAt).map(taskView),
    };
  });

  // ---------- 巡检与影像 ----------
  add('GET', '/api/inspections', () =>
    [...db().inspections]
      .sort((a, b) => b.inspectedAt - a.inspectedAt)
      .map((ins) => ({
        ...ins,
        sectionCode: fmtChainage(db().sections.find((s) => s.id === ins.sectionId)?.startM ?? 0),
        images: db().images.filter((im) => im.inspectionId === ins.id).map(imageView),
      })),
  );

  add('POST', '/api/inspections', ({ body }) => {
    const { sectionId, inspectedAt, inspector, method, note } = body || {};
    const sec = db().sections.find((s) => s.id === sectionId);
    if (!sec) throw new HttpError(400, '段落不存在');
    if (!inspector) throw new HttpError(400, '巡检人必填');
    const ts = inspectedAt ? Number(inspectedAt) : Date.now();
    if (!Number.isFinite(ts) || ts > Date.now() + DAY) throw new HttpError(400, '巡检时间非法');
    const ins = {
      id: nextId('INS'),
      sectionId,
      inspectedAt: ts,
      inspector,
      method: method || '人工巡检',
      note: note || '',
    };
    db().inspections.push(ins);
    store.save();
    return ins;
  });

  const imageView = (im) => ({
    id: im.id,
    inspectionId: im.inspectionId,
    sectionId: im.sectionId,
    crackId: im.crackId,
    fileName: im.fileName,
    dataUrl: im.dataUrl,
    annotations: im.annotations || [],
    createdAt: im.createdAt,
  });

  add('POST', '/api/inspections/:id/images', ({ params, body }) => {
    const ins = db().inspections.find((i) => i.id === params.id);
    if (!ins) throw new HttpError(404, '巡检记录不存在');
    const { fileName, dataUrl, crackId, annotations } = body || {};
    if (!dataUrl || !dataUrl.startsWith('data:image/')) throw new HttpError(400, '影像须为 data:image/ 格式');
    if (dataUrl.length > 14 * 1024 * 1024) throw new HttpError(413, '影像过大（>10MB）');
    if (crackId) findCrack(crackId);
    const im = {
      id: nextId('IMG'),
      inspectionId: ins.id,
      sectionId: ins.sectionId,
      crackId: crackId || null,
      fileName: fileName || 'image',
      dataUrl,
      annotations: Array.isArray(annotations) ? annotations : [],
      createdAt: Date.now(),
    };
    db().images.push(im);
    store.save();
    return imageView(im);
  });

  add('GET', '/api/images/:id', ({ params }) => {
    const im = db().images.find((i) => i.id === params.id);
    if (!im) throw new HttpError(404, '影像不存在');
    return imageView(im);
  });

  // ---------- 测缝计与读数 ----------
  add('GET', '/api/gauges', () =>
    db().gauges.map((g) => {
      const crack = db().cracks.find((c) => c.id === g.crackId);
      const last = db().readings.filter((r) => r.gaugeId === g.id).sort((a, b) => b.ts - a.ts)[0];
      return {
        ...g,
        crackCode: crack?.code,
        chainageLabel: crack ? fmtChainage(crack.chainage) : null,
        lastReading: last || null,
      };
    }),
  );

  const ingestReading = (gauge, ts, widthMm, temperature) => {
    if (!Number.isFinite(ts) || ts > Date.now() + DAY) throw new HttpError(400, '读数时间非法');
    if (!Number.isFinite(widthMm) || widthMm < 0 || widthMm > 100) throw new HttpError(400, '缝宽须在 0~100mm');
    // 幂等：同一测缝计同一天只保留最新一条（重复上报不产生重复数据）
    const day = Math.floor(ts / DAY);
    const exist = db().readings.find((r) => r.gaugeId === gauge.id && Math.floor(r.ts / DAY) === day);
    if (exist) {
      exist.ts = ts;
      exist.widthMm = widthMm;
      if (temperature !== undefined) exist.temperature = temperature;
      return { reading: exist, replaced: true };
    }
    const reading = { gaugeId: gauge.id, ts, widthMm, temperature: temperature ?? null };
    db().readings.push(reading);
    return { reading, replaced: false };
  };

  add('POST', '/api/gauges/:id/readings', ({ params, body }) => {
    const gauge = db().gauges.find((g) => g.id === params.id || g.code === params.id);
    if (!gauge) throw new HttpError(404, '测缝计不存在');
    const { ts, widthMm, temperature } = body || {};
    const r = ingestReading(gauge, ts ? Number(ts) : Date.now(), Number(widthMm), temperature !== undefined ? Number(temperature) : undefined);
    const crack = db().cracks.find((c) => c.id === gauge.crackId);
    evaluateAlarms(db(), nextId);
    store.save();
    return { ...r, crackId: crack?.id, analysis: crack?.analysis || null };
  });

  add('POST', '/api/readings/batch', ({ body }) => {
    const items = body?.readings;
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'readings 须为非空数组');
    const accepted = [];
    const rejected = [];
    for (const it of items.slice(0, 5000)) {
      const gauge = db().gauges.find((g) => g.id === it.gaugeId || g.code === it.gaugeCode);
      if (!gauge) {
        rejected.push({ ...it, reason: '测缝计不存在' });
        continue;
      }
      try {
        const r = ingestReading(gauge, it.ts ? Number(it.ts) : Date.now(), Number(it.widthMm), it.temperature !== undefined ? Number(it.temperature) : undefined);
        accepted.push({ gaugeId: gauge.id, ts: r.reading.ts, replaced: r.replaced });
      } catch (e) {
        rejected.push({ ...it, reason: e.message });
      }
    }
    const result = evaluateAlarms(db(), nextId);
    store.save();
    return { accepted: accepted.length, rejected, alarms: result };
  });

  // 演示：为所有测缝计生成「下一日」读数并重算趋势
  add('POST', '/api/simulate/day', () => {
    const d = db();
    const rand = mulberry32(Date.now() % 2147483647);
    let created = 0;
    for (const gauge of d.gauges) {
      const crack = d.cracks.find((c) => c.id === gauge.crackId);
      if (!crack?.scenario || crack.status === '已闭合') continue;
      const last = d.readings.filter((r) => r.gaugeId === gauge.id).sort((a, b) => b.ts - a.ts)[0];
      const nextDay = last ? Math.floor(last.ts / DAY) + 1 : Math.floor(Date.now() / DAY);
      const dayIndex = Math.max(0, nextDay - Math.floor(crack.scenario.installedAt / DAY));
      const r = synthReading(crack, dayIndex, rand);
      d.readings.push({ gaugeId: gauge.id, ts: nextDay * DAY + 8 * 3600000, ...r });
      created += 1;
    }
    const result = evaluateAlarms(d, nextId);
    store.save();
    return { created, alarms: result };
  });

  // ---------- 告警 ----------
  const alarmView = (a) => {
    const crack = db().cracks.find((c) => c.id === a.crackId);
    return {
      ...a,
      crackCode: crack?.code,
      chainageLabel: crack ? fmtChainage(crack.chainage) : null,
      position: crack?.position,
      task: db().tasks.find((t) => t.alarmId === a.id && t.status !== '已关闭') || null,
    };
  };

  add('GET', '/api/alarms', ({ query }) => {
    let list = db().alarms;
    if (query.status) list = list.filter((a) => a.status === query.status);
    if (query.level) list = list.filter((a) => a.level === query.level);
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt).map(alarmView);
  });

  add('POST', '/api/alarms/:id/dispatch', ({ params, body }) => {
    const alarm = db().alarms.find((a) => a.id === params.id);
    if (!alarm) throw new HttpError(404, '告警不存在');
    const { assignee, dueDays, note } = body || {};
    if (!assignee) throw new HttpError(400, '必须指定复核人');
    const task = dispatchTask(db(), nextId, alarm, {
      assignee,
      dueDays: Number(dueDays) > 0 ? Number(dueDays) : 3,
      note: note || '',
      dispatchedBy: '值班员',
    });
    store.save();
    return task;
  });

  // ---------- 复核任务 ----------
  const taskView = (t) => {
    const crack = db().cracks.find((c) => c.id === t.crackId);
    const alarm = db().alarms.find((a) => a.id === t.alarmId);
    return {
      ...t,
      crackCode: crack?.code,
      chainageLabel: crack ? fmtChainage(crack.chainage) : null,
      position: crack?.position,
      crackType: crack?.type,
      alarmLevel: alarm?.level,
      alarmReasons: alarm?.reasons || [],
      metrics: alarm?.metrics || null,
      overdue: t.status !== '已完成' && t.status !== '已关闭' && t.dueAt < Date.now(),
    };
  };

  add('GET', '/api/tasks', ({ query }) => {
    let list = db().tasks;
    if (query.status) list = list.filter((t) => t.status === query.status);
    if (query.assignee) list = list.filter((t) => t.assignee === query.assignee);
    return [...list].sort((a, b) => b.dispatchedAt - a.dispatchedAt).map(taskView);
  });

  add('POST', '/api/tasks/:id/claim', ({ params, body }) => {
    const task = db().tasks.find((t) => t.id === params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (task.status !== '待复核') throw new HttpError(409, `任务当前状态为「${task.status}」，无法接单`);
    if (body?.assignee && body.assignee !== task.assignee) {
      if (!db().config.reviewers.includes(body.assignee)) throw new HttpError(400, '复核人不在名册中');
      task.assignee = body.assignee;
    }
    task.status = '复核中';
    task.claimedAt = Date.now();
    store.save();
    return taskView(task);
  });

  add('POST', '/api/tasks/:id/complete', ({ params, body }) => {
    const task = db().tasks.find((t) => t.id === params.id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (task.status === '已完成' || task.status === '已关闭') throw new HttpError(409, '任务已结束');
    const { measuredWidthMm, conclusion, suggestion } = body || {};
    const w = Number(measuredWidthMm);
    if (!Number.isFinite(w) || w < 0 || w > 100) throw new HttpError(400, '实测缝宽须在 0~100mm');
    if (!['误报', '稳定', '确认扩展'].includes(conclusion)) throw new HttpError(400, '结论须为 误报/稳定/确认扩展');

    const now = Date.now();
    task.status = '已完成';
    task.completedAt = now;
    task.result = { measuredWidthMm: w, conclusion, suggestion: suggestion || '' };

    const alarm = db().alarms.find((a) => a.id === task.alarmId);
    const crack = db().cracks.find((c) => c.id === task.crackId);
    if (alarm) {
      alarm.status = '已闭环';
      alarm.closedAt = now;
      alarm.updatedAt = now;
      alarm.closure = { conclusion, measuredWidthMm: w, suggestion: suggestion || '' };
    }
    if (crack) {
      if (conclusion === '确认扩展') crack.status = '处置中';
      if (conclusion === '误报') crack.mutedUntil = now + 7 * DAY; // 误报冷却 7 天，避免反复告警
    }
    store.save();
    return taskView(task);
  });

  // ---------- 分析 ----------
  add('POST', '/api/analysis/run', () => {
    const result = evaluateAlarms(db(), nextId);
    store.save();
    return result;
  });

  // ---------- HTTP 服务 ----------
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'GET' ? null : await readBody(req);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.regex);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => {
            params[k] = decodeURIComponent(m[i + 1]);
          });
          const result = await r.handler({ params, query: Object.fromEntries(url.searchParams), body, req });
          return sendJson(res, 200, result);
        }
        throw new HttpError(404, '接口不存在');
      }
      // 静态文件
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(publicDir, p);
      if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new HttpError(404, '页面不存在');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      sendJson(res, e.statusCode || 500, { error: e.message });
    }
  });
}
