import {
  DataFailureState,
  DataSection,
  MetricStrip,
  DataDisclosure,
  SectionHeading,
  WorkspaceLinks,
} from '@/components/data-foundation-workspace';
import { getDataFoundationDal } from '@/lib/data-foundation-dal.server';
import { handleDataPageError } from '@/lib/data-foundation-page.server';
import { getDictionary, type Locale } from '@/lib/i18n';

async function loadOverview() {
  const dal = await getDataFoundationDal();
  const [health, catalog, capabilities] = await Promise.all([
    dal.health(),
    dal.catalog({ first: 1, includeTotal: true }),
    dal.capabilities(),
  ]);
  return {
    health,
    catalogCount: catalog.totalCount ?? '—',
    capabilityCount: capabilities.capabilities.length,
  };
}

export async function DataOverviewStatus({
  locale,
}: {
  readonly locale: Locale;
}) {
  const copy = getDictionary(locale).dataFoundation;
  let result: Awaited<ReturnType<typeof loadOverview>> | undefined;
  let failure: ReturnType<typeof handleDataPageError> | undefined;
  try {
    result = await loadOverview();
  } catch (error) {
    failure = handleDataPageError(error, locale, `/${locale}/data-foundation`);
  }

  return (
    <>
      {failure === undefined ? null : (
        <DataFailureState locale={locale} error={failure} />
      )}
      {result === undefined ? null : (
        <>
          <DataSection>
            <SectionHeading title={copy.overviewPage.operatingTitle} />
            <WorkspaceLinks
              links={[
                {
                  href: `/${locale}/data-foundation/catalog`,
                  label: copy.overviewPage.catalogAction,
                  detail: copy.domains[0]?.copy ?? copy.common.notProvided,
                },
                {
                  href: `/${locale}/data-foundation/ingestions`,
                  label: copy.overviewPage.ingestionAction,
                  detail: copy.domains[1]?.copy ?? copy.common.notProvided,
                },
                {
                  href: `/${locale}/data-foundation/explore`,
                  label: copy.overviewPage.searchAction,
                  detail: copy.domains[2]?.copy ?? copy.common.notProvided,
                },
                {
                  href: `/${locale}/data-foundation/explore?view=map`,
                  label: copy.overviewPage.mapAction,
                  detail: copy.mapPage.lede,
                },
              ]}
            />
          </DataSection>
          <DataDisclosure
            title={copy.overviewPage.healthTitle}
            open={result.health.status !== 'ready'}
          >
            <MetricStrip
              metrics={[
                {
                  label: copy.common.state,
                  value:
                    result.health.status === 'ready'
                      ? copy.overviewPage.ready
                      : copy.overviewPage.degraded,
                  state:
                    result.health.status === 'ready' ? 'success' : 'warning',
                },
                {
                  label: copy.overviewPage.database,
                  value: result.health.database
                    ? copy.overviewPage.connected
                    : copy.overviewPage.disconnected,
                  state: result.health.database ? 'success' : 'danger',
                },
                {
                  label: copy.overviewPage.objectStore,
                  value: result.health.objectStore
                    ? copy.overviewPage.connected
                    : copy.overviewPage.disconnected,
                  state: result.health.objectStore ? 'success' : 'danger',
                },
                {
                  label: copy.overviewPage.worker,
                  value: result.health.worker
                    ? copy.overviewPage.connected
                    : copy.overviewPage.disconnected,
                  state: result.health.worker ? 'success' : 'danger',
                },
                {
                  label: copy.overviewPage.catalogCount,
                  value: result.catalogCount,
                },
                {
                  label: copy.overviewPage.capabilityCount,
                  value: result.capabilityCount,
                },
              ]}
            />
          </DataDisclosure>
        </>
      )}
    </>
  );
}
