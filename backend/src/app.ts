import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { openApiSpec } from './docs/openapi';
import { logger } from './infra/logger';
import { errorHandler, notFoundHandler, requestId } from './middleware/errorHandler';
import { buildRouter } from './routes';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  if (env.NODE_ENV !== 'test') {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as express.Request).requestId ?? '',
        autoLogging: { ignore: (req) => req.url === '/api/health' },
      }),
    );
  }

  app.get('/docs.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'Dispatch API docs' }));

  app.use('/api', buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
