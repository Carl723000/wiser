import { isDeepStrictEqual } from 'node:util';
import { expect, type Page } from '@playwright/test';
import { candidateSavedReferenceKey } from '@wiser/data-contracts';
import type {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateGeometryPageSchema,
  OpenIngestionCandidateViewOutputSchema,
} from '@wiser/data-contracts';
import type { getDictionary } from '../../src/lib/i18n';

type CandidateBackflowCopy = ReturnType<typeof getDictionary>['dataFoundation'];
export interface CandidateBackflowSnapshot {
  saved: ReturnType<typeof OpenIngestionCandidateViewOutputSchema.parse>;
  material:
    | ReturnType<typeof IngestionCandidateAssetPageSchema.parse>
    | ReturnType<typeof IngestionCandidateRecordPageSchema.parse>
    | ReturnType<typeof IngestionCandidateGeometryPageSchema.parse>;
}

export interface CandidateBackflowTarget {
  readonly origin: string;
  readonly destination: string;
  readonly locale: 'zh-CN' | 'en';
  readonly ingestionId: string;
  readonly viewId: string;
}

/** Reporter preflight: real login values must never reach a step-persisting reporter. */
export function assertCandidateBackflowReporter(
  reporters: readonly (readonly [string, unknown?])[],
): void {
  if (reporters.length !== 1 || reporters[0]?.[0] !== 'list') {
    throw Error('This case requires the sole list reporter (not_run).');
  }
}

/** Test input only. A URL is not evidence that its resources exist or are readable. */
export function readCandidateBackflowTarget(
  baseUrl: string | undefined,
  serialized: string | undefined,
): CandidateBackflowTarget {
  const failure = () =>
    Error('A same-origin local fixed candidate URL is required (not_run).');
  if (!baseUrl || !serialized) throw failure();
  try {
    const base = new URL(baseUrl);
    const target = new URL(serialized);
    const local = (url: URL) =>
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '';
    const uuid =
      '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    const match = new RegExp(
      `^/(zh-CN|en)/data-foundation/ingestions/(${uuid})$`,
    ).exec(target.pathname);
    const views = target.searchParams.getAll('candidateView');
    const viewId = views[0];
    const locale = match?.[1];
    const ingestionId = match?.[2];
    if (
      !local(base) ||
      !local(target) ||
      (baseUrl !== base.origin && baseUrl !== base.origin + '/') ||
      target.origin !== base.origin ||
      !match ||
      (locale !== 'zh-CN' && locale !== 'en') ||
      !ingestionId ||
      views.length !== 1 ||
      !viewId ||
      !new RegExp(`^${uuid}$`).test(viewId) ||
      serialized !==
        `${target.origin}${target.pathname}?candidateView=${viewId}`
    )
      throw failure();
    return Object.freeze({
      origin: target.origin,
      destination: target.pathname + target.search,
      locale,
      ingestionId,
      viewId,
    });
  } catch {
    throw failure();
  }
}

