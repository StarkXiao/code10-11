import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

const db = openDb();
const app = createApp(db);

app.listen(config.port, () => {
  console.log(`隧道衬砌巡检系统 API 已启动: http://localhost:${config.port}`);
  console.log(`数据库: ${config.dbFile}`);
});
