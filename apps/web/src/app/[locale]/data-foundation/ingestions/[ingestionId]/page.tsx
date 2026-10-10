import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AuthorityFlag,
  DataFailureState,
  DataPageHeader,
  DataPageMain,
  DataSection,
  FieldGrid,
  IngestionRuntimeSummaries,
  IngestionStateRail,
  ProtocolValue,
  SectionHeading,
  StatusBadge,
  formatDataDate,
} from '@/components/data-foundation-workspace';
import { parseDataRouteUuid, type IngestionDto } from '@/lib/data-foundation';
import {
  DataFoundationApiError,
  getDataFoundationDal,
} from '@/lib/data-foundation-dal.server';
import type { CandidateSupplementLookup } from '@/components/candidate-followup-panel';
import {
  dataFoundationMetadata,
  handleDataPageError,
  invalidDataPageRequest,
} from '@/lib/data-foundation-page.server';
import { getDictionary, isLocale } from '@/lib/i18n';
import { IngestionCandidateReader } from '@/components/ingestion-candidate-reader';
import type { IngestionCandidateReference } from '@wiser/data-contracts';
import { candidateWorkspaceHref } from '@/lib/candidate-workspace-route';

interface IngestionPageProps {
  readonly params: Promise<{ locale: string; ingestionId: string }>;
  readonly searchParams?: Promise<{
    candidateView?: string | string[];
    candidateTopic?: string | string[];
    supplementIngestionId?: string | string[];
    followupId?: string | string[];
  }>;
}

export async function generateMetadata({ params }: IngestionPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return dataFoundationMetadata(
    locale,
    getDictionary(locale).dataFoundation.ingestionPage.metaTitle,
  );
}

