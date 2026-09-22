/**
 * 演示数据：青云山隧道（K10+000 ~ K14+000，40 个百米段落）
 * 12 条裂缝 / 12 台测缝计 / 90 天逐日读数 / 3 次巡检影像 / 2 条历史告警与任务
 * 使用确定性伪随机（mulberry32），任意机器上生成结果一致。
 */
import { analyzeCrack } from './analysis.js';

const DAY = 86400000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

/** 裂缝扩展剧本：给定安装后天数与温度，返回理论缝宽 */
export function scenarioWidth(scenario, dayIndex, tempC) {
  const s = scenario;
  let w = s.base;
  if (s.kind === 'growing') w += s.rate * dayIndex;
  else if (s.kind === 'accel') w += s.k1 * dayIndex + s.k2 * dayIndex * dayIndex;
  else if (s.kind === 'jump') w += s.rate * dayIndex + (dayIndex >= s.jumpDay ? s.jumpSize : 0);
  // 温度效应：热胀冷缩，温度升高缝宽略收窄
  w += -0.002 * (tempC - 20);
  return w;
}

/** 生成某一天的一条读数（含温度与量测噪声） */
export function synthReading(crack, dayIndex, rand) {
  const temp = 20 + 8 * Math.sin(((dayIndex % 365) / 365) * 2 * Math.PI) + (rand() - 0.5) * 4;
  const noise = (rand() - 0.5) * 0.008;
  return {
    widthMm: round3(Math.max(0.01, scenarioWidth(crack.scenario, dayIndex, temp) + noise)),
    temperature: round1(temp),
  };
}

