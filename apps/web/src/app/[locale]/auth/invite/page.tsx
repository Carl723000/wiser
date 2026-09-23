import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { safeLocalizedRedirect } from '@/lib/auth';
import { validInvitationHash } from '@/lib/auth-invitation';
import { getDictionary, isLocale } from '@/lib/i18n';
import styles from '../../login/page.module.css';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function InvitationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const token = typeof query.token_hash === 'string' ? query.token_hash : null;
  const valid = validInvitationHash(token);
  const next = safeLocalizedRedirect(
    typeof query.next === 'string' ? query.next : null,
    locale,
  );
  const text = getDictionary(locale).auth.invitation;
  return (
    <main id="main-content" className={styles.main}>
      <section className={styles.thesis}>
        <h1>
          {valid
            ? text.title
            : query.reason === 'unavailable'
              ? text.unavailableTitle
              : text.invalidTitle}
        </h1>
        <p className={styles.lede}>
          {valid ? text.description : text.recovery}
        </p>
      </section>
      <section className={styles.formPanel}>
        {valid ? (
          <form
            action={`/${locale}/auth/accept`}
            method="post"
            className={styles.form}
          >
            <input type="hidden" name="token_hash" value={token} />
            <input type="hidden" name="next" value={next} />
            <p>{text.confirmation}</p>
            <button type="submit">{text.accept}</button>
          </form>
        ) : (
          <p role="alert">
            {query.reason === 'unavailable' ? text.unavailable : text.recovery}
          </p>
        )}
        <p>
          <Link href={`/${locale}/login`}>
            {getDictionary(locale).auth.signIn}
          </Link>
        </p>
      </section>
    </main>
  );
}
