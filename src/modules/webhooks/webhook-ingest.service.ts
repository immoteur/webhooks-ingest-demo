import { createHash } from 'node:crypto';

import { storeWebhookEvent } from './webhook-event.repository.js';
import { extractNotificationType, safeJsonParse, type WebhookEventType } from './webhook.utils.js';

export async function ingestWebhook<TParsed>(input: {
  defaultEventType: WebhookEventType;
  rawBody: string;
  ip: string | undefined;
  persistPayload: boolean;
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
}): Promise<
  | {
      ok: true;
      duplicate: boolean;
      webhookEventId: string | null;
      receivedAt: Date | null;
      parsed: TParsed | null;
      notificationType: string | null;
    }
  | { ok: false; error: unknown }
> {
  const jsonResult = safeJsonParse(input.rawBody);
  const bodySha256 = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');

  let payload: unknown | null = null;
  let error: string | null = null;

  let notificationType: string | null = null;
  let parsed: TParsed | null = null;

  if (!jsonResult.success) {
    error = `invalid_json: ${jsonResult.error}`;
  } else {
    payload = jsonResult.data;
    const schemaResult = input.schema.safeParse(jsonResult.data);
    if (!schemaResult.success) {
      error = `schema_invalid: ${String(schemaResult.error)}`;
    } else {
      parsed = schemaResult.data as TParsed;
    }

    if (jsonResult.data && typeof jsonResult.data === 'object' && !Array.isArray(jsonResult.data)) {
      const record = jsonResult.data as Record<string, unknown>;
      notificationType = extractNotificationType(record);
    }
  }

  const result = await storeWebhookEvent({
    eventType: input.defaultEventType,
    requestIp: input.ip ?? null,
    payload: input.persistPayload ? payload : null,
    bodySha256,
    error,
  });

  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    duplicate: result.duplicate,
    webhookEventId: result.id,
    receivedAt: result.receivedAt,
    parsed,
    notificationType,
  };
}
