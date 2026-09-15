/** Display-only state: never changes the authorized business query. */
export function readBusinessReading(search: Pick<URLSearchParams, 'getAll'>) {
  const pages = search.getAll('businessPage');
  const modes = search.getAll('businessPresentation');
  const page =
    pages.length === 1 && /^[1-9]\d{0,3}$/.test(pages[0])
      ? Number(pages[0])
      : 1;
  return {
    page,
    presentation:
      modes.length === 1 && modes[0] === 'network'
        ? ('network' as const)
        : ('reading' as const),
  };
}
export function readingPage<T>(rows: readonly T[], requested: number) {
  const count = Math.max(1, Math.ceil(rows.length / 6));
  const page = Math.max(1, Math.min(count, requested));
  return { page, count, rows: rows.slice((page - 1) * 6, page * 6) };
}
