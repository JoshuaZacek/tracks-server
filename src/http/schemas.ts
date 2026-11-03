import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';

/**
 * Building blocks shared by every module's schemas. Schemas with `.meta({ id })`
 * become named components in the OpenAPI document (and named types in Swift).
 */

/** Three-letter station code. Accepted in any case, always returned upper case. */
export const Crs = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Must be a three-letter station (CRS) code')
  .toUpperCase()
  .meta({ description: 'Three-letter station (CRS) code', example: 'KGX' });

/** Calendar date in the UK. */
export const IsoDate = z.iso.date().meta({ description: 'Calendar date (YYYY-MM-DD), UK local', example: '2026-11-03' });

/**
 * An instant, always written with the UK offset (+00:00 in winter, +01:00 in
 * summer) and no fractional seconds: Swift's JSONDecoder `.iso8601` strategy
 * rejects fractions. `precision: 0` makes the response check enforce that.
 */
export const DateTime = z.iso
  .datetime({ offset: true, local: false, precision: 0 })
  .meta({ description: 'ISO 8601 date-time with UK offset, no fractional seconds', example: '2026-11-03T17:30:00+00:00' });

export const Uuid = z.uuid();

/**
 * An APNs or ActivityKit token in hex, stored lower-case. Apple says not to
 * assume a size: device tokens are 32 bytes today, ActivityKit tokens 128
 * (iOS 26), so this allows up to 512 bytes.
 */
export const HexToken = z
  .string()
  .regex(/^[0-9a-fA-F]{32,1024}$/, 'Must be a hex token (32–1024 hex characters)')
  .toLowerCase();

/** Network Rail train UID from the timetable (CIF_train_uid), e.g. "C12345". */
export const TrainUid = z
  .string()
  .regex(/^[A-Za-z0-9]{6}$/, 'Must be a 6-character train UID')
  .toUpperCase()
  .meta({ description: 'Timetable train UID (CIF_train_uid)', example: 'L12345' });

export const Operator = z
  .object({
    code: z.string().meta({ description: 'Two-character operator (ATOC) code', example: 'GR' }),
    name: z.string().meta({ example: 'LNER' }),
  })
  .meta({ id: 'Operator' });

export const ValidationIssue = z
  .object({
    in: z.enum(['params', 'query', 'body']),
    path: z.string().meta({ example: 'date' }),
    message: z.string(),
  })
  .meta({ id: 'ValidationIssue' });

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.array(ValidationIssue).optional().meta({ description: 'Present for `validation_failed`: one entry per invalid field' }),
    }),
  })
  .meta({ id: 'Error' });

/** Query-string integer with bounds and a default. */
export const queryInt = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

/**
 * `T | null` for a named (`.meta({ id })`) schema. Use this, not `.nullable()`:
 * zod-to-openapi emits a bare `$ref` for `Named.nullable()` and drops the null,
 * which would make Swift decode the field as non-optional. This emits
 * `anyOf: [{ $ref }, { type: 'null' }]`. test/openapi.test.ts checks every field.
 */
export const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);
