import { connection } from 'next/server';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { readVerifiedAuthViewer } from '@/lib/auth';
import { getDictionary, isLocale } from '@/lib/i18n';
import { createWiserServerSupabaseClient } from '@/lib/supabase/server';
import { getProjectAccessClient } from '@/lib/project-access.server';
import { ProjectAccessWorkspace } from '@/components/project-access-workspace';
import styles from '@/components/project-access-workspace.module.css';
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function ProjectAccessPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await connection();
  if (process.env.WISER_PROJECT_ACCESS_ENABLED !== 'true') notFound();
  const client = await createWiserServerSupabaseClient();
  const viewer = client ? await readVerifiedAuthViewer(client) : null;
  if (!viewer)
    redirect(
      `/${locale}/login?next=${encodeURIComponent(`/${locale}/account/access`)}`,
    );
  const t = getDictionary(locale).projectAccess;
  let initial;
  try {
    initial = await getProjectAccessClient().projects({
      offset: 0,
      limit: 20,
      search: '',
    });
  } catch {
    return (
      <main id="main-content" className={styles.workspace}>
        <h1>{t.title}</h1>
        <p role="alert">{t.unavailable}</p>
        <Link href={`/${locale}/account/access`}>{t.retry}</Link>
      </main>
    );
  }
  return (
    <ProjectAccessWorkspace
      locale={locale}
      initial={initial}
      environmentLabel={
        process.env.WISER_ACCESS_ENVIRONMENT === 'local'
          ? t.localEnvironment
          : t.currentEnvironment
      }
    />
  );
}
