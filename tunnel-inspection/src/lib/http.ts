import type { NextFunction, Request, Response } from 'express';
import { ZodError, z, type ZodSchema } from 'zod';
import { TaskError } from '../services/dispatch.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 请求体校验：失败抛 400，错误明细原样带出（便于前端定位字段）。 */
export function parseBody<S extends ZodSchema>(schema: S, body: unknown): z.output<S> {
  try {
    return schema.parse(body);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new HttpError(400, 'VALIDATION', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
    }
    throw e;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof TaskError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 409;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // SQLite 唯一约束（幂等兜底）：并发重复写入按 409 返回而非 500
  if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: '唯一性冲突：记录已存在或已有未闭环单据' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
}
