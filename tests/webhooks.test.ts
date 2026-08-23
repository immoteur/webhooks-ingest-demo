import path from 'node:path';
import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Classified, ClassifiedsExport } from '@immoteur/openapi-zod';

import type * as DbClient from '../src/db/client.js';
import {
  classifiedImages,
  classifiedPriceHistory,
  classifieds,
  webhookEvents,
} from '../src/db/schema.js';

type ClassifiedNotificationWebhookPayload = Classified & { type: string };
type Db = typeof DbClient.db;
type DbPool = typeof DbClient.pool;

type CodedError = {
  code?: string;
  cause?: CodedError;
};

const classifiedNotificationExample: ClassifiedNotificationWebhookPayload = {
  id: '7f6e3b4d-9c22-46a0-8f20-0d1a2b3c4d5e',
  propertyId: '01920347-45c7-7b81-a2e4-d28c43f0d123',
  type: 'created',
  currency: 'euro',
  squareUnit: 'squareMeter',
  status: {
    current: 'available',
  },
  meta: {
    firstSeenAt: '2025-09-15T08:10:00Z',
    lastModifiedAt: '2025-09-15T09:00:00Z',
    lastSeenAt: '2025-09-15T09:00:00Z',
    removedAt: null,
  },
  source: {
    domain: 'seloger.com',
    url: 'https://www.seloger.com/annonces/achat/appartement/paris-1er-75/5-pieces/0.htm',
  },
  publisher: {
    isProfessional: true,
    type: 'agency',
    email: 'contact@agence-paris.fr',
    phone: '+33123456789',
    feesUrl: 'https://www.agence-paris.fr/honoraires',
    siren: '123456789',
    siret: '12345678900011',
  },
  location: {
    city: {
      name: 'Paris',
      inseeCode: '75056',
    },
    country: 'france',
    department: '75',
    postcode: '75001',
    latitude: 48.8606,
    longitude: 2.3376,
  },
  media: {
    images: [
      {
        id: '8f8f0c4e-1bca-48d5-98bb-8ab2c0c0ab12',
        position: 1,
        url: 'https://images.immoteur.com/sample/apt-paris-1.jpg',
      },
    ],
  },
  property: {
    type: 'apartment',
    area: 50,
    roomCount: 3,
    bedroomCount: 2,
    elevatorExists: true,
    terraceExists: true,
  },
  transaction: {
    type: 'sale',
    price: {
      current: 650000,
      initial: 650000,
      perSquareUnit: 13000,
      history: [
        {
          id: '4d4744d6-d7f1-4f8b-8c3c-fb8a1e3c0f8a',
          value: 650000,
          timestamp: '2025-09-15T09:00:00Z',
        },
      ],
    },
  },
};

const classifiedsExportExample: ClassifiedsExport = {
  exportId: '2f9b734d-9c22-46a0-8f20-0d1a2b3c4d5e',
  items: [classifiedNotificationExample],
};

function getPgErrorCode(err: CodedError | null | undefined): string | undefined {
  let current = err;

  for (let i = 0; i < 5; i += 1) {
    if (!current) return undefined;

    if (typeof current.code === 'string') return current.code;

    if (!current.cause || current.cause === current) return undefined;
    current = current.cause;
  }

  return undefined;
}

