'use client';
import type { RelationAssertion } from '@wiser/data-contracts';
import type { Locale } from '@/lib/i18n';
import type { InvalidateExploration } from '@/lib/exploration-request';
export function DataExplorerRecordSources(_props: {
  readonly locale: Locale;
  readonly queryId: string;
  readonly status: RelationAssertion['status'];
  readonly versionId: string | null;
  readonly onInvalidated: InvalidateExploration;
}) {
  return null;
}
