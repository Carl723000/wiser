import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  candidateSavedReferenceKey,
  IngestionCandidateReferenceSchema,
} from '@wiser/data-contracts';
import { getDictionary, isLocale } from '@/lib/i18n';
import { getDataFoundationDal } from '@/lib/data-foundation-dal.server';
import {
  handleDataPageError,
  invalidDataPageRequest,
} from '@/lib/data-foundation-page.server';
import {
  candidateWorkspaceHref,
  decodeCandidateWorkspaceRoute,
} from '@/lib/candidate-workspace-route';
import {
  DataFailureState,
  DataPageHeader,
  DataPageMain,
} from '@/components/data-foundation-workspace';
import { IngestionCandidateReader } from '@/components/ingestion-candidate-reader';
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
  const dictionary = getDictionary(locale).dataFoundation;
  const candidate = decodeCandidateWorkspaceRoute(search);
  if (candidate.status !== 'absent') {
    const copy = dictionary.candidateReader;
    let reference = candidate.status === 'valid' ? candidate.reference : null;
    let failure: ReturnType<typeof handleDataPageError> | undefined;
    try {
      if (reference === null) throw invalidDataPageRequest();
      const dal = await getDataFoundationDal();
      // The authenticated DAL applies current Project/tenant scope. This entry
      // only accepts its advertised current candidate, never an older batch.
      const detail = await dal.ingestionDetail(reference.ingestionId);
      const current = IngestionCandidateReferenceSchema.safeParse(
        detail.candidateReference,
      );
      if (
        !current.success ||
        detail.ingestion.ingestionId.toLowerCase() !==
          reference.ingestionId.toLowerCase() ||
        candidateSavedReferenceKey(current.data) !==
          candidateSavedReferenceKey(reference)
      )
        throw invalidDataPageRequest();
      reference = current.data;
    } catch (error) {
      failure = handleDataPageError(
        error,
        locale,
        reference === null
          ? `/${locale}/data-foundation/spatial-workspace`
          : candidateWorkspaceHref(locale, reference),
      );
    }
    return (
      <DataPageMain>
        <DataPageHeader
          eyebrow={dictionary.ingestionPage.eyebrow}
          title={copy.workspaceTitle}
          lede={copy.workspaceScope}
        />
        {failure ? <DataFailureState locale={locale} error={failure} /> : null}
        <p>
          <a
            href={
              reference === null
                ? `/${locale}/data-foundation/ingestions`
                : `/${locale}/data-foundation/ingestions/${reference.ingestionId.toLowerCase()}`
            }
          >
            {copy.returnIntake}
          </a>
        </p>
        {failure === undefined && reference !== null ? (
          <IngestionCandidateReader
            reference={reference}
            locale={locale}
            readOnly
          />
        ) : null}
      </DataPageMain>
    );
  }
  const copy = dictionary.spatialManagement;
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
