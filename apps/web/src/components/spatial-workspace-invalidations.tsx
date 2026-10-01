import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import type { SpatialWorkspaceCopy } from '@/lib/spatial-workspace-copy';
import type { WorkspaceInvalidation } from '@/lib/spatial-workspace-view';
import styles from './spatial-workspace.module.css';

export function SpatialWorkspaceInvalidations({
  pack,
  copy,
  notices,
}: {
  pack: WorkspacePack;
  copy: SpatialWorkspaceCopy;
  notices: readonly WorkspaceInvalidation[];
}) {
  const labels = {
    stale: copy.stale,
    revoked: copy.revoked,
    missing: copy.sourceMissing,
  };
  return notices.length ? (
    <div
      className={styles.invalidationNotices}
      role="note"
      aria-live="polite"
      data-testid="spatial-invalidation-notice"
    >
      {notices.map((notice, index) => {
        const source = pack.sources.find(
          (item) =>
            item.id === notice.sourceId &&
            (!notice.versionId || item.versionId === notice.versionId),
        );
        const reason =
          notice.state === 'stale' && source?.rights.displayAllowed
            ? notice.reason
            : null;
        return (
          <div key={index}>
            <strong>{labels[notice.state]}</strong>
            {reason ? <p>{reason}</p> : null}
          </div>
        );
      })}
    </div>
  ) : null;
}
