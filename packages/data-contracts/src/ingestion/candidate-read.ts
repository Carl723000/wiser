import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  CursorSchema,
  OffsetDateTimeSchema,
  PageRequestFields,
} from '../common.ts';
import {
  IngestionCandidateAssetSchema,
  IngestionCandidateReferenceSchema,
  jsonUtf8Bytes,
} from './candidate.ts';

export const IngestionCandidateReadInputSchema =
  IngestionCandidateReferenceSchema.extend(PageRequestFields);
export const IngestionCandidateRecordsInputSchema =
  IngestionCandidateReadInputSchema.extend({ assetId: PlatformUuidSchema });

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PageCursor = CursorSchema.nullable();
export const IngestionCandidateAssetPageSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    parserVersion: z.string().min(1).max(128),
    status: z.enum(['READY', 'PARTIAL', 'UNAVAILABLE']),
    createdAt: OffsetDateTimeSchema,
    totalAssetCount: Count.min(1).max(10_000),
    knownRecordCount: Count,
    knownFeatureCount: Count,
    unknownAssetCount: Count,
    assets: z.array(IngestionCandidateAssetSchema).max(200),
    nextCursor: PageCursor,
  })
  .superRefine((page, context) => {
    if (
      page.unknownAssetCount > page.totalAssetCount ||
      page.assets.length > page.totalAssetCount ||
      page.knownFeatureCount > page.knownRecordCount ||
      new Set(page.assets.map((asset) => asset.assetId)).size !==
        page.assets.length
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Candidate totals and paged original identities must be consistent',
      });
    }
  });
export type IngestionCandidateAssetPage = z.infer<
  typeof IngestionCandidateAssetPageSchema
>;

export interface IngestionCandidateGeometry {
  readonly type:
    | 'Point'
    | 'MultiPoint'
    | 'LineString'
    | 'MultiLineString'
    | 'Polygon'
    | 'MultiPolygon'
    | 'GeometryCollection';
  readonly coordinates?: unknown;
  readonly geometries?: readonly IngestionCandidateGeometry[];
}

function validGeometry(value: unknown): value is IngestionCandidateGeometry {
  // Bound hostile values before reading fields or recursing; coordinates remain unchanged.
  let nodes = 0;
  const seen = new WeakSet<object>();
  const safe = (item: unknown, depth: number): boolean => {
    if (++nodes > 800_000 || depth > 12) return false;
    if (item === null || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item) as Record<
      string,
      { readonly value?: unknown }
    >;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (
        !Object.hasOwn(descriptor, 'value') ||
        !safe(descriptor.value, depth + 1)
      )
        return false;
    }
    seen.delete(item);
    return true;
  };
  if (!safe(value, 0)) return false;
  const position = (p: unknown): p is number[] =>
    Array.isArray(p) &&
    (p.length === 2 || p.length === 3) &&
    p.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(p[0] as number) <= 180 &&
    Math.abs(p[1] as number) <= 90;
  const line = (p: unknown): p is number[][] =>
    Array.isArray(p) && p.length >= 2 && p.every(position);
  const ring = (p: unknown): boolean =>
    line(p) &&
    p.length >= 4 &&
    p[0]!.length === p.at(-1)!.length &&
    p[0]!.every((v, i) => v === p.at(-1)![i]);
  const polygon = (p: unknown): boolean =>
    Array.isArray(p) && p.length > 0 && p.every(ring);
  const geometry = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v !== 'object' || Array.isArray(v) || depth > 4)
      return false;
    const g = v as Record<string, unknown>;
    if (g['type'] === 'GeometryCollection')
      return (
        Object.keys(g).every((k) => ['type', 'geometries'].includes(k)) &&
        Array.isArray(g['geometries']) &&
        g['geometries'].length > 0 &&
        g['geometries'].every((x) => geometry(x, depth + 1))
      );
    if (Object.keys(g).some((k) => !['type', 'coordinates'].includes(k)))
      return false;
    const c = g['coordinates'];
    switch (g['type']) {
      case 'Point':
        return position(c);
      case 'MultiPoint':
        return Array.isArray(c) && c.length > 0 && c.every(position);
      case 'LineString':
        return line(c);
      case 'MultiLineString':
        return Array.isArray(c) && c.length > 0 && c.every(line);
      case 'Polygon':
        return polygon(c);
      case 'MultiPolygon':
        return Array.isArray(c) && c.length > 0 && c.every(polygon);
      default:
        return false;
    }
  };
  return geometry(value, 0);
}
export const IngestionCandidateGeometrySchema = z.preprocess(
  (value, context) => {
    if (!validGeometry(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate geometry must be bounded valid WGS84 geometry',
      });
      return z.NEVER;
    }
    return value;
  },
  z.strictObject({
    type: z.enum([
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
    ]),
    coordinates: z.json().optional(),
    geometries: z.array(z.json()).max(10_000).optional(),
  }),
);
export const IngestionCandidateGeometryPageSchema = z
  .strictObject({
    reference: IngestionCandidateReferenceSchema,
    assetId: PlatformUuidSchema,
    crs: z.literal('EPSG:4326'),
    features: z
      .array(
        z.strictObject({
          recordId: PlatformUuidSchema,
          assetId: PlatformUuidSchema,
          index: z.number().int().min(1).max(2_000_000),
          sourceId: z.string().min(1).max(1024).nullable(),
          sourceCrs: z.string().min(1).max(128).nullable(),
          geometry: IngestionCandidateGeometrySchema,
        }),
      )
      .max(200),
    nextCursor: PageCursor,
  })
  .superRefine((page, context) => {
    let previous = 0;
    const ids = new Set<string>();
    for (const [i, feature] of page.features.entries()) {
      if (
        feature.assetId !== page.assetId ||
        feature.index <= previous ||
        ids.has(feature.recordId)
      )
        context.addIssue({
          code: 'custom',
          path: ['features', i],
          message: 'Geometry must preserve original record identity and order',
        });
      previous = feature.index;
      ids.add(feature.recordId);
    }
    if (jsonUtf8Bytes(page) > 3 * 1024 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Candidate geometry page exceeds the response budget',
      });
  });
export type IngestionCandidateGeometryPage = z.infer<
  typeof IngestionCandidateGeometryPageSchema
>;
