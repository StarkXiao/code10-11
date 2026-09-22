#!/usr/bin/env node
/**
 * 冒烟脚本：对着运行中的服务真实打一遍主链路（不需要测试框架）。
 * 用法：node scripts/smoke.mjs [baseURL]   默认 http://localhost:3100
 */
const base = process.argv[2] ?? 'http://localhost:3100';
const NOW = Date.now();
const MONTH = 30.4375 * 86_400_000;

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
};

async function api(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const tag = Date.now().toString(36);
const readings = (base0, rate, months) =>
  Array.from({ length: months }, (_, i) => ({
    observed_at: new Date(NOW - (months - 1 - i) * MONTH).toISOString(),
    width_mm: Number((base0 + rate * i).toFixed(3)),
  }));

console.log(`smoke → ${base}`);

const health = await api('GET', '/health');
check('健康检查', health.status === 200 && health.body.ok === true);

const tunnel = await api('POST', '/tunnels', { code: `SMK-${tag}`, name: '冒烟隧道' });
check('建隧道', tunnel.status === 201);

const seg = await api('POST', `/tunnels/${tunnel.body.id}/segments`, {
  code: `SMK-K1+000~K1+100-${tag}`, start_chainage_m: 1000, end_chainage_m: 1100, responsible_team: '冒烟组',
});
check('建段落', seg.status === 201);

const crack = await api('POST', '/cracks', { segment_id: seg.body.id, crack_type: 'longitudinal' });
check('建裂缝并自动编号', crack.status === 201 && /^CR-\d{5}$/.test(crack.body.code));

const gauge = await api('POST', '/gauges', { crack_id: crack.body.id, code: `SMK-CG-${tag}` });
check('挂测缝计', gauge.status === 201);

const up = await api('POST', `/gauges/${gauge.body.id}/readings`, { readings: readings(0.08, 0.03, 6) });
check('读数上报触发超限评估', up.status === 201 && up.body.evaluation.assessment.level === 'exceeded');
check('自动开预警', up.body.evaluation.createdAlert === true);
check('自动派 P1 复核任务', up.body.evaluation.createdTask === true);

const dup = await api('POST', `/gauges/${gauge.body.id}/readings`, { readings: readings(0.08, 0.03, 6) });
check('重复上报被去重', dup.body.inserted === 0 && dup.body.skipped === 6);

const run = await api('POST', '/evaluate/run');
check('全量评估幂等（不重开单）', run.body.newAlerts === 0 && run.body.newTasks === 0);

const tasks = await api('GET', '/tasks?status=pending');
const task = tasks.body.find((t) => t.crack_id === crack.body.id);
check('任务时限 24h（P1）', task && Date.parse(task.due_at) - Date.now() <= 24 * 3600 * 1000);

const badComplete = await api('POST', `/tasks/${task.id}/complete`, { conclusion: 'confirmed' });
check('pending 不能直接 complete', badComplete.status === 409);

await api('POST', `/tasks/${task.id}/accept`, {});
await api('POST', `/tasks/${task.id}/start`, {});
const done = await api('POST', `/tasks/${task.id}/complete`, { conclusion: 'confirmed', note: '现场复测属实' });
check('接单→开始→完成（确认超限）', done.status === 200 && done.body.status === 'completed');

const alerts = await api('GET', '/alerts?status=open');
check('confirmed 后预警保持 open', alerts.body.some((a) => a.crack_id === crack.body.id));

const img = await api('POST', '/images', {
  segment_id: seg.body.id,
  uri: 'oss://smoke/img.jpg',
  taken_at: new Date().toISOString(),
  detections: [
    { crack_id: crack.body.id, width_mm: 0.24 },
    { new_crack: { crack_type: 'map', location_desc: '右边墙' }, width_mm: 0.09 },
  ],
});
check('影像识别入库（老裂缝追加 + 新裂缝建档）',
  img.status === 201 && img.body.detections[0].created_crack === false && img.body.detections[1].created_crack === true);

const dash = await api('GET', '/dashboard/summary');
check('看板汇总可用', dash.status === 200 && Array.isArray(dash.body.cracks_by_level));

console.log(`\n${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
