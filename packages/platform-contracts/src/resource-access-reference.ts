import { z } from 'zod';
const Id = z.string().uuid();
export const ResourceAccessActionSchema = z.enum([
  'source.discover',
  'content.read',
  'original.read',
  'result.export',
  'external.directory',
]);
export type ResourceAccessAction = z.infer<typeof ResourceAccessActionSchema>;
export const ResourceAccessReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('version'), dataItemId: Id, versionId: Id }),
  z.strictObject({
    kind: z.literal('external-source'),
    sourceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  }),
]);
export type ResourceAccessReference = z.infer<
  typeof ResourceAccessReferenceSchema
>;
/** Identity is an immutable version or an explicit provider source; never a label. */
export function resourceAccessReferenceKey(
  resource: ResourceAccessReference,
): string {
  return resource.kind === 'version'
    ? `version:${resource.dataItemId}:${resource.versionId}`
    : `external-source:${resource.sourceId}`;
}