export default async function IngestionPage({
  params,
  searchParams,
}: IngestionPageProps) {
  const { ingestionId: rawIngestionId, locale } = await params;
  if (!isLocale(locale)) notFound();
  const copy = getDictionary(locale).dataFoundation;
  const ingestionId = parseDataRouteUuid(rawIngestionId);
  let route = `/${locale}/data-foundation/ingestions/${rawIngestionId}`;
  let ingestion: IngestionDto | undefined;
  let candidateReference: IngestionCandidateReference | null = null;
  let savedViewId: string | undefined;
  let savedTopicId: string | undefined;
  let supplementLookup: CandidateSupplementLookup | undefined;
  let failure: ReturnType<typeof handleDataPageError> | undefined;
  try {
    if (ingestionId === null) throw invalidDataPageRequest();
    const query = await searchParams;
    const supplementary = query?.supplementIngestionId;
    const followup = query?.followupId;
    if (
      (supplementary !== undefined || followup !== undefined) &&
      (query?.candidateView !== undefined ||
        query?.candidateTopic !== undefined)
    )
      throw invalidDataPageRequest();
    if (
      supplementary !== undefined &&
      (typeof supplementary !== 'string' ||
        (supplementary !== '' && parseDataRouteUuid(supplementary) === null))
    )
      throw invalidDataPageRequest();
    if (
      followup !== undefined &&
      (typeof followup !== 'string' || parseDataRouteUuid(followup) === null)
    )
      throw invalidDataPageRequest();
    const supplementId =
      typeof supplementary === 'string' && supplementary
        ? parseDataRouteUuid(supplementary)!
        : undefined;
    const initialFollowupId =
      typeof followup === 'string' ? parseDataRouteUuid(followup)! : undefined;
    const supplementAction = route;
    const supplementaryQuery = new URLSearchParams();
    if (supplementId)
      supplementaryQuery.set('supplementIngestionId', supplementId);
    if (initialFollowupId)
      supplementaryQuery.set('followupId', initialFollowupId);
    if (supplementaryQuery.size) route += '?' + supplementaryQuery.toString();
    if (query?.candidateTopic !== undefined) {
      if (
        query.candidateView !== undefined ||
        typeof query.candidateTopic !== 'string'
      )
        throw invalidDataPageRequest();
      const topicId = parseDataRouteUuid(query.candidateTopic);
      if (topicId === null) throw invalidDataPageRequest();
      savedTopicId = topicId;
      route += `?candidateTopic=${topicId}`;
    }
    if (query?.candidateView !== undefined) {
      if (typeof query.candidateView !== 'string')
        throw invalidDataPageRequest();
      const viewId = parseDataRouteUuid(query.candidateView);
      if (viewId === null) throw invalidDataPageRequest();
      savedViewId = viewId;
      route += `?candidateView=${viewId}`;
    }
    if (savedTopicId === undefined) {
      const dal = await getDataFoundationDal();
      const detail = await dal.ingestionDetail(ingestionId);
      ingestion = detail.ingestion;
      candidateReference = detail.candidateReference;
      if (savedViewId === undefined && candidateReference !== null) {
        supplementLookup = {
          action: supplementAction,
          requestedIngestionId: supplementId ?? '',
          ...(initialFollowupId ? { initialFollowupId } : {}),
        };
        if (supplementId) {
          try {
            const extra =
              supplementId === ingestionId
                ? detail
                : await dal.ingestionDetail(supplementId);
            supplementLookup =
              extra.candidateReference === null
                ? { ...supplementLookup, error: 'empty' }
                : {
                    ...supplementLookup,
                    verificationId: randomUUID(),
                    source: {
                      reference: extra.candidateReference,
                      label: extra.ingestion.ingestionId,
                    },
                    stateLabel: copy.status.ingestion[extra.ingestion.state],
                  };
          } catch (error) {
            if (
              error instanceof DataFoundationApiError &&
              error.kind === 'authentication'
            )
              throw error;
            supplementLookup = {
              ...supplementLookup,
              error:
                error instanceof DataFoundationApiError &&
                error.kind === 'authorization'
                  ? 'denied'
                  : error instanceof DataFoundationApiError &&
                      error.kind === 'not-found'
                    ? 'stale'
                    : 'unavailable',
            };
          }
        }
      }
    }
  } catch (error) {
    failure = handleDataPageError(error, locale, route);
  }

  return (
    <DataPageMain>
      <DataPageHeader
        eyebrow={copy.ingestionPage.eyebrow}
        title={copy.ingestionPage.title}
        lede={copy.ingestionPage.lede}
        aside={<AuthorityFlag locale={locale} />}
      />
      {failure === undefined ? null : (
        <DataFailureState locale={locale} error={failure} />
      )}
      {failure === undefined &&
      savedTopicId !== undefined &&
      ingestionId !== null ? (
        <IngestionCandidateReader
          locale={locale}
          reference={null}
          savedTopicId={savedTopicId}
          ingestionId={ingestionId}
        />
      ) : null}
      {ingestion === undefined ? null : (
        <>
          {candidateReference === null || savedViewId !== undefined ? null : (
            <p>
              <Link href={candidateWorkspaceHref(locale, candidateReference)}>
                {copy.candidateReader.openWorkspace}
              </Link>
            </p>
          )}
          <IngestionCandidateReader
            locale={locale}
            reference={candidateReference}
            savedViewId={savedViewId}
            ingestionId={ingestion.ingestionId}
            {...(supplementLookup ? { supplementLookup } : {})}
          />
          <DataSection>
            <SectionHeading title={copy.ingestionPage.authorityTitle} />
            <FieldGrid
              fields={[
                {
                  label: copy.common.ingestionId,
                  value: <ProtocolValue>{ingestion.ingestionId}</ProtocolValue>,
                },
                {
                  label: copy.common.state,
                  value: (
                    <StatusBadge
                      code={ingestion.state}
                      label={copy.status.ingestion[ingestion.state]}
                    />
                  ),
                },
                {
                  label: copy.common.security,
                  value: (
                    <StatusBadge
                      code={ingestion.requestedSecurityLevel}
                      label={
                        copy.status.security[ingestion.requestedSecurityLevel]
                      }
                    />
                  ),
                },
                {
                  label: copy.common.ownerProject,
                  value: copy.common.liveData,
                },
                {
                  label: copy.common.assetIds,
                  value: ingestion.assetIds.length,
                },
                {
                  label: copy.common.intendedUses,
                  value: ingestion.intendedUses.join(' · '),
                },
                {
                  label: copy.common.version,
                  value: <ProtocolValue>v{ingestion.version}</ProtocolValue>,
                },
                {
                  label: copy.common.createdAt,
                  value: formatDataDate(ingestion.createdAt, locale),
                },
                {
                  label: copy.common.updatedAt,
                  value: formatDataDate(ingestion.updatedAt, locale),
                },
              ]}
            />
            {ingestion.operationId === undefined ? null : (
              <Link
                href={`/${locale}/data-foundation/operations/${ingestion.operationId}`}
              >
                {copy.common.openOperation}
              </Link>
            )}
          </DataSection>
          <DataSection>
            <SectionHeading title={copy.ingestionPage.stateMachineTitle} />
            <IngestionStateRail locale={locale} state={ingestion.state} />
          </DataSection>
          <DataSection>
            <SectionHeading title={copy.ingestionPage.runtimeTitle} />
            <IngestionRuntimeSummaries ingestion={ingestion} locale={locale} />
          </DataSection>
        </>
      )}
    </DataPageMain>
  );
}
