import { notFound } from 'next/navigation';
import {
  OpenExplorationViewOutputSchema,
  type OpenExplorationViewOutput,
  ExplorationQueryInputSchema,
  type ExplorationResult,
  type ExplorationRecord,
} from '@wiser/data-contracts';
import { DataExplorer } from '@/components/data-explorer';
import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import {
  handleDataPageError,
  dataFoundationMetadata,
} from '@/lib/data-foundation-page.server';
import { getDictionary, isLocale } from '@/lib/i18n';
import {
  readRecordFocus,
  focusRecordRequest,
  checkedFocusedRecord,
} from '@/lib/exploration-record-focus';
import { explorationView } from '@/lib/exploration-navigation';

interface Props {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    saved?: string | string[];
    recordFocus?: string | string[];
    dataItem?: string | string[];
    version?: string | string[];
    q?: string | string[];
    query?: string | string[];
    quality?: string | string[];
    view?: string | string[];
  }>;
}
export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return isLocale(locale)
    ? dataFoundationMetadata(
        locale,
        getDictionary(locale).dataFoundation.explorer.title,
      )
    : {};
}
export default async function ExplorePage({ params, searchParams }: Props) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();
  let saved: OpenExplorationViewOutput | undefined;
  let result: ExplorationResult | null = null;
  let focusedRecord: ExplorationRecord | undefined;
  let failure: 'expired' | 'unavailable' | null = null;
  const text =
    typeof search.q === 'string' && search.q.length <= 512 ? search.q : '';
  try {
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
                ...(search.quality ? { qualityGrades: [search.quality] } : {}),
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
  return (
    <DataExplorer
      key={result?.queryId ?? 'unavailable'}
      initialSaved={saved}
      initialFocusedRecord={focusedRecord}
      locale={locale}
      initialResult={result}
      initialFailure={failure}
      initialText={text}
      initialView={saved?.viewSpec.activeView ?? explorationView(search.view)}
    />
  );
}
