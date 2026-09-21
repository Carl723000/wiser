import { connection } from 'next/server';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { readVerifiedAuthViewer, safeLocalizedRedirect } from '@/lib/auth';
import { getDictionary, isLocale } from '@/lib/i18n';
import { createWiserServerSupabaseClient } from '@/lib/supabase/server';
import styles from '../../login/page.module.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function PasswordPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await connection();
  const client = await createWiserServerSupabaseClient();
  const viewer = client ? await readVerifiedAuthViewer(client) : null;
  if (!viewer)
    redirect(
      `/${locale}/login?next=${encodeURIComponent(`/${locale}/account/password`)}`,
    );
  const query = await searchParams;
  const next = safeLocalizedRedirect(
    typeof query.next === 'string' ? query.next : null,
    locale,
  );
  const text = getDictionary(locale).auth.ownPassword;
  const reason =
    query.reason === 'fields'
      ? text.fields
      : query.reason === 'unavailable'
        ? text.unavailable
        : query.reason === 'signout'
          ? text.signout
          : null;
  return (
    <main id="main-content" className={styles.main}>
      <section className={styles.thesis}>
        <h1>{text.title}</h1>
        <p className={styles.lede}>{text.description}</p>
      </section>
      <section className={styles.formPanel}>
        <p>{viewer.email ?? getDictionary(locale).auth.signedIn}</p>
        {reason ? (
          <p className={styles.error} role="alert" id="password-feedback">
            {reason}
          </p>
        ) : null}
        <form
          className={styles.form}
          action={`/${locale}/auth/password`}
          method="post"
          aria-describedby={reason ? 'password-feedback' : undefined}
        >
          <input type="hidden" name="next" value={next} />
          <label>
            <span>{text.password}</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={4096}
              required
              aria-describedby="password-guidance"
            />
          </label>
          <label>
            <span>{text.confirmation}</span>
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={4096}
              required
            />
          </label>
          <p id="password-guidance" className={styles.hint}>
            {text.hint}
          </p>
          <button type="submit">{text.save}</button>
        </form>
        <p>
          <Link href={`/${locale}/login`}>
            {getDictionary(locale).auth.signIn}
          </Link>
        </p>
      </section>
    </main>
  );
}
