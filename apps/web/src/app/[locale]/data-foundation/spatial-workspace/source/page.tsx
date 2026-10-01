import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDictionary, isLocale } from '@/lib/i18n';
import { loadLocalSpatialWorkspace } from '@/lib/spatial-workspace-local';
import styles from '@/components/spatial-workspace-shell.module.css';

export default async function SpatialSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ source?: string; version?: string }>;
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
  const source = input.pack?.sources.find(
    (item) => item.id === search.source && item.versionId === search.version,
  );
  if (!source || !input.pack) notFound();
  const records = input.pack.records.filter(
    (item) =>
      item.sourceId === source.id && item.versionId === source.versionId,
  );
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
      {records.map((record) => (
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
          <a
            href={`/${locale}/data-foundation/spatial-workspace?record=${encodeURIComponent(record.id)}`}
          >
            {copy.returnToRecord}
          </a>
        </article>
      ))}
      {!records.length && <p>{copy.noSourceRecords}</p>}
      <a href={`/${locale}/data-foundation/spatial-workspace`}>
        {copy.returnWorkspace}
      </a>
    </main>
  );
}
