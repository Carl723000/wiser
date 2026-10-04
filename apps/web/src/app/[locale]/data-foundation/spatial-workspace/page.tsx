import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDictionary, isLocale } from '@/lib/i18n';
import { loadLocalSpatialWorkspace } from '@/lib/spatial-workspace-local';
import { decodeWorkspaceReadingUrl } from '@/lib/spatial-workspace-url-state';
import { defaultWorkspaceReadingState } from '@/lib/spatial-workspace-reading-view';
import { SpatialWorkspaceShell } from '@/components/spatial-workspace-shell';
import styles from '@/components/spatial-workspace-shell.module.css';

export default async function SpatialWorkspacePage({
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
  const reading = decodeWorkspaceReadingUrl(search, { pack: input.pack });
  if (reading.status === 'invalid')
    return (
      <main id="main-content" className={styles.workspace}>
        <h1>{copy.readingLinkInvalid}</h1>
        <p role="alert">{copy.readingLinkInvalidText}</p>
        <a href={`/${locale}/data-foundation/spatial-workspace`}>
          {copy.returnWorkspace}
        </a>
      </main>
    );
  return (
    <SpatialWorkspaceShell
      pack={input.pack}
      locale={locale}
      initialReadingState={
        reading.status === 'valid'
          ? reading.state
          : defaultWorkspaceReadingState()
      }
      readinessFacts={input.readinessFacts ?? null}
      readinessState={input.readinessState ?? 'absent'}
      publicReferences={input.publicReferences ?? null}
      publicReferenceState={input.publicReferenceState ?? 'absent'}
    />
  );
}
