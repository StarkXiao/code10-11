import express, { type Express } from 'express';
import type { DB } from './db.js';
import { errorHandler } from './lib/http.js';
import { tunnelsRouter } from './routes/tunnels.js';
import { cracksRouter } from './routes/cracks.js';
import { imagesRouter } from './routes/images.js';
import { gaugesRouter } from './routes/gauges.js';
import { alertsRouter } from './routes/alerts.js';
import { tasksRouter } from './routes/tasks.js';
import { evaluateRouter, dashboardRouter } from './routes/misc.js';

export function createApp(db: DB): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'tunnel-inspection' }));

  app.use('/api/tunnels', tunnelsRouter(db));
  app.use('/api/cracks', cracksRouter(db));
  app.use('/api/images', imagesRouter(db));
  app.use('/api/gauges', gaugesRouter(db));
  app.use('/api/alerts', alertsRouter(db));
  app.use('/api/tasks', tasksRouter(db));
  app.use('/api/evaluate', evaluateRouter(db));
  app.use('/api/dashboard', dashboardRouter(db));

  app.use(errorHandler);
  return app;
}
