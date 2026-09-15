import { RelationAssertionSchema } from '@wiser/data-contracts';
import type { Locale } from './i18n';
const uuid = RelationAssertionSchema.shape.versionId;
type VersionSearch = {
  version?: string | string[];
  versionId?: string | string[];
};
/** The legacy alias is accepted only when unambiguous; malformed pins never fall back to latest. */
export function readCatalogVersion(
  input: VersionSearch | URLSearchParams,
): string | undefined | null {
  const search: VersionSearch =
    input instanceof URLSearchParams
      ? Object.fromEntries(
          ['version', 'versionId'].map((key) => {
            const values = input.getAll(key);
            return [key, values.length > 1 ? values : values[0]];
          }),
        )
      : input;
  const values = [search.version, search.versionId].filter(
    (v) => v !== undefined,
  );
  if (!values.length) return undefined;
  if (values.some((v) => typeof v !== 'string' || !uuid.safeParse(v).success))
    return null;
  return new Set(values).size === 1 ? (values[0] as string) : null;
}
export function catalogHref(
  locale: Locale,
  dataItemId: string,
  versionId: string,
) {
  return `/${locale}/data-foundation/catalog/${uuid.parse(dataItemId)}?version=${uuid.parse(versionId)}`;
}
