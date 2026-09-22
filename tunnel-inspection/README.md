# 隧道衬砌巡检系统（tunnel-inspection）

汇聚**巡检影像**与**测缝计数据**，对衬砌裂缝做**扩展趋势识别**，并对**超限/预警段落自动派发现场复核任务**，形成「监测 → 预警 → 复核 → 闭环」的完整链路。

```text
测缝计读数 ──┐
巡检影像识别 ─┼─→ 统一观测序列（observations）─→ 趋势分析（最小二乘回归）
人工量测 ────┘                                      │
                                    正常 / 关注 / 预警 / 超限
                                                     │
                                    预警/超限 ──→ 开预警 + 派复核任务（幂等）
                                                     │
                              接单 → 现场复核 → 结论：确认 / 误报 / 已处置
                                                     │
                        误报、已处置 → 销警闭环；确认超限 → 预警保持，转处置流程
```

## 快速开始

环境要求：Node.js ≥ 20.11，无需外部数据库（SQLite 落 `./data/`）。

```bash
npm install
npm run seed     # 灌演示数据（6 条裂缝 12 个月读数）并全量评估，打印分级与派单结果
npm run dev      # 启动 API，默认 http://localhost:3100
```

另开终端验证主链路（16 项断言）：

```bash
node scripts/smoke.mjs                 # 或 npm run smoke
```

测试与类型检查：

```bash
npm test           # 22 项：趋势分析单测 + 真实 HTTP + 真实 SQLite 闭环集成测试
npm run typecheck
```

## 判定口径（阈值均可按段落覆盖）

| 等级 | 条件 | 动作 |
| --- | --- | --- |
| 超限 `exceeded` | 最新缝宽 ≥ 限值（默认 **0.2mm**，钢筋混凝土管片口径） | 开预警 + 派 **P1** 任务（24h 时限） |
| 预警 `warning` | 扩展速率 ≥ 预警值（默认 **0.05mm/月**），或按当前速率预计 **90 天**内超限 | 开预警 + 派 **P2** 任务（72h 时限） |
| 关注 `watch` | 速率 ≥ 预警值一半，或缝宽 ≥ 限值 70% | 只标记，不派单 |
| 正常 `normal` | 其余 | — |
| 样本不足 `insufficient_data` | 观测 < 3 条且未超限 | 提示补数据（宽度超限判定不受样本量限制） |

趋势用**最小二乘线性回归**拟合（`src/analysis/trend.ts`），输出斜率（mm/月）、R²、预计超限时间；负斜率（裂缝趋于闭合）不判预警。默认阈值参考 JTG H12 / GB 50446 对钢筋混凝土管片的裂缝宽度限值，段落建册时可按衬砌类型单独设置 `width_limit_mm` / `rate_limit_mm_per_month`。

## 数据模型

```text
tunnels ──< segments ──< cracks ──< observations   ← 统一观测序列（source: gauge/image/manual）
               │            ├──< gauges            ← 测缝计（挂在裂缝上）
               └──< images ──→ observations        ← 影像识别结果（含归一化轮廓 polygon）
cracks ──< alerts        同一裂缝同时最多一条 open 预警（部分唯一索引保证）
cracks ──< review_tasks  同一裂缝同时最多一条未闭环任务（同上）
```

**汇聚的关键设计**：测缝计读数、影像识别宽度、人工量测统一写入 `observations`，趋势分析只面对一条时间序列——新接一类数据源不需要改分析逻辑。

## 三个工程取舍

1. **幂等优先**：测缝计重传（`gauge_id + observed_at` 唯一）、重复评估、并发开单都不会产生重复数据——预警与任务靠数据库部分唯一索引兜底，先查后插只是常规路径。
2. **人不闭环、警不销**：评估引擎只开单和升级（任务未闭环期间等级恶化会**原地提升优先级并收紧时限**，不另开新单），绝不因数据回落自动销警；销警只有三个出口——复核结论（误报/已处置）、人工销警、任务取消联动。
3. **任务状态机可校验**：`pending → accepted → in_progress → completed`，非法跳转返回 409 与可读原因；`complete` 必须给出结论（`confirmed`/`false_alarm`/`repaired`），无法"假完成"。

