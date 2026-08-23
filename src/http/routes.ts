import type { Express } from 'express';

import type { ClassifiedsExportStorageMode } from '../env.js';

import { createHealthController } from './controllers/health.controller.js';
import { createRootController } from './controllers/root.controller.js';
import { createImmoteurClassifiedsExportWebhookController } from './controllers/webhooks.classifieds-export.controller.js';
import { createImmoteurClassifiedNotificationWebhookController } from './controllers/webhooks.classified-notification.controller.js';
import { ipAllowList } from './middleware/ip-allowlist.js';

export type WebhookRouteOptions = {
  webhookAllowedIp?: string;
  classifiedsExportStorageMode?: ClassifiedsExportStorageMode;
};

export function registerRoutes(app: Express, options?: WebhookRouteOptions): void {
  app.use(createRootController());
  app.use(createHealthController());

  if (options?.webhookAllowedIp) {
    app.use('/webhooks', ipAllowList(options.webhookAllowedIp));
  }

  app.use('/webhooks', createImmoteurClassifiedNotificationWebhookController());
  app.use(
    '/webhooks',
    createImmoteurClassifiedsExportWebhookController(
      options?.classifiedsExportStorageMode ?? 'persist',
    ),
  );
}
