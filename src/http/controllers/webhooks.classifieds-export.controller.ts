import express, { type Request, type Response, Router } from 'express';
import type { z } from 'zod';

import { ClassifiedsExport as s_ClassifiedsExport } from '@immoteur/openapi-zod';

import type { ClassifiedsExportStorageMode } from '../../env.js';
import { mapClassifiedToUpsertDto } from '../mappers/classified.mapper.js';
import { upsertClassifieds } from '../../modules/classifieds/classified.repository.js';
import { ingestWebhook } from '../../modules/webhooks/webhook-ingest.service.js';

const RAW_LIMIT = '10mb';

type ClassifiedsExport = z.infer<typeof s_ClassifiedsExport>;

export function createImmoteurClassifiedsExportWebhookController(
  storageMode: ClassifiedsExportStorageMode = 'persist',
): Router {
  const router = Router();

  router.use(express.raw({ type: '*/*', limit: RAW_LIMIT }));

  router.post('/classifieds-export', async (req: Request, res: Response) => {
    const rawBody = toRawBodyString(req.body);

    const ingested = await ingestWebhook<ClassifiedsExport>({
      defaultEventType: 'classifieds-export',
      schema: s_ClassifiedsExport,
      ip: req.ip,
      rawBody,
      persistPayload: storageMode === 'persist',
    });

    if (!ingested.ok) {
      req.log?.error({ err: ingested.error }, 'failed to store webhook event');
      res.status(500).json({ ok: false });
      return;
    }

    const webhookEventId = ingested.webhookEventId;
    const receivedAt = ingested.receivedAt;
    if (storageMode === 'persist' && ingested.parsed && webhookEventId && receivedAt) {
      const dtos = ingested.parsed.items.map((classified) =>
        mapClassifiedToUpsertDto({
          provider: 'immoteur',
          classified,
          notificationType: null,
          webhookEventId,
          receivedAt,
        }),
      );

      const upsertMany = await upsertClassifieds(dtos);
      if (!upsertMany.ok) {
        req.log?.error({ err: upsertMany.error }, 'failed to upsert classifieds rows');
      } else {
        for (const failure of upsertMany.failures) {
          req.log?.error(
            { err: failure.error, classifiedId: failure.classifiedId },
            'failed to upsert classifieds row',
          );
        }
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
