import express, { type Request, type Response, Router } from 'express';
import type { z } from 'zod';

import { Classified as s_Classified } from '@immoteur/openapi-zod';

import { mapClassifiedToUpsertDto } from '../mappers/classified.mapper.js';
import { upsertClassified } from '../../modules/classifieds/classified.repository.js';
import { ingestWebhook } from '../../modules/webhooks/webhook-ingest.service.js';

const RAW_LIMIT = '10mb';

type Classified = z.infer<typeof s_Classified>;

export function createImmoteurClassifiedNotificationWebhookController(): Router {
  const router = Router();

  router.use(express.raw({ type: '*/*', limit: RAW_LIMIT }));

  router.post('/classified-notification', async (req: Request, res: Response) => {
    const rawBody = toRawBodyString(req.body);

    const ingested = await ingestWebhook<Classified>({
      defaultEventType: 'classified-notification',
      schema: s_Classified,
      ip: req.ip,
      rawBody,
      persistPayload: true,
    });

    if (!ingested.ok) {
      req.log?.error({ err: ingested.error }, 'failed to store webhook event');
      res.status(500).json({ ok: false });
      return;
    }

    const webhookEventId = ingested.webhookEventId;
    const receivedAt = ingested.receivedAt;
    if (ingested.parsed && webhookEventId && receivedAt) {
      const dto = mapClassifiedToUpsertDto({
        provider: 'immoteur',
        classified: ingested.parsed,
        notificationType: ingested.notificationType,
        webhookEventId,
        receivedAt,
      });

      const upsert = await upsertClassified(dto);
      if (!upsert.ok) {
        req.log?.error({ err: upsert.error }, 'failed to upsert classifieds row');
      }
    }

    res.status(200).json({ ok: true, duplicate: ingested.duplicate });
  });

  return router;
}

function toRawBodyString(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return String(body ?? '');
}