function recordCell(
  value: unknown,
  present: boolean,
  copy: CandidateBackflowCopy,
): string {
  if (!present) return copy.candidateReader.valueAbsent;
  if (value === null) return copy.candidateReader.valueNull;
  if (value === '') return copy.candidateReader.valueEmpty;
  if (typeof value === 'object') return JSON.stringify(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  throw Error('The public original cell has an unsupported shape.');
}
export async function visibleFixedPage(
  page: Page,
  current: CandidateBackflowSnapshot,
  copy: CandidateBackflowCopy,
  timeout = 30_000,
) {
  const reader = page.getByRole('region', {
    name: copy.candidateReader.title,
    exact: true,
  });
  const kind = current.saved.viewSpec.page.kind;
  const tab =
    kind === 'assets' ? 'originals' : kind === 'records' ? 'records' : 'map';
  await expect
    .poll(
      async () => {
        const gate = reader.locator(':scope > div[aria-busy]');
        if (
          (await gate.count()) !== 1 ||
          !(await gate.isVisible()) ||
          (await gate.getAttribute('inert')) !== null ||
          (await gate.getAttribute('aria-busy')) === 'true' ||
          !(await reader
            .locator(':scope > header')
            .getByRole('button', {
              name: copy.candidateReader.refresh,
              exact: true,
            })
            .isEnabled()) ||
          (
            await reader.locator(':scope > p[role="status"]').allTextContents()
          ).includes(copy.candidateReader.loading)
        )
          return false;
        const technical = gate.locator(':scope > details > dl');
        if (
          (await technical.count()) !== 1 ||
          !isDeepStrictEqual(
            (await technical.locator('dt').allTextContents()).slice(0, 2),
            [
              copy.candidateReader.processingBatch,
              copy.candidateReader.reviewHash,
            ],
          ) ||
          !isDeepStrictEqual(
            (await technical.locator('dd').allTextContents()).slice(0, 2),
            [
              current.saved.request.input.processingBatchId,
              current.saved.request.input.reviewHash,
            ],
          )
        )
          return false;
        const title = await reader
          .getByLabel(copy.candidateReader.viewName, { exact: true })
          .inputValue();
        const selected = await reader
          .getByRole('tab', { name: copy.candidateReader[tab], exact: true })
          .getAttribute('aria-selected');
        const panel = reader.locator('[role="tabpanel"]:not([hidden])');
        if (
          title !== current.saved.savedView.title ||
          selected !== 'true' ||
          (await panel.count()) !== 1 ||
          !(await panel.isVisible()) ||
          !(await panel.getAttribute('id')) ||
          (await panel.getAttribute('id')) !==
            (await reader
              .getByRole('tab', {
                name: copy.candidateReader[tab],
                exact: true,
              })
              .getAttribute('aria-controls'))
        )
          return false;
        const material = current.material;
        const focus = current.saved.viewSpec.focus;
        const focusId =
          focus &&
          candidateSavedReferenceKey(focus.reference) ===
            candidateSavedReferenceKey(material.reference) &&
          'assetId' in material &&
          focus.assetId.toLowerCase() === material.assetId.toLowerCase()
            ? focus.recordId?.toLowerCase()
            : undefined;
        if ('assets' in material) {
          const rows = panel.locator(':scope > ul > li');
          if ((await rows.count()) !== material.assets.length) return false;
          for (const [index, asset] of material.assets.entries()) {
            const row = rows.nth(index);
            if (
              (await row.locator('strong').textContent()) !==
                `${copy.candidateReader.originals} ${index + 1}` ||
              (await row.locator('[data-state]').getAttribute('data-state')) !==
                asset.status ||
              !isDeepStrictEqual(
                await row.locator(':scope > dl dd').allTextContents(),
                [
                  String(asset.recordCount ?? copy.candidateReader.unknown),
                  String(asset.featureCount ?? copy.candidateReader.unknown),
                ],
              ) ||
              !isDeepStrictEqual(
                await row.locator('details dl > dd').allTextContents(),
                [asset.assetId, asset.sourceHash],
              )
            )
              return false;
          }
        } else if ('records' in material) {
          const rows = panel.locator('tbody > tr');
          if (
            (await rows.count()) !== material.records.length ||
            !isDeepStrictEqual(
              await panel.locator('thead th').allTextContents(),
              [
                copy.candidateReader.row,
                ...material.columns.map((column) => column.label),
                copy.candidateReader.locator,
              ],
            )
          )
            return false;
          for (const [index, record] of material.records.entries()) {
            const row = rows.nth(index);
            const selectedRecord = record.recordId.toLowerCase() === focusId;
            if (
              (await row.locator('th button').textContent()) !==
                String(record.index) ||
              (await row.locator('th button').getAttribute('aria-pressed')) !==
                String(selectedRecord) ||
              (await row.getAttribute('data-selected')) !==
                String(selectedRecord) ||
              !isDeepStrictEqual(await row.locator('td').allTextContents(), [
                ...material.columns.map((column) =>
                  recordCell(
                    record.values[column.key],
                    Object.hasOwn(record.values, column.key),
                    copy,
                  ),
                ),
                record.sourceId ?? copy.candidateReader.locationUnknown,
              ])
            )
              return false;
          }
        } else {
          const rows = panel.locator(':scope > ul > li');
          if ((await rows.count()) !== material.features.length) return false;
          for (const [index, feature] of material.features.entries()) {
            const row = rows.nth(index);
            if (
              (await row.locator('button').textContent()) !==
                `${copy.candidateReader.selectRecord} ${feature.index} · ${copy.candidateReader.geometryKinds[feature.geometry.type]}` ||
              (await row.locator('button').getAttribute('aria-pressed')) !==
                String(feature.recordId.toLowerCase() === focusId) ||
              (await row.locator(':scope > span').textContent()) !==
                (feature.sourceId ?? copy.candidateReader.locationUnknown)
            )
              return false;
          }
        }
        return true;
      },
      {
        timeout,
        message: 'The authorized fixed material page was not restored.',
      },
    )
    .toBe(true);
}
