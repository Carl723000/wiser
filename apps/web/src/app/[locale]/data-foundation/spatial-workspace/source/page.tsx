import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDictionary, isLocale } from '@/lib/i18n';
import { loadLocalSpatialWorkspace } from '@/lib/spatial-workspace-local';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
} from '@/lib/spatial-workspace-url-state';
import {
  workspaceReadingRecords,
  withWorkspaceReadingRecord,
} from '@/lib/spatial-workspace-reading-view';
import styles from '@/components/spatial-workspace-shell.module.css';

export default async function SpatialSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, search, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ]);
  if (!isLocale(locale)) notFound();
  const copy = getDictionary(locale).dataFoundation.spatialManagement;
  const input = await loadLocalSpatialWorkspace(
    process.env,
    requestHeaders.get('host'),
  );
  if (input.state !== 'ready' || !input.pack)
    return (
      <main id="main-content" className={styles.workspace}>
        <h1>{copy.title}</h1>
        <p role="status">
          {copy[input.state === 'ready' ? 'invalid' : input.state]}
        </p>
        <a href={`/${locale}/data-foundation/explore`}>{copy.openExplore}</a>
      </main>
    );
  const pack = input.pack;
  const reading = decodeWorkspaceReadingUrl(search, { pack });
  if (reading.status !== 'valid' || !reading.state.source)
    return (
      <main id="main-content" className={styles.workspace}>
        <h1>{copy.readingLinkInvalid}</h1>
        <p role="alert">{copy.readingLinkInvalidText}</p>
        <a href={`/${locale}/data-foundation/spatial-workspace`}>
          {copy.returnWorkspace}
        </a>
      </main>
    );
  const state = reading.state;
  const source = pack.sources.find(
    (item) =>
      item.id === state.source!.sourceId &&
      item.versionId === state.source!.versionId,
  )!;
  const records = workspaceReadingRecords(pack, state).filter(
    (item) =>
      item.sourceId === source.id && item.versionId === source.versionId,
  );
  const returnLink = encodeWorkspaceReadingUrl(locale, state, { pack });
  return (
    <main id="main-content" className={styles.workspace}>
      <h1>{source.title}</h1>
      <p className={styles.status}>{copy.localStatus}</p>
      <dl>
        <dt>{copy.provider}</dt>
        <dd>{source.provider}</dd>
        <dt>{copy.fixedVersion}</dt>
        <dd>{source.versionId}</dd>
        <dt>
          {source.kind === 'raster'
            ? copy.rasterOriginalHash
            : copy.originalHash}
        </dt>
        <dd className={styles.hash}>{source.originalSha256}</dd>
      </dl>
      {source.coverageNote && <p>{source.coverageNote}</p>}
      <p>{copy.excerptScope}</p>
      {source.evidenceUrl && (
        <p>
          <a href={source.evidenceUrl} target="_blank" rel="noreferrer">
            {source.kind === 'raster' ? copy.sourceLicense : copy.openOriginal}
          </a>
        </p>
      )}
      <p>{source.rights.note}</p>
      <h2>{copy.sourceRecords}</h2>
      {records.map((record) => {
        const next = withWorkspaceReadingRecord(
          pack,
          { ...state, tab: 'spatial', pane: 'evidence' },
          {
            recordId: record.id,
            positionId:
              state.selection?.recordId === record.id
                ? (state.selection.position?.positionId ?? null)
                : null,
          },
        );
        const href = next
          ? encodeWorkspaceReadingUrl(locale, next, { pack })
          : null;
        return (
          <article className={styles.card} key={record.id}>
            <h3>{record.objectLabel}</h3>
            <p>
              {record.metric} · {record.value ?? copy.unknown} ·{' '}
              {record.time.start ?? copy.unknown}
            </p>
            {record.evidence.map((evidence, index) => (
              <div key={`${record.id}:${index}`}>
                <code>{evidence.locator}</code>
                <blockquote>{evidence.text}</blockquote>
              </div>
            ))}
            {href?.status === 'valid' && (
              <a href={href.href}>{copy.returnToRecord}</a>
            )}
          </article>
        );
      })}
      {!records.length && <p>{copy.noSourceRecords}</p>}
      {returnLink.status === 'valid' && (
        <a href={returnLink.href}>{copy.returnWorkspace}</a>
      )}
    </main>
  );
}
