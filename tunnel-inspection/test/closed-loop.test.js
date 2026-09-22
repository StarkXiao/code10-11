/**
 * 闭环集成测试：真实 HTTP + 真实 JSON 存储
 * 覆盖：趋势分析 → 超限告警 → 派发 → 接单 → 复核闭环 → 状态流转，
 * 以及幂等（重复评估不重复告警、同日读数覆盖）、批量观测上报、阈值重算。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { buildSeed } from '../server/seed.js';
import { evaluateAlarms } from '../server/analysis.js';
import { createServer } from '../server/api.js';

let server;
let base;
let store;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-test-'));

async function api(p, method = 'GET', body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  store = new Store(path.join(tmpDir, 'db.json'));
  store.init(buildSeed());
  evaluateAlarms(store.db, (p) => store.nextId(p));
  store.save();
  server = createServer(store, { publicDir: path.join(tmpDir, 'public') });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('总览统计可用，段落健康覆盖全部段落', async () => {
  const { status, data } = await api('/api/overview');
  assert.equal(status, 200);
  assert.equal(data.counts.cracks, 12);
  assert.equal(data.sectionHealth.length, 40);
  assert.ok(data.counts.alarmsOpen >= 2, '种子数据应产生未闭环告警');
});

test('趋势引擎识别加速扩展裂缝为超限', async () => {
  const { data: cracks } = await api('/api/cracks?level=critical');
  const codes = cracks.map((c) => c.code);
  assert.ok(codes.includes('LF-0001'), 'LF-0001 加速扩展应超限');
  assert.ok(codes.includes('LF-0004'), 'LF-0004 速率超阈值应超限');
  const { data: detail } = await api('/api/cracks/CRK-0001');
  assert.equal(detail.analysis.trend, 'accelerating');
  assert.ok(detail.analysis.rate > 0.005);
  assert.ok(detail.series.length > 80, '应有 90 天逐日序列');
});

test('重复评估不重复建告警（幂等）', async () => {
  const before1 = (await api('/api/alarms')).data.length;
  await api('/api/analysis/run', 'POST', {});
  await api('/api/analysis/run', 'POST', {});
  const after1 = (await api('/api/alarms')).data.length;
  assert.equal(before1, after1);
});

test('复核闭环：派发 → 接单 → 提交结果 → 告警闭环且裂缝转处置', async () => {
  // 找一条未闭环且无任务的告警（LF-0004 自动派发过则换 LF-0003 预警）
  const { data: alarms } = await api('/api/alarms?status=待复核');
  const alarm = alarms[0];
  assert.ok(alarm, '应存在待复核告警');

  // 派发
  const { status: s1, data: task } = await api(`/api/alarms/${alarm.id}/dispatch`, 'POST', {
    assignee: '王强', dueDays: 2, note: '测试派发',
  });
  assert.equal(s1, 200);
  assert.equal(task.status, '待复核');

  // 重复派发被拒
  const { status: s2 } = await api(`/api/alarms/${alarm.id}/dispatch`, 'POST', { assignee: '王强' });
  assert.equal(s2, 409);

  // 接单
  const { data: claimed } = await api(`/api/tasks/${task.id}/claim`, 'POST', {});
  assert.equal(claimed.status, '复核中');

  // 提交复核结果：确认扩展
  const { data: done } = await api(`/api/tasks/${task.id}/complete`, 'POST', {
    measuredWidthMm: 0.55, conclusion: '确认扩展', suggestion: '注浆处置',
  });
  assert.equal(done.status, '已完成');
  assert.equal(done.result.conclusion, '确认扩展');

  // 告警闭环 + 裂缝转处置中
  const { data: alarmAfter } = await api('/api/alarms');
  const closed = alarmAfter.find((a) => a.id === alarm.id);
  assert.equal(closed.status, '已闭环');
  const { data: crack } = await api(`/api/cracks/${alarm.crackId}`);
  assert.equal(crack.status, '处置中');
});

test('误报结论使告警闭合并静默，不再重复告警', async () => {
  // LF-0003 是 warning 告警
  const { data: alarms } = await api('/api/alarms?status=待复核');
  const warn = alarms.find((a) => a.level === 'warning');
  assert.ok(warn, '应有预警级告警');
  const { data: task } = await api(`/api/alarms/${warn.id}/dispatch`, 'POST', { assignee: '张伟' });
  await api(`/api/tasks/${task.id}/claim`, 'POST', {});
  await api(`/api/tasks/${task.id}/complete`, 'POST', { measuredWidthMm: 0.31, conclusion: '误报', suggestion: '传感器漂移' });
  const before1 = (await api('/api/alarms')).data.length;
  await api('/api/analysis/run', 'POST', {});
  const after1 = (await api('/api/alarms')).data.length;
  assert.equal(before1, after1, '误报静默期内不应重建告警');
});

test('读数上报：同日幂等覆盖，超限触发新告警', async () => {
  const { data: gauges } = await api('/api/gauges');
  const g = gauges.find((x) => x.crackCode === 'LF-0007'); // 稳定裂缝
  const r1 = await api(`/api/gauges/${g.id}/readings`, 'POST', { widthMm: 0.09 });
  assert.equal(r1.status, 200);
  const r2 = await api(`/api/gauges/${g.id}/readings`, 'POST', { widthMm: 0.10 });
  assert.equal(r2.data.replaced, true, '同日重报应覆盖');
  // 直接打到超宽阈值
  await api(`/api/gauges/${g.id}/readings`, 'POST', { widthMm: 0.9 });
  const { data: alarms } = await api('/api/alarms');
  assert.ok(alarms.some((a) => a.crackId === g.crackId && a.status !== '已闭环'), '超宽应产生告警');
});

test('批量上报接口：部分失败不影响整体', async () => {
  const { status, data } = await api('/api/readings/batch', 'POST', {
    readings: [
      { gaugeCode: 'CG-009', widthMm: 0.06 },
      { gaugeCode: 'CG-999', widthMm: 0.06 },
    ],
  });
  assert.equal(status, 200);
  assert.equal(data.accepted, 1);
  assert.equal(data.rejected.length, 1);
});

test('阈值调整触发全量重算', async () => {
  const { status, data } = await api('/api/config/thresholds', 'PUT', { widthAlarm: 5.0 });
  assert.equal(status, 200);
  assert.equal(data.thresholds.widthAlarm, 5.0);
  // 恢复
  await api('/api/config/thresholds', 'PUT', { widthAlarm: 0.5 });
});

test('非法输入被拦截', async () => {
  const bad1 = await api('/api/cracks', 'POST', { sectionId: 'SEC-0001', chainage: 99999, position: '拱顶', type: '纵向裂缝' });
  assert.equal(bad1.status, 400);
  const bad2 = await api('/api/gauges/GAU-0001/readings', 'POST', { widthMm: -3 });
  assert.equal(bad2.status, 400);
  const bad3 = await api('/api/tasks/RT-9999/claim', 'POST', {});
  assert.equal(bad3.status, 404);
});

test('模拟次日读数推进时序', async () => {
  const { data: before1 } = await api('/api/cracks/CRK-0005');
  const { status, data } = await api('/api/simulate/day', 'POST', {});
  assert.equal(status, 200);
  assert.ok(data.created > 0);
  const { data: after1 } = await api('/api/cracks/CRK-0005');
  assert.ok(after1.series.length > before1.series.length);
});
