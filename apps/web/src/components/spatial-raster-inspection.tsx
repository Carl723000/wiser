'use client';

import type { WorkspacePack } from '@/lib/spatial-workspace-contract';
import type { Dictionary } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import styles from './spatial-workspace-shell.module.css';

export function SpatialRasterInspection({
  pack,
  copy,
}: {
  pack: WorkspacePack;
  copy: Dictionary['dataFoundation']['spatialManagement'];
}) {
  return (
    <section aria-label={copy.raster}>
      <h2>{copy.raster}</h2>
      {pack.rasterReports.length === 0 ? (
        <p>{copy.noRaster}</p>
      ) : (
        pack.rasterReports.map((report) => (
          <article key={report.id} className={styles.card}>
            <h3>{report.title}</h3>
            <p>
              <strong>{copy.acquired}</strong>{' '}
              {report.acquiredAt ?? copy.unknown} ·{' '}
              <strong>{copy.scene}</strong> {report.sceneId}
            </p>
            <p className={styles.status}>
              {copy.oneScene}{' '}
              <ContextHelp label={copy.rasterHelp}>
                {copy.rasterHelpText}
              </ContextHelp>
            </p>
            <div className={styles.tableScroll}>
              <table>
                <caption>{copy.products}</caption>
                <thead>
                  <tr>
                    <th>{copy.band}</th>
                    <th>{copy.dimensions}</th>
                    <th>{copy.resolution}</th>
                    <th>{copy.range}</th>
                    <th>{copy.validPixels}</th>
                    <th>{copy.noData}</th>
                    <th>{copy.hash}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.products.map((product) => (
                    <tr key={product.band}>
                      <th>{product.band}</th>
                      <td>
                        {product.width} × {product.height} · {product.channels}
                      </td>
                      <td>
                        {product.resolution?.join(' × ') ?? copy.unknown} ·{' '}
                        {product.nativeCrs ?? copy.unknown}
                      </td>
                      <td>
                        {product.stats.min} — {product.stats.max}
                      </td>
                      <td>{product.stats.validPixels.toLocaleString()}</td>
                      <td>{product.stats.noDataPixels.toLocaleString()}</td>
                      <td>
                        {product.hashMatches ? copy.matched : copy.mismatched}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.products}>
              {report.products.map((product) => (
                <section className={styles.product} key={product.band}>
                  <h4>{product.band}</h4>
                  {product.thumbnailUrl ? (
                    <img
                      src={product.thumbnailUrl}
                      alt={`${report.title} · ${product.band}`}
                      width={320}
                      height={260}
                      loading="lazy"
                    />
                  ) : (
                    <p>{copy.noThumbnail}</p>
                  )}
                  <p>
                    {copy.scale} {product.scales.join(', ')} · {copy.offset}{' '}
                    {product.offsets.join(', ')}
                  </p>
                  {product.classFrequency ? (
                    <details>
                      <summary>{copy.classes}</summary>
                      <dl>
                        {Object.entries(product.classFrequency).map(
                          ([id, count]) => (
                            <div key={id}>
                              <dt>{id}</dt>
                              <dd>{count.toLocaleString()}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </details>
                  ) : null}
                </section>
              ))}
            </div>
            <details>
              <summary>{copy.limitations}</summary>
              <ul>
                {report.limitations.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
              <p>{report.rights.note}</p>
            </details>
          </article>
        ))
      )}
    </section>
  );
}