describe('webhook ingestion', () => {
  let container: StartedPostgreSqlContainer;
  let app: Express;
  let metadataOnlyApp: Express;
  let db: Db;
  let pool: DbPool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('webhooks_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();

    const client = await import('../src/db/client.js');
    db = client.db;
    pool = client.pool;

    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src', 'db', 'migrations') });

    const { createApp } = await import('../src/server.js');
    app = createApp();
    metadataOnlyApp = createApp({ classifiedsExportStorageMode: 'metadata-only' });
  });

  beforeEach(async () => {
    await db.delete(classifieds);
    await db.delete(webhookEvents);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('stores a webhook event row', async () => {
    // Given
    const id = '7f6e3b4d-9c22-46a0-8f20-0d1a2b3c4d5e';
    const body = { id, type: 'created' };

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('classified-notification');
    expect(rows[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.payload).not.toBeNull();
    expect(rows[0]?.error).toMatch(/^schema_invalid:/);
  });

  it('stores a valid payload with no error', async () => {
    // Given
    const requestId = 'req_123';
    const forwardedFor = '203.0.113.10';

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer should-not-be-stored')
      .set('cookie', 'a=b')
      .set('x-request-id', requestId)
      .set('x-forwarded-for', forwardedFor)
      .send(classifiedNotificationExample);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.eventType).toBe('classified-notification');
    expect(row.error).toBeNull();
    const payload = row.payload as { id?: string; type?: string };
    expect(payload.id).toBe(classifiedNotificationExample.id);
    expect(payload.type).toBe(classifiedNotificationExample.type);
    expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('upserts a classifieds row with flattened columns', async () => {
    // Given
    const id = classifiedNotificationExample.id;
    const exampleImages = classifiedNotificationExample.media?.images ?? [];
    const examplePriceHistory = classifiedNotificationExample.transaction.price.history;

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(classifiedNotificationExample);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);

    const classifiedRows = await db.select().from(classifieds).where(eq(classifieds.id, id));
    expect(classifiedRows).toHaveLength(1);

    const row = classifiedRows[0]!;
    expect(row.provider).toBe('immoteur');
    expect(row.lastWebhookEventId).toBe(eventRows[0]!.id);
    expect(row.currency).toBe('euro');
    expect(row.locationDepartment).toBe('75');
    expect(row.propertyType).toBe('apartment');
    expect(row.transactionType).toBe('sale');
    expect(row.transactionPriceCurrent).toBeTypeOf('number');

    const imageRows = await db
      .select()
      .from(classifiedImages)
      .where(eq(classifiedImages.classifiedId, id));
    expect(imageRows.length).toBe(exampleImages.length);
    if (imageRows.length > 0) {
      expect(imageRows[0]!.url).toMatch(/^https?:\/\//);
    }

    const priceHistoryRows = await db
      .select()
      .from(classifiedPriceHistory)
      .where(eq(classifiedPriceHistory.classifiedId, id));
    expect(priceHistoryRows.length).toBe(examplePriceHistory.length);
  });

  it('stores a classifieds export webhook and upserts all items', async () => {
    // Given
    const items = classifiedsExportExample.items;
    const firstItemId = items[0]?.id;

    // When
    const res = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.eventType).toBe('classifieds-export');
    expect(eventRows[0]!.error).toBeNull();
    expect(eventRows[0]!.payload).not.toBeNull();

    if (firstItemId) {
      const classifiedRows = await db
        .select()
        .from(classifieds)
        .where(eq(classifieds.id, firstItemId));
      expect(classifiedRows).toHaveLength(1);
      expect(classifiedRows[0]!.lastWebhookEventId).toBe(eventRows[0]!.id);
    }
  });

  it('metadata-only export stores receipt without listings', async () => {
    // Given
    const body = classifiedsExportExample;

    // When
    const res = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      eventType: 'classifieds-export',
      payload: null,
      error: null,
    });
    expect(eventRows[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
    await expect(db.select().from(classifiedImages)).resolves.toHaveLength(0);
    await expect(db.select().from(classifiedPriceHistory)).resolves.toHaveLength(0);
  });

  it('metadata-only export stores validation errors without payloads', async () => {
    // Given
    const body = { exportId: classifiedsExportExample.exportId, items: [{}] };

    // When
    const res = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.payload).toBeNull();
    expect(eventRows[0]?.error).toBe('schema_invalid');
    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
  });

  it('metadata-only export stores malformed JSON errors without payloads', async () => {
    // Given
    const raw = '{"exportId":';

    // When
    const res = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(raw);

    // Then
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.payload).toBeNull();
    expect(eventRows[0]?.error).toBe('invalid_json');
    expect(eventRows[0]?.bodySha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
  });

  it('metadata-only oversized invalid export stores bounded receipt', async () => {
    // Given
    const body = {
      exportId: classifiedsExportExample.exportId,
      items: [{ unexpected: 'x'.repeat(9 * 1024 * 1024) }],
    };

    // When
    const res = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.payload).toBeNull();
    expect(eventRows[0]?.error).toBe('schema_invalid');
    expect(eventRows[0]?.error?.length).toBeLessThanOrEqual(32);
    expect(eventRows[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
  });

  it('metadata-only export stores append-only receipts for repeated payloads', async () => {
    // Given
    const body = classifiedsExportExample;

    // When
    const firstResponse = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);
    const secondResponse = await request(metadataOnlyApp)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body).toMatchObject({ ok: true, duplicate: false });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(2);
    expect(eventRows.every((row) => row.payload === null)).toBe(true);
    expect(eventRows[0]?.bodySha256).toBe(eventRows[1]?.bodySha256);
    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
  });

  it('metadata-only export returns 500 when receipt storage fails', async () => {
    // Given
    await pool.query('ALTER TABLE webhook_events RENAME TO webhook_events_unavailable');

    // When
    let res;
    try {
      res = await request(metadataOnlyApp)
        .post('/webhooks/classifieds-export')
        .set('content-type', 'application/json')
        .send(classifiedsExportExample);
    } finally {
      await pool.query('ALTER TABLE webhook_events_unavailable RENAME TO webhook_events');
    }

    // Then
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false });
    await expect(db.select().from(webhookEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(classifieds)).resolves.toHaveLength(0);
  });

  it('metadata-only export mode keeps notification persistence', async () => {
    // Given
    const body = classifiedNotificationExample;

    // When
    const res = await request(metadataOnlyApp)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.payload).not.toBeNull();
    await expect(db.select().from(classifieds)).resolves.toHaveLength(1);
    await expect(db.select().from(classifiedImages)).resolves.toHaveLength(1);
    await expect(db.select().from(classifiedPriceHistory)).resolves.toHaveLength(1);
  });

  it('stores multiple export events for repeated payloads', async () => {
    // When
    const res1 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);
    const res2 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);

    // Then
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ ok: true, duplicate: false });
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(2);
  });

  it('stores schema_invalid for malformed export payloads', async () => {
    // Given
    const body = { exportId: '2f9b734d-9c22-46a0-8f20-0d1a2b3c4d5e', items: [{}] };

    // When
    const res = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.error).toMatch(/^schema_invalid:/);

    const classifiedRows = await db.select().from(classifieds);
    expect(classifiedRows).toHaveLength(0);
  });

  it('only exposes the classified webhook route', async () => {
    // Given
    const body = {};

    // When
    const res1 = await request(app)
      .post('/webhooks/property-notification')
      .set('content-type', 'application/json')
      .send(body);
    const res2 = await request(app)
      .post('/webhooks/classifieds')
      .set('content-type', 'application/json')
      .send(body);
    const res3 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send({ exportId: '2f9b734d-9c22-46a0-8f20-0d1a2b3c4d5e', items: [] });

    // Then
    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
    expect(res3.status).toBe(200);
  });

  it('stores audit body hash even when JSON is invalid', async () => {
    // Given
    const raw = '{"id":';

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(raw);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bodySha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(rows[0]?.error).toMatch(/^invalid_json:/);
  });

  it('rejects requests when webhook IP allowlist does not match', async () => {
    // Given
    const { createApp } = await import('../src/server.js');
    const blockedApp = createApp({ webhookAllowedIp: '10.0.0.1' });
    const body = { id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', type: 'created' };

    // When
    const res = await request(blockedApp)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(403);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(0);
  });

  it('accepts requests when webhook IP allowlist matches', async () => {
    // Given
    const { createApp } = await import('../src/server.js');
    const allowedApp = createApp({ webhookAllowedIp: '127.0.0.1' });

    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const body = { id, type: 'created' };

    // When
    const res = await request(allowedApp)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores multiple events for the same classified id', async () => {
    // Given
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const body = { id, type: 'created' };

    // When
    const res1 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);
    const res2 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ ok: true });
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ ok: true });

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(2);
  });

  it('replaces images and price history on subsequent notifications', async () => {
    // Given
    const id = classifiedNotificationExample.id;

    const payload1 = structuredClone(classifiedNotificationExample);
    const payload2 = structuredClone(classifiedNotificationExample);

    const originalImageId = payload1.media?.images?.[0]?.id;
    const originalHistoryTimestamp = payload1.transaction.price.history[0]?.timestamp;

    const baseImage = payload1.media?.images?.[0];
    payload2.media = {
      images: [
        {
          ...(baseImage ?? {
            id: '11111111-1111-1111-8111-111111111111',
            position: 1,
            url: 'https://example.com/new.jpg',
          }),
          id: '11111111-1111-1111-8111-111111111111',
          position: 1,
          url: 'https://example.com/new.jpg',
        },
      ],
    };

    payload2.transaction.price.current = 640000;
    payload2.transaction.price.history = [
      {
        ...payload1.transaction.price.history[0]!,
        timestamp: '2025-09-16T09:00:00Z',
        value: 640000,
      },
    ];

    payload2.meta.lastModifiedAt = '2025-09-16T09:00:00Z';
    payload2.meta.lastSeenAt = '2025-09-16T09:00:00Z';

    // When
    const res1 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(payload1);
    const eventRowsAfter1 = await db.select().from(webhookEvents);
    const res2 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(payload2);

    // Then
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(eventRowsAfter1).toHaveLength(1);
    const firstEventId = eventRowsAfter1[0]!.id;

    const eventRowsAfter2 = await db.select().from(webhookEvents);
    expect(eventRowsAfter2).toHaveLength(2);

    const secondEventId = eventRowsAfter2.find((row) => row.id !== firstEventId)?.id;
    expect(secondEventId).toBeTruthy();

    const classifiedRow = (await db.select().from(classifieds).where(eq(classifieds.id, id)))[0]!;
    expect(classifiedRow.lastWebhookEventId).toBe(secondEventId);
    expect(classifiedRow.transactionPriceCurrent).toBe(640000);

    const imageRows = await db
      .select()
      .from(classifiedImages)
      .where(eq(classifiedImages.classifiedId, id));
    expect(imageRows).toHaveLength(1);
    expect(imageRows[0]!.id).toBe('11111111-1111-1111-8111-111111111111');
    if (originalImageId) {
      expect(imageRows.find((img) => img.id === originalImageId)).toBeUndefined();
    }

    const priceHistoryRows = await db
      .select()
      .from(classifiedPriceHistory)
      .where(eq(classifiedPriceHistory.classifiedId, id));
    expect(priceHistoryRows).toHaveLength(1);
    if (originalHistoryTimestamp) {
      expect(
        priceHistoryRows.find(
          (h) => h.timestamp.toISOString() === new Date(originalHistoryTimestamp).toISOString(),
        ),
      ).toBeUndefined();
    }
  });

  it('enforces foreign keys for classifieds child tables', async () => {
    // Given
    const classifiedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // When
    let imagesErrorCode: string | undefined;
    try {
      await db.insert(classifiedImages).values({
        classifiedId,
        id: '11111111-1111-1111-1111-111111111111',
        position: 1,
        url: 'https://example.com/1.jpg',
        averageHash: null,
        differenceHash: null,
        perceptualHash: null,
      });
    } catch (err: CodedError) {
      imagesErrorCode = getPgErrorCode(err);
    }

    let priceHistoryErrorCode: string | undefined;
    try {
      await db.insert(classifiedPriceHistory).values({
        classifiedId,
        timestamp: new Date('2025-09-15T09:00:00Z'),
        value: 650000,
      });
    } catch (err: CodedError) {
      priceHistoryErrorCode = getPgErrorCode(err);
    }

    // Then
    expect(imagesErrorCode).toBe('23503');
    expect(priceHistoryErrorCode).toBe('23503');
  });
});
