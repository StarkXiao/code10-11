/**
 * 趋势分析引擎：
 *  - 读数按天聚合（日均值），消除一天多次上报的噪声
 *  - 近 N 天窗口最小二乘回归 → 扩展速率 mm/d
 *  - 前一窗口回归 → 加速度（速率变化）
 *  - 趋势分级：stable / growing / accelerating / insufficient
 *  - 超限判定：宽度 / 速率 / 加速度 三要素 → normal / warning / critical
 */

const DAY = 86400000;

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/** 最小二乘回归 y = a + b·x，返回 { a, b, r2, n } */
export function linregress(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { a, b, r2, n };
}

/** 读数 → 每日均值序列 [{ day, width }]，day 为 Unix 日号 */
export function aggregateDaily(readings) {
  const byDay = new Map();
  for (const r of readings) {
    const d = Math.floor(r.ts / DAY);
    if (!byDay.has(d)) byDay.set(d, { sum: 0, n: 0 });
    const e = byDay.get(d);
    e.sum += r.widthMm;
    e.n += 1;
  }
  return [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((d) => ({ day: d, width: byDay.get(d).sum / byDay.get(d).n }));
}

/**
 * 分析单条裂缝。
 * @param readings 该裂缝测缝计的全部读数 [{ts, widthMm}]
 * @param t 阈值配置 { widthWarn, widthAlarm, rateWarn, rateAlarm, accelAlarm, windowDays }
 */
export function analyzeCrack(readings, t, now = Date.now()) {
  const daily = aggregateDaily(readings);
  if (daily.length === 0) {
    return { sampleCount: 0, trend: 'none', level: 'normal', reasons: [] };
  }
  const t0 = daily[0].day;
  const pts = daily.map((d) => ({ x: d.day - t0, y: d.width }));
  const lastX = pts[pts.length - 1].x;
  const currentWidth = pts[pts.length - 1].y;

  const win = t.windowDays;
  const recent = pts.filter((p) => p.x > lastX - win);
  const prev = pts.filter((p) => p.x <= lastX - win && p.x > lastX - 2 * win);

  const reg = linregress(recent);
  const regPrev = linregress(prev);
  const rate = reg ? reg.b : 0;
  const prevRate = regPrev ? regPrev.b : 0;
  const accel = rate - prevRate;

  let trend;
  if (daily.length < 7) trend = 'insufficient';
  else if (rate >= t.rateAlarm || (rate >= t.rateWarn && accel >= t.accelAlarm)) trend = 'accelerating';
  else if (rate >= t.rateWarn) trend = 'growing';
  else trend = 'stable';

  const reasons = [];
  let level = 'normal';
  if (currentWidth >= t.widthAlarm) {
    level = 'critical';
    reasons.push(`当前宽度 ${currentWidth.toFixed(2)}mm ≥ 超限阈值 ${t.widthAlarm}mm`);
  }
  if (rate >= t.rateAlarm) {
    level = 'critical';
    reasons.push(`近${win}天扩展速率 ${rate.toFixed(4)}mm/d ≥ 速率阈值 ${t.rateAlarm}mm/d`);
  }
  if (level !== 'critical') {
    if (currentWidth >= t.widthWarn) {
      level = 'warning';
      reasons.push(`当前宽度 ${currentWidth.toFixed(2)}mm ≥ 预警阈值 ${t.widthWarn}mm`);
    }
    if (rate >= t.rateWarn) {
      level = 'warning';
      reasons.push(`扩展速率 ${rate.toFixed(4)}mm/d ≥ 预警速率 ${t.rateWarn}mm/d`);
    }
    if (trend === 'accelerating') {
      level = 'warning';
      reasons.push('扩展呈加速趋势');
    }
  }

  return {
    sampleCount: readings.length,
    dayCount: daily.length,
    currentWidth: round4(currentWidth),
    rate: round4(rate),
    prevRate: round4(prevRate),
    accel: round4(accel),
    r2: reg ? round4(reg.r2) : null,
    trend,
    level,
    reasons,
    regression: reg
      ? { a: round4(reg.a), b: round4(reg.b), fromX: lastX - win, toX: lastX }
      : null,
    firstTs: daily[0].day * DAY,
    lastTs: daily[daily.length - 1].day * DAY,
  };
}

function snapshot(a) {
  return {
    currentWidth: a.currentWidth,
    rate: a.rate,
    accel: a.accel,
    trend: a.trend,
  };
}

/**
 * 全量评估：对每条监测中的裂缝重算趋势，创建/更新告警。
 * 去重原则：同一裂缝存在未闭环告警时只更新量值，不重复创建（避免告警轰炸）。
 * 自动派发：critical 级告警在 autoDispatch 开启时自动生成复核任务。
 * 静默：crack.mutedUntil 之前不评估（误报闭环后的冷却期）。
 */
export function evaluateAlarms(db, nextId, now = Date.now()) {
  const t = db.config.thresholds;
  const out = { created: 0, updated: 0, tasksCreated: 0 };
  for (const crack of db.cracks) {
    const gauge = db.gauges.find((g) => g.crackId === crack.id);
    if (!gauge) continue;
    const readings = db.readings.filter((r) => r.gaugeId === gauge.id);
    const result = analyzeCrack(readings, t, now);
    crack.analysis = result; // 所有裂缝都刷新趋势缓存（含处置中，供详情页展示）
    if (crack.status !== '监测中') continue;
    if (crack.mutedUntil && crack.mutedUntil > now) continue;
    if (result.level === 'normal') continue;

    let alarm = db.alarms.find((a) => a.crackId === crack.id && a.status !== '已闭环');
    if (alarm) {
      alarm.level = result.level;
      alarm.reasons = result.reasons;
      alarm.metrics = snapshot(result);
      alarm.updatedAt = now;
      out.updated += 1;
    } else {
      alarm = {
        id: nextId('ALM'),
        crackId: crack.id,
        sectionId: crack.sectionId,
        level: result.level,
        reasons: result.reasons,
        metrics: snapshot(result),
        status: '待复核',
        createdAt: now,
        updatedAt: now,
      };
      db.alarms.push(alarm);
      out.created += 1;
      if (db.config.autoDispatch && result.level === 'critical') {
        dispatchTask(db, nextId, alarm, {
          assignee: db.config.reviewers[0],
          dueDays: 3,
          note: '系统自动派发（超限）',
          dispatchedBy: '系统',
        }, now);
        out.tasksCreated += 1;
      }
    }
  }
  return out;
}

/** 由告警生成现场复核任务（事务性：告警状态同步置为「复核中」） */
export function dispatchTask(db, nextId, alarm, { assignee, dueDays = 3, note = '', dispatchedBy = '系统' }, now = Date.now()) {
  if (alarm.status === '已闭环') {
    const err = new Error('告警已闭环，无法派发');
    err.statusCode = 409;
    throw err;
  }
  const existing = db.tasks.find((tk) => tk.alarmId === alarm.id && tk.status !== '已完成' && tk.status !== '已关闭');
  if (existing) {
    const err = new Error(`该告警已有未完成任务 ${existing.id}`);
    err.statusCode = 409;
    throw err;
  }
  const task = {
    id: nextId('RT'),
    alarmId: alarm.id,
    crackId: alarm.crackId,
    sectionId: alarm.sectionId,
    assignee,
    priority: alarm.level === 'critical' ? '高' : '中',
    status: '待复核',
    note,
    dispatchedBy,
    dispatchedAt: now,
    dueAt: now + dueDays * DAY,
    claimedAt: null,
    completedAt: null,
    result: null,
  };
  db.tasks.push(task);
  alarm.status = '复核中';
  alarm.updatedAt = now;
  return task;
}
