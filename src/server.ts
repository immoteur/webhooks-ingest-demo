import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';

import { registerRoutes, type WebhookRouteOptions } from './http/routes.js';
import { logger } from './logger.js';

export function createApp(options?: WebhookRouteOptions): Express {
  const app = express();

  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        remove: true,
      },
    }),
  );

  registerRoutes(app, options);

  app.use((_req, res) => {
    res.status(404).json({ ok: false });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = getHttpStatus(err);
    if (status && status >= 400 && status < 500) {
      res.status(status).end();
      return;
    }

    logger.error({ err }, 'unhandled error');
    res.status(500).json({ ok: false });
  });

  return app;
}

function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return status;

  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;

  return undefined;
}
