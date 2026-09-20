import { Suspense } from 'react';
import { DataOverviewStatus } from '@/components/data-overview-status';
import { notFound } from 'next/navigation';
import { DataExplorer } from '@/components/data-explorer';
import { dataFoundationMetadata } from '@/lib/data-foundation-page.server';
import { getDictionary, isLocale } from '@/lib/i18n';
import {
  loadExploration,
  type ExplorationEntryProps,
} from '@/lib/load-exploration.server';

export async function generateMetadata({ params }: ExplorationEntryProps) {
  const { locale } = await params;
  return isLocale(locale)
    ? dataFoundationMetadata(
        locale,
        getDictionary(locale).dataFoundation.explorer.title,
      )
    : {};
}
export default async function ExplorePage({
  params,
  searchParams,
}: ExplorationEntryProps) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();
  const initial = await loadExploration(locale, search);
  return (
    <DataExplorer
      {...initial}
      supplementary={
        <Suspense fallback={null}>
          <DataOverviewStatus locale={locale} />
        </Suspense>
      }
    />
  );
}