## API 一览（前缀 `/api`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tunnels`、`/tunnels/:id/segments` | 隧道、段落建册（段落可设阈值覆盖与负责班组） |
| POST/GET | `/cracks`、`/cracks/:id` | 裂缝建档（自动编号 `CR-00001`）与详情（含观测、未闭环预警/任务） |
| GET | `/cracks/:id/trend` | 实时趋势评估（只计算，不落单） |
| POST | `/cracks/:id/evaluate` | 事件驱动评估（必要时开预警派单） |
| POST | `/gauges`、`/gauges/:id/readings` | 测缝计建档、读数批量上报（去重 + 即时评估） |
| POST/GET | `/images` | 影像及识别结果入库（事务内建新裂缝 + 写观测 + 触发评估） |
| POST | `/evaluate/run` | 全量评估（可挂 cron 周期执行） |
| GET/POST | `/alerts`、`/alerts/:id/resolve` | 预警查询、人工销警（联动取消未闭环任务） |
| GET/POST | `/tasks`、`/tasks/:id/{accept,start,complete,cancel}` | 复核任务查询与状态推进 |
| GET | `/dashboard/summary` | 看板：分级分布、未闭环预警、任务状态、超时任务数 |

### 示例：读数上报即触发超限派单

```bash
curl -X POST localhost:3100/api/gauges/5/readings -H 'content-type: application/json' -d '{
  "readings": [
    {"observed_at": "2026-08-22T00:00:00Z", "width_mm": 0.21},
    {"observed_at": "2026-09-22T00:00:00Z", "width_mm": 0.23}
  ]}'
# → evaluation.assessment.level = "exceeded"，createdAlert/createdTask = true，
#   任务 P1、时限 24h、自动指派段落负责班组
```

### 示例：影像识别结果入库

```bash
curl -X POST localhost:3100/api/images -H 'content-type: application/json' -d '{
  "segment_id": 1, "uri": "oss://insp/IMG_001.jpg", "taken_at": "2026-09-22T00:00:00Z",
  "detections": [
    {"crack_id": 3, "width_mm": 0.19, "polygon": [[0.12, 0.31], [0.44, 0.78]]},
    {"new_crack": {"crack_type": "oblique", "location_desc": "左边墙腰部"}, "width_mm": 0.12}
  ]}'
```

## 目录结构

```text
src/
├─ analysis/trend.ts     # 趋势分析纯函数：回归、分级、超限时间预测
├─ services/
│  ├─ evaluate.ts        # 评估服务：趋势 → 预警生命周期（开单/升级，不自动销警）
│  └─ dispatch.ts        # 派发引擎：幂等建单、优先级升级、任务状态机
├─ routes/               # tunnels/cracks/images/gauges/alerts/tasks/evaluate/dashboard
├─ db.ts                 # SQLite 建表（含幂等唯一索引）
└─ config.ts             # 阈值与 SLA 默认值
scripts/
├─ seed-demo.ts          # 演示数据 + 全量评估演示
└─ smoke.mjs             # 对运行中服务的 16 项主链路冒烟
tests/
├─ trend.test.ts         # 趋势分析 14 项单测（含浮点、负斜率、样本不足边界）
└─ closed-loop.test.ts   # 真实 HTTP + SQLite 闭环：超限派单 → 幂等 → 状态机 → 销警
```

## 边界与扩展点（未实现，按需接入）

- **确认超限后的处置流程**（注浆/嵌缝工单、复测计划）：当前 `confirmed` 结论保持预警 open，处置闭环留给后续模块；
- **图像识别模型**：`POST /images` 接收的是识别结果（宽度、轮廓），模型推理服务只需按此格式回传；
- **通知触达**：任务派发目前落库可查，短信/IM 推送可在 `ensureTask` 建单处挂钩子；
- **多租户与权限**：当前无鉴权，面向内网部署；接入时建议在路由层加统一中间件。
