import { z } from 'zod';

const classifiedsExportStorageModeSchema = z.enum(['persist', 'metadata-only']);

export type ClassifiedsExportStorageMode = z.infer<typeof classifiedsExportStorageModeSchema>;

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().default(3000)),
  LOG_LEVEL: z.preprocess(emptyStringToUndefined, z.string().optional()),
  WEBHOOK_ALLOWED_IP: z.preprocess(emptyStringToUndefined, z.string().optional()),
  CLASSIFIEDS_EXPORT_STORAGE_MODE: z.preprocess(
    emptyStringToUndefined,
    classifiedsExportStorageModeSchema.default('persist'),
  ),
  WEBHOOK_EVENTS_RETENTION_HOURS: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().nonnegative().default(24),
  ),
  WEBHOOK_EVENTS_MAX_ROWS: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().nonnegative().default(0),
  ),
  WEBHOOK_PAYLOAD_RETENTION_MAX_BYTES: z.preprocess(
    emptyStringToUndefined,
    z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024 * 1024),
  ),
  CLASSIFIEDS_LAST_SEEN_RETENTION_DAYS: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().nonnegative().default(7),
  ),
  CLASSIFIEDS_MAX_ROWS: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().nonnegative().default(0),
  ),
});

export const env = envSchema.parse(process.env);
