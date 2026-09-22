import { Store } from './store.js';
import { buildSeed } from './seed.js';
import { evaluateAlarms } from './analysis.js';
import { createServer } from './api.js';

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || new URL('./data/db.json', import.meta.url).pathname;
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

const store = new Store(DATA_FILE);
if (!store.load()) {
  console.log('未找到数据文件，写入演示数据…');
  store.init(buildSeed());
}

// 启动时全量评估一次，刷新趋势缓存与告警
const result = evaluateAlarms(store.db, (p) => store.nextId(p));
store.save();
if (result.created || result.updated) {
  console.log(`趋势评估：新建告警 ${result.created}，更新 ${result.updated}，自动派发 ${result.tasksCreated}`);
}

const server = createServer(store, { publicDir: PUBLIC_DIR });
server.listen(PORT, () => {
  console.log(`隧道衬砌巡检系统已启动：http://localhost:${PORT}`);
});
