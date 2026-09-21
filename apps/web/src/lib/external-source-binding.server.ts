import 'server-only';
import { parseDataRouteUuid } from './data-foundation';
type Binding = {
  tenantId: string;
  projectId: string;
  dataItemId: string;
  sourceId: string;
};
const keys = ['tenantId', 'projectId', 'dataItemId', 'sourceId'] as const;
function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === keys.length &&
    keys.every(
      (key) =>
        typeof row[key] === 'string' && parseDataRouteUuid(row[key]) !== null,
    )
  );
}
/** Host-owned navigation mapping, never an access grant. Call only after catalog authorization. */
export function externalSourceBinding(
  value: string | undefined,
  scope: { tenantId: string; projectId: string },
  dataItemId: string,
): { sourceId: string } | null {
  if (!value || value.length > 32768) return null;
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 100 || !rows.every(validBinding))
      return null;
    const identities = rows.map((row) =>
      JSON.stringify([row.tenantId, row.projectId, row.dataItemId]),
    );
    if (new Set(identities).size !== identities.length) return null;
    const match = rows.find(
      (row) =>
        row.tenantId === scope.tenantId &&
        row.projectId === scope.projectId &&
        row.dataItemId === dataItemId,
    );
    return match ? { sourceId: match.sourceId } : null;
  } catch {
    return null;
  }
}
