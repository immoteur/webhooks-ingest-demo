import 'dotenv/config';

import { createApp } from './server.js';
import { env } from './env.js';
import { logger } from './logger.js';
import {
  startRetentionJob,
  startWebhookPayloadRetentionJob,
} from './modules/retention/retention.job.js';

const app = createApp({
  webhookAllowedIp: env.WEBHOOK_ALLOWED_IP,
  classifiedsExportStorageMode: env.CLASSIFIEDS_EXPORT_STORAGE_MODE,
});

app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      classifiedsExportStorageMode: env.CLASSIFIEDS_EXPORT_STORAGE_MODE,
    },
    'server started',
  );
});

startRetentionJob();
startWebhookPayloadRetentionJob();
