import {
  OpenExplorationViewOutputSchema,
  type OpenExplorationViewOutput,
  ExplorationQueryInputSchema,
  type ExplorationResult,
  type ExplorationRecord,
} from '@wiser/data-contracts';
import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import { handleDataPageError } from '@/lib/data-foundation-page.server';
import type { Locale } from '@/lib/i18n';
import {
  readRecordFocus,
  focusRecordRequest,
  checkedFocusedRecord,
} from '@/lib/exploration-record-focus';
import { explorationView } from '@/lib/exploration-navigation';

export interface ExplorationSearch {
  saved?: string | string[];
  recordFocus?: string | string[];
  dataItem?: string | string[];
  version?: string | string[];
  q?: string | string[];
  query?: string | string[];
  quality?: string | string[];
  view?: string | string[];
}
export interface ExplorationEntryProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<ExplorationSearch>;
}

export async function loadExploration(
  locale: Locale,
  search: ExplorationSearch,
) {
  let saved: OpenExplorationViewOutput | undefined;
  let result: ExplorationResult | null = null;
  let focusedRecord: ExplorationRecord | undefined;
  let failure: 'expired' | 'unavailable' | null = null;
  const text =
    typeof search.q === 'string' && search.q.length <= 512 ? search.q : '';
  const quality =
    typeof search.quality === 'string' ? search.quality.trim() : search.quality;
  const projectDefault =
    ['saved', 'recordFocus', 'dataItem', 'version', 'query'].every(
      (key) => search[key as keyof ExplorationSearch] === undefined,
    ) &&
    [search.q, search.quality].every(
      (value) =>
        value === undefined ||
        (typeof value === 'string' && value.trim() === ''),
    );
  try {
    if (
      search.q !== undefined &&
      (typeof search.q !== 'string' || search.q.length > 512)
    )
      throw new DataFoundationApiError('invalid-request', 422);
    const focus = readRecordFocus(search.recordFocus);
    if (focus && search.saved !== undefined)
      throw new DataFoundationApiError('invalid-request', 422);
    if (
      (search.dataItem !== undefined || search.version !== undefined) &&
      (search.saved !== undefined || search.query !== undefined)
    )
      throw new DataFoundationApiError('invalid-request', 422);
    if (search.saved !== undefined) {
      saved = OpenExplorationViewOutputSchema.parse(
        await (
          await getDataFoundationDal()
        ).explorationView('open', { viewId: search.saved }),
      );
      result = saved.result;
    } else {
      const input = ExplorationQueryInputSchema.safeParse({
        ...(search.query === undefined
          ? {
              spec: {
                ...(projectDefault
                  ? {
                      scope: 'project',
                      businessQuery: {
                        schemaVersion: 2,
                        status: 'APPROVED_AND_PENDING',
                        revisionMode: 'current',
                        filters: {
                          kind: 'ALL',
                          timeRole: 'ALL',
                          from: null,
                          to: null,
                          includeUndated: true,
                        },
                      },
                    }
                  : {}),
                ...(search.dataItem !== undefined ||
                search.version !== undefined
                  ? {
                      versions: [
                        {
                          dataItemId: search.dataItem,
                          versionId: search.version,
                        },
                      ],
                    }
                  : {}),
                ...(text.trim() ? { text: text.trim() } : {}),
                ...(quality ? { qualityGrades: [quality] } : {}),
              },
            }
          : { queryId: search.query }),
        view: 'resources',
        first: 25,
      });
      if (!input.success)
        throw new DataFoundationApiError('invalid-request', 422);
      const dal = await getDataFoundationDal();
      result = await dal.explore(input.data);
      if (focus)
        focusedRecord = checkedFocusedRecord(
          await dal.explore(focusRecordRequest(result.queryId, focus)),
          focus,
        );
    }
  } catch (error) {
    result = null;
    saved = undefined;
    focusedRecord = undefined;
    if (
      error instanceof DataFoundationApiError &&
      error.kind === 'authentication'
    )
      handleDataPageError(error, locale, `/${locale}/data-foundation/explore`);
    failure =
      error instanceof DataFoundationApiError &&
      [404, 409, 422].includes(error.status)
        ? 'expired'
        : 'unavailable';
  }
  return {
    initialSaved: saved,
    initialFocusedRecord: focusedRecord,
    locale,
    initialResult: result,
    initialFailure: failure,
    initialText: text,
    initialView:
      saved?.viewSpec.activeView ??
      (search.view === undefined && projectDefault
        ? ('graph' as const)
        : explorationView(search.view)),
  };
}