/** 衬砌展开示意图（SVG → dataURL），同时产出裂缝标注的归一化坐标 */
function liningSvg({ chainageLabel, position, widthMm, seed }) {
  const rand = mulberry32(seed);
  const W = 800;
  const H = 450;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#4a4f55"/>`);
  // 混凝土斑驳纹理
  for (let i = 0; i < 40; i += 1) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 8 + rand() * 30;
    const g = 60 + Math.floor(rand() * 25);
    parts.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="rgb(${g},${g + 4},${g + 8})" opacity="0.35"/>`);
  }
  // 施工缝（环向）参考线
  for (const x of [200, 400, 600]) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#5d646c" stroke-width="2" stroke-dasharray="10 6"/>`);
  }
  // 裂缝折线（同时记录归一化坐标）
  const n = 12;
  const x0 = 120 + rand() * 80;
  const y0 = 80 + rand() * 60;
  const x1 = 620 + rand() * 60;
  const y1 = 280 + rand() * 80;
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const x = x0 + (x1 - x0) * f + (rand() - 0.5) * 36;
    const y = y0 + (y1 - y0) * f + (rand() - 0.5) * 36;
    pts.push([x, y]);
  }
  const norm = pts.map(([x, y]) => [Math.round((x / W) * 10000) / 10000, Math.round((y / H) * 10000) / 10000]);
  const poly = pts.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
  parts.push(`<polyline points="${poly}" fill="none" stroke="#1b1b1b" stroke-width="5" stroke-linejoin="round"/>`);
  parts.push(`<polyline points="${poly}" fill="none" stroke="#e74c3c" stroke-width="2.5" stroke-linejoin="round"/>`);
  // 测缝计（跨缝安装的小方块）
  const mid = pts[Math.floor(n / 2)];
  parts.push(`<rect x="${mid[0] - 14}" y="${mid[1] - 10}" width="28" height="20" fill="#dfe6ee" stroke="#2c3e50" stroke-width="2" rx="3"/>`);
  parts.push(`<text x="${mid[0]}" y="${mid[1] + 4}" font-size="11" fill="#2c3e50" text-anchor="middle" font-family="monospace">CG</text>`);
  // 标尺与文字
  parts.push(`<rect x="0" y="${H - 34}" width="${W}" height="34" fill="#2f343a"/>`);
  parts.push(`<text x="16" y="${H - 12}" font-size="16" fill="#ecf0f1" font-family="monospace">${chainageLabel} ${position}  缝宽≈${widthMm.toFixed(2)}mm</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
  return { dataUrl: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), points: norm };
}

const fmtChainage = (m) => `K${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, '0')}`;

export function buildSeed(now = Date.now()) {
  const rand = mulberry32(20260922);
  const thresholds = {
    widthWarn: 0.3,
    widthAlarm: 0.5,
    rateWarn: 0.005,
    rateAlarm: 0.01,
    accelAlarm: 0.004,
    windowDays: 30,
  };

  const tunnel = {
    id: 'TUN-0001',
    name: '青云山隧道',
    line: 'G85 银昆高速',
    direction: '上行线',
    startM: 10000,
    endM: 14000,
  };

  const sections = [];
  for (let m = tunnel.startM, i = 1; m < tunnel.endM; m += 100, i += 1) {
    sections.push({ id: `SEC-${String(i).padStart(4, '0')}`, tunnelId: tunnel.id, startM: m, endM: m + 100 });
  }
  const sectionOf = (chainage) => sections.find((s) => chainage >= s.startM && chainage < s.endM);

  // 裂缝清单：剧本决定 90 天后的量值与趋势，覆盖 稳定/缓慢/加速/阶跃 四种形态
  const specs = [
    { chainage: 10320, position: '拱顶', type: '纵向裂缝', scenario: { kind: 'accel', base: 0.18, k1: 0.0015, k2: 0.00009 } },
    { chainage: 11150, position: '左边墙', type: '斜向裂缝', scenario: { kind: 'accel', base: 0.22, k1: 0.0018, k2: 0.00008 } },
    { chainage: 12080, position: '右拱腰', type: '环向裂缝', scenario: { kind: 'growing', base: 0.3, rate: 0.001 } },
    { chainage: 12460, position: '拱顶', type: '纵向裂缝', scenario: { kind: 'growing', base: 0.16, rate: 0.012 } },
    { chainage: 10860, position: '右边墙', type: '网状裂缝', scenario: { kind: 'stable', base: 0.12 } },
    { chainage: 13120, position: '左拱腰', type: '环向裂缝', scenario: { kind: 'growing', base: 0.1, rate: 0.002 } },
    { chainage: 11640, position: '拱顶', type: '纵向裂缝', scenario: { kind: 'stable', base: 0.08 } },
    { chainage: 13780, position: '右边墙', type: '斜向裂缝', scenario: { kind: 'jump', base: 0.15, rate: 0.002, jumpDay: 60, jumpSize: 0.15 } },
    { chainage: 10540, position: '左拱腰', type: '环向裂缝', scenario: { kind: 'stable', base: 0.05 } },
    { chainage: 12900, position: '拱顶', type: '纵向裂缝', scenario: { kind: 'growing', base: 0.09, rate: 0.002 } },
    { chainage: 13450, position: '左边墙', type: '纵向裂缝', scenario: { kind: 'stable', base: 0.14 } },
    { chainage: 11920, position: '右拱腰', type: '网状裂缝', scenario: { kind: 'growing', base: 0.07, rate: 0.002 } },
  ];

  const installedAt = now - 90 * DAY;
  const cracks = [];
  const gauges = [];
  const readings = [];

  specs.forEach((sp, i) => {
    const id = `CRK-${String(i + 1).padStart(4, '0')}`;
    const sec = sectionOf(sp.chainage);
    const crack = {
      id,
      code: `LF-${String(i + 1).padStart(4, '0')}`,
      sectionId: sec.id,
      chainage: sp.chainage,
      position: sp.position,
      type: sp.type,
      status: '监测中',
      firstSeenAt: installedAt,
      scenario: { ...sp.scenario, installedAt },
      analysis: null,
    };
    cracks.push(crack);
    const gauge = {
      id: `GAU-${String(i + 1).padStart(4, '0')}`,
      code: `CG-${String(i + 1).padStart(3, '0')}`,
      crackId: id,
      type: '振弦式测缝计',
      installedAt,
      status: '在线',
    };
    gauges.push(gauge);
    for (let d = 0; d <= 90; d += 1) {
      const r = synthReading(crack, d, rand);
      readings.push({ gaugeId: gauge.id, ts: installedAt + d * DAY + 8 * 3600000, ...r });
    }
  });

  // 巡检与影像
  const inspections = [
    { id: 'INS-0001', sectionId: sectionOf(10320).id, inspectedAt: installedAt + 2 * DAY, inspector: '赵敏', method: '人工巡检', note: '日常巡检，新发现拱顶纵向裂缝' },
    { id: 'INS-0002', sectionId: sectionOf(11150).id, inspectedAt: installedAt + 45 * DAY, inspector: '张伟', method: '人工巡检', note: '重点段落复查' },
    { id: 'INS-0003', sectionId: sectionOf(12460).id, inspectedAt: installedAt + 80 * DAY, inspector: '李静', method: '车载巡检', note: '月度全覆盖巡检' },
  ];
  const images = [];
  const imgSpecs = [
    { ins: 0, crackIdx: 0 },
    { ins: 1, crackIdx: 1 },
    { ins: 1, crackIdx: 2 },
    { ins: 2, crackIdx: 3 },
    { ins: 2, crackIdx: 7 },
    { ins: 2, crackIdx: 0 },
  ];
  imgSpecs.forEach((sp, i) => {
    const crack = cracks[sp.crackIdx];
    const sec = sections.find((s) => s.id === crack.sectionId);
    const widthNow = scenarioWidth(crack.scenario, Math.floor((inspections[sp.ins].inspectedAt - installedAt) / DAY), 20);
    const { dataUrl, points } = liningSvg({
      chainageLabel: fmtChainage(crack.chainage),
      position: crack.position,
      widthMm: widthNow,
      seed: 1000 + i,
    });
    images.push({
      id: `IMG-${String(i + 1).padStart(4, '0')}`,
      inspectionId: inspections[sp.ins].id,
      sectionId: sec.id,
      crackId: crack.id,
      fileName: `${fmtChainage(crack.chainage)}_${crack.position}.svg`,
      dataUrl,
      annotations: [{ crackId: crack.id, points }],
      createdAt: inspections[sp.ins].inspectedAt,
    });
  });

  // 历史告警与任务（演示闭环的两个状态：复核中 / 已闭环）
  const analysisOf = (idx) =>
    analyzeCrack(readings.filter((r) => r.gaugeId === gauges[idx].id), thresholds, now);

  const a1 = analysisOf(0);
  const a2 = analysisOf(1);
  const alarms = [
    {
      id: 'ALM-0001',
      crackId: cracks[0].id,
      sectionId: cracks[0].sectionId,
      level: 'critical',
      reasons: a1.reasons,
      metrics: { currentWidth: a1.currentWidth, rate: a1.rate, accel: a1.accel, trend: a1.trend },
      status: '复核中',
      createdAt: now - 1 * DAY,
      updatedAt: now - 1 * DAY,
    },
    {
      id: 'ALM-0002',
      crackId: cracks[1].id,
      sectionId: cracks[1].sectionId,
      level: 'critical',
      reasons: a2.reasons,
      metrics: { currentWidth: a2.currentWidth, rate: a2.rate, accel: a2.accel, trend: a2.trend },
      status: '已闭环',
      createdAt: now - 6 * DAY,
      updatedAt: now - 2 * DAY,
      closedAt: now - 2 * DAY,
      closure: { conclusion: '确认扩展', measuredWidthMm: 0.63, suggestion: '建议 15 日内注浆加固，加密监测至每日 2 次' },
    },
  ];
  const tasks = [
    {
      id: 'RT-0001',
      alarmId: 'ALM-0001',
      crackId: cracks[0].id,
      sectionId: cracks[0].sectionId,
      assignee: '张伟',
      priority: '高',
      status: '待复核',
      note: '拱顶裂缝加速扩展，请携带测缝仪现场复核',
      dispatchedBy: '系统',
      dispatchedAt: now - 1 * DAY,
      dueAt: now + 2 * DAY,
      claimedAt: null,
      completedAt: null,
      result: null,
    },
    {
      id: 'RT-0002',
      alarmId: 'ALM-0002',
      crackId: cracks[1].id,
      sectionId: cracks[1].sectionId,
      assignee: '李静',
      priority: '高',
      status: '已完成',
      note: '边墙裂缝宽度超限，现场复核',
      dispatchedBy: '系统',
      dispatchedAt: now - 6 * DAY,
      dueAt: now - 3 * DAY,
      claimedAt: now - 6 * DAY + 3600000,
      completedAt: now - 2 * DAY,
      result: { measuredWidthMm: 0.63, conclusion: '确认扩展', suggestion: '建议 15 日内注浆加固，加密监测至每日 2 次' },
    },
  ];
  // 已确认扩展的裂缝转入「处置中」，不再参与超限评估
  cracks[1].status = '处置中';

  return {
    meta: { version: 1, seededAt: now },
    counters: { SEC: 40, CRK: 12, GAU: 12, INS: 3, IMG: images.length, ALM: 2, RT: 2 },
    config: {
      thresholds,
      autoDispatch: true,
      reviewers: ['张伟', '李静', '王强'],
      inspectors: ['张伟', '李静', '王强', '赵敏'],
    },
    tunnels: [tunnel],
    sections,
    cracks,
    gauges,
    readings,
    inspections,
    images,
    alarms,
    tasks,
  };
}

// 支持 `node server/seed.js --force` 重建演示数据
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Store } = await import('./store.js');
  const file = process.env.DATA_FILE || new URL('./data/db.json', import.meta.url).pathname;
  const force = process.argv.includes('--force');
  const store = new Store(file);
  const existed = store.load();
  if (existed && !force) {
    console.log(`数据文件已存在：${file}（使用 --force 覆盖重建）`);
  } else {
    store.init(buildSeed());
    console.log(`已写入演示数据 → ${file}`);
  }
}
