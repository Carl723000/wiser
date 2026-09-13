import {
  RelationEntityReferenceSchema,
  RelationStatusSchema,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { parseRelationNodeIdentity } from './relation-graph';
type Source = { dataItemId: string; versionId: string };
export type RelationViewState = Source & {
  sources: Source[];
  status: RelationAssertion['status'];
  preview: boolean;
  entity: string | null;
  pages: number;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid relation view');
  return value as Record<string, unknown>;
}
function source(value: unknown): Source {
  const record = object(value);
  if (Object.keys(record).some((k) => !['dataItemId', 'versionId'].includes(k)))
    throw Error('Invalid source');
  const parsed = RelationEntityReferenceSchema.parse({
    ...record,
    mappingVersion: 'view',
    entityKey: 'view',
  });
  return { dataItemId: parsed.dataItemId, versionId: parsed.versionId };
}
export function readRelationView(
  search: string,
  expected: Source,
): RelationViewState | null {
  const params = new URLSearchParams(search);
  if (!params.has('relations')) return null;
  const values = params.getAll('relations');
  const text = values[0];
  if (values.length !== 1 || !text || text.length > 8192)
    throw Error('Invalid relation view');
  const value = object(JSON.parse(text));
  if (
    Object.keys(value).some(
      (k) =>
        ![
          'dataItemId',
          'versionId',
          'sources',
          'status',
          'preview',
          'entity',
          'pages',
        ].includes(k),
    )
  )
    throw Error('Unknown view field');
  const base = source({
    dataItemId: value.dataItemId,
    versionId: value.versionId,
  });
  if (
    base.dataItemId !== expected.dataItemId ||
    base.versionId !== expected.versionId
  )
    throw Error('Source mismatch');
  if (!Array.isArray(value.sources) || value.sources.length > 11)
    throw Error('Invalid sources');
  const sources = value.sources.map(source);
  if (
    new Set([base.versionId, ...sources.map((s) => s.versionId)]).size !==
    sources.length + 1
  )
    throw Error('Duplicate source');
  const status = RelationStatusSchema.parse(value.status);
  if (
    typeof value.preview !== 'boolean' ||
    (value.preview && !['APPROVED', 'PENDING_REVIEW'].includes(status))
  )
    throw Error('Invalid preview');
  if (
    typeof value.pages !== 'number' ||
    !Number.isInteger(value.pages) ||
    value.pages < 1 ||
    value.pages > 10
  )
    throw Error('Invalid page bound');
  const entity = value.entity;
  if (entity !== null) {
    if (typeof entity !== 'string' || entity.length > 1024)
      throw Error('Invalid entity');
    const ref = parseRelationNodeIdentity(entity);
    if (
      ![base, ...sources].some(
        (s) => s.dataItemId === ref.dataItemId && s.versionId === ref.versionId,
      )
    )
      throw Error('Entity outside scope');
  }
  return {
    ...base,
    sources,
    status,
    preview: value.preview,
    entity,
    pages: value.pages,
  };
}
export function relationViewHref(
  current: string,
  view: RelationViewState,
): string {
  const encoded = JSON.stringify(view);
  readRelationView('?relations=' + encodeURIComponent(encoded), view);
  const url = new URL(current);
  if (
    !new RegExp(
      '^/(zh-CN|en)/data-foundation/catalog/' + view.dataItemId + '$',
    ).test(url.pathname) ||
    url.searchParams.get('versionId') !== view.versionId
  )
    throw Error('Source route mismatch');
  url.searchParams.set('relations', encoded);
  url.hash = 'business-relations';
  return url.pathname + url.search + url.hash;
}
export function relationSourceLinks(
  sources: readonly Source[],
  locale: string,
  origin: string,
) {
  return sources
    .map(
      (s) =>
        `${origin}/${locale}/data-foundation/catalog/${s.dataItemId}?versionId=${s.versionId}`,
    )
    .join('\n');
}
