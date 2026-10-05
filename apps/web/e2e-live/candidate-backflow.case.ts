import { isDeepStrictEqual } from 'node:util';
import { expect, test, type Request, type Response } from '@playwright/test';
import {
  candidateSavedReferenceKey,
  IngestionCandidateAssetPageSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateReadInputSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateRecordsInputSchema,
  OpenIngestionCandidateViewOutputSchema,
  OperationEventPageSchema,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { getDictionary } from '../src/lib/i18n';
import {
  assertCandidateBackflowReporter,
  readCandidateBackflowTarget,
  visibleFixedPage,
} from './support/candidate-backflow-fixture';
import { loadLiveCredentials } from './support/live-fixture';

// This must come from a real saved-view HTTP receipt in the selected local stack.
// The discovery regression supplies an explicitly synthetic URL for --list only.
const target = readCandidateBackflowTarget(
  process.env['WISER_WEB_LIVE_BASE_URL'],
  process.env['WISER_WEB_LIVE_CANDIDATE_VIEW_URL'],
);
const credentials = loadLiveCredentials();
const copy = getDictionary(target.locale).dataFoundation;
// The installed runner otherwise persists a failure ariaSnapshot even with trace off.
// This worker-local switch omits live DOM material from its error-context attachment.
process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

type Saved = ReturnType<typeof OpenIngestionCandidateViewOutputSchema.parse>;
type Material =
  | ReturnType<typeof IngestionCandidateAssetPageSchema.parse>
  | ReturnType<typeof IngestionCandidateRecordPageSchema.parse>
  | ReturnType<typeof IngestionCandidateGeometryPageSchema.parse>;
type Action = 'open' | 'get' | 'records' | 'geometry';
interface Round {
  failed: boolean;
  opens: { order: number; value: Saved }[];
  materials: {
    order: number;
    action: Exclude<Action, 'open'>;
    input: unknown;
    value: Material;
  }[];
}
interface Snapshot {
  saved: Saved;
  material: Material;
}
function requireCondition(value: boolean, message: string): asserts value {
  if (!value) throw Error(message);
}
async function safeStep<T>(
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch {
    // Discard upstream error/call logs, response values, URLs and filled credentials.
    throw Error(message);
  }
}
async function json(response: Response, maximum: number): Promise<unknown> {
  requireCondition(response.ok(), 'Current authorized HTTP read failed.');
  requireCondition(
    /^application\/json(?:\s*;|$)/i.test(
      response.headers()['content-type'] ?? '',
    ),
    'HTTP response is not JSON.',
  );
  const bytes = await response.body();
  requireCondition(
    bytes.length <= maximum,
    'HTTP response exceeds the existing reader boundary.',
  );
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown;
}
function snapshot(round: Round): Snapshot | null {
  if (round.failed) return null;
  for (const material of round.materials) {
    const opened = round.opens.find(
      (entry) =>
        entry.order < material.order &&
        entry.value.request.capabilityId ===
          (material.action === 'get'
            ? 'data.ingestion.candidate.get'
            : material.action === 'records'
              ? 'data.ingestion.candidate.records'
              : 'data.ingestion.candidate.geometry') &&
        isDeepStrictEqual(entry.value.request.input, material.input),
    );
    if (!opened) continue;
    const confirmed = round.opens.find(
      (entry) =>
        entry.order > material.order &&
        candidateSavedReferenceKey(entry.value.request.input) ===
          candidateSavedReferenceKey(material.value.reference) &&
        isDeepStrictEqual(
          fixedRequest(entry.value),
          fixedRequest(opened.value),
        ) &&
        isDeepStrictEqual(entry.value.references, opened.value.references) &&
        isDeepStrictEqual(entry.value.viewSpec, opened.value.viewSpec),
    );
    if (confirmed) return { saved: confirmed.value, material: material.value };
  }
  return null;
}
function fixedRequest(saved: Saved) {
  const { after, ...input } = saved.request.input;
  void after; // Real signed cursors may be reissued; viewSpec retains the exact fixed anchor.
  return { capabilityId: saved.request.capabilityId, input };
}
function fixedMaterial(material: Material) {
  const { nextCursor, ...page } = material;
  void nextCursor; // Compare every original field, value, geometry and identity in memory.
  return page;
}
function materialCount(material: Material) {
  return 'assets' in material
    ? material.assets.length
    : 'records' in material
      ? material.records.length
      : material.features.length;
}

test('restores one real fixed candidate view after its current Operation and same-tab Back', async ({
  page,
  context,
}, testInfo) => {
  assertCandidateBackflowReporter(testInfo.config.reporter);
  test.setTimeout(150_000);
  let round: Round | null = { failed: false, opens: [], materials: [] };
  let order = 0;
  const requests = new WeakMap<
    Request,
    { round: Round; order: number; action: Action; input: unknown }
  >();
  const onRequest = (request: Request) => {
    if (!round || request.method() !== 'POST') return;
    const url = new URL(request.url());
    if (url.origin !== target.origin) return;
    const action =
      url.pathname === '/api/data-foundation/candidate-saved-views/open'
        ? 'open'
        : /^\/api\/data-foundation\/candidates\/(get|records|geometry)$/.exec(
            url.pathname,
          )?.[1];
    if (!action) return;
    try {
      requests.set(request, {
        round,
        order: ++order,
        action: action as Action,
        input: request.postDataJSON() as unknown,
      });
    } catch {
      round.failed = true;
    }
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    if (!entry || entry.round !== round) return;
    void (async () => {
      const value = await json(
        response,
        entry.action === 'open' ? 128 * 1024 : 3 * 1024 * 1024,
      );
      if (entry.round !== round) return;
      if (entry.action === 'open') {
        const saved = OpenIngestionCandidateViewOutputSchema.parse(value);
        requireCondition(
          isDeepStrictEqual(entry.input, { viewId: target.viewId }) &&
            saved.savedView.viewId === target.viewId &&
            saved.request.input.ingestionId === target.ingestionId,
          'The saved-view HTTP identity did not match the fixed route.',
        );
        entry.round.opens.push({ order: entry.order, value: saved });
      } else {
        const input = (
          entry.action === 'get'
            ? IngestionCandidateReadInputSchema
            : IngestionCandidateRecordsInputSchema
        ).parse(entry.input);
        const material =
          entry.action === 'get'
            ? IngestionCandidateAssetPageSchema.parse(value)
            : entry.action === 'records'
              ? IngestionCandidateRecordPageSchema.parse(value)
              : IngestionCandidateGeometryPageSchema.parse(value);
        requireCondition(
          candidateSavedReferenceKey(material.reference) ===
            candidateSavedReferenceKey(input) &&
            (!('assetId' in material) ||
              ('assetId' in input && material.assetId === input.assetId)),
          'The material HTTP identity did not match its fixed request.',
        );
        entry.round.materials.push({
          order: entry.order,
          action: entry.action,
          input,
          value: material,
        });
      }
    })().catch(() => {
      if (entry.round === round) entry.round.failed = true;
    });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await safeStep(
      'The real local sign-in and protected fixed destination did not complete.',
      async () => {
        await page.goto(
          `/${target.locale}/login?next=${encodeURIComponent(target.destination)}`,
        );
        await page
          .getByLabel(target.locale === 'zh-CN' ? '邮箱' : 'Email', {
            exact: true,
          })
          .fill(credentials.email);
        await page
          .getByLabel(target.locale === 'zh-CN' ? '密码' : 'Password', {
            exact: true,
          })
          .fill(credentials.password);
        await Promise.all([
          page.waitForURL(
            (url) =>
              url.origin === target.origin &&
              url.pathname + url.search === target.destination,
          ),
          page
            .getByRole('button', {
              name: target.locale === 'zh-CN' ? '登录' : 'Sign in',
              exact: true,
            })
            .click(),
        ]);
        await page
          .getByLabel(`Signed in: ${credentials.email}`, { exact: true })
          .waitFor({ state: 'visible' });
      },
    );
    const readSnapshot = async (current: Round) => {
      await expect
        .poll(() => snapshot(current) !== null, {
          timeout: 45_000,
          message:
            'Current saved open, fixed material and confirmation HTTP reads did not complete.',
        })
        .toBe(true);
      const value = snapshot(current);
      requireCondition(
        value !== null,
        'The fixed HTTP snapshot is unavailable.',
      );
      requireCondition(
        materialCount(value.material) > 0,
        'The selected fixed page has no readable material (not_run).',
      );
      await safeStep('The fixed material page did not become visible.', () =>
        visibleFixedPage(page, value, copy),
      );
      return value;
    };
    const before = await readSnapshot(round);
    const operationLink = page.getByRole('link', {
      name: copy.common.openOperation,
      exact: true,
    });
    const operationPath = await safeStep(
      'The current ingestion has no usable Operation link (not_run).',
      async () => {
        const href = await operationLink.getAttribute('href');
        requireCondition(
          href !== null,
          'The current Operation link is absent.',
        );
        const prefix = `/${target.locale}/data-foundation/operations/`;
        const id = href.startsWith(prefix) ? href.slice(prefix.length) : '';
        requireCondition(
          PlatformUuidSchema.safeParse(id).success &&
            href === prefix + id.toLowerCase(),
          'The current Operation link is not a fixed canonical resource.',
        );
        return { href, id };
      },
    );
    // A departing request retains its old Round object; late responses cannot satisfy Back.
    round = null;
    const events = await safeStep(
      'The same-tab Next Operation navigation did not complete.',
      async () => {
        await Promise.all([
          page.waitForURL(
            (url) =>
              url.origin === target.origin &&
              url.pathname === operationPath.href &&
              url.search === '' &&
              url.hash === '',
          ),
          operationLink.click(),
        ]);
        requireCondition(
          context.pages().length === 1,
          'The Operation page did not retain the current resource in the same tab.',
        );
        await page
          .getByText(operationPath.id, { exact: true })
          .first()
          .waitFor({ state: 'visible' });
        const first = page.waitForResponse((response) => {
          const url = new URL(response.url());
          if (
            url.origin !== target.origin ||
            url.pathname !== '/api/data-foundation/operation-events' ||
            response.request().method() !== 'POST'
          )
            return false;
          try {
            return isDeepStrictEqual(response.request().postDataJSON(), {
              operationId: operationPath.id,
            });
          } catch {
            return false;
          }
        });
        // Consume the actual BFF; the RSC first page alone is not this proof.
        const [eventResponse] = await Promise.all([
          first,
          page
            .getByRole('button', {
              name: copy.operationPage.first,
              exact: true,
            })
            .click(),
        ]);
        return OperationEventPageSchema.parse(
          await json(eventResponse, 1024 * 1024),
        );
      },
    );
    requireCondition(
      events.items.length > 0,
      'The current Operation has no readable events (not_run).',
    );
    await safeStep(
      'The authorized Operation event page did not match or render.',
      async () => {
        requireCondition(
          events.items.length <= 100 &&
            events.items.every(
              (event, index) =>
                event.operationId === operationPath.id &&
                (index === 0 ||
                  event.sequence > (events.items[index - 1]?.sequence ?? 0)),
            ),
          'The actual Operation event page does not match its current resource.',
        );
        const eventSection = page.locator('main section').filter({
          has: page.getByRole('heading', {
            name: copy.operationPage.eventsTitle,
            exact: true,
          }),
        });
        await expect
          .poll(
            async () => {
              if (
                !(await page
                  .getByRole('button', {
                    name: copy.operationPage.first,
                    exact: true,
                  })
                  .isEnabled())
              )
                return false;
              if (
                (await eventSection.count()) !== 1 ||
                !(await eventSection.isVisible())
              )
                return false;
              const list = eventSection.locator(':scope > ol');
              if ((await list.count()) !== 1 || !(await list.isVisible()))
                return false;
              const rows = list.locator(':scope > li');
              if ((await rows.count()) !== events.items.length) return false;
              const labels: Readonly<Record<string, string>> =
                copy.status.events;
              for (const [index, event] of events.items.entries()) {
                const row = rows.nth(index);
                const label = labels[event.eventType];
                if (
                  typeof label !== 'string' ||
                  (await row.locator(':scope > div').first().textContent()) !==
                    String(event.sequence) ||
                  (await row
                    .locator(':scope > div > div > [data-tone] > span')
                    .textContent()) !== label ||
                  (await row
                    .locator(':scope > div > time')
                    .getAttribute('datetime')) !== event.occurredAt ||
                  (await row.locator(':scope > span').textContent()) !==
                    `${event.progressPercent}%`
                )
                  return false;
              }
              return true;
            },
            {
              message: 'The authorized Operation event page did not render.',
            },
          )
          .toBe(true);
      },
    );
    const restored: Round = { failed: false, opens: [], materials: [] };
    round = restored; // Arm observation before actual history navigation.
    await safeStep(
      'The actual same-tab Back did not return to the fixed route.',
      async () => {
        await page.goBack();
        await page.waitForURL(
          (url) =>
            url.origin === target.origin &&
            url.pathname + url.search === target.destination &&
            url.hash === '',
        );
      },
    );
    const after = await readSnapshot(restored);
    requireCondition(
      context.pages().length === 1 &&
        isDeepStrictEqual(
          fixedRequest(before.saved),
          fixedRequest(after.saved),
        ) &&
        isDeepStrictEqual(before.saved.references, after.saved.references) &&
        isDeepStrictEqual(before.saved.viewSpec, after.saved.viewSpec) &&
        isDeepStrictEqual(
          fixedMaterial(before.material),
          fixedMaterial(after.material),
        ),
      'Back did not retain the complete fixed manifest, page anchor and material identities.',
    );
    await safeStep(
      'The current ingestion Operation link changed after Back.',
      async () => {
        requireCondition(
          (await page
            .getByRole('link', { name: copy.common.openOperation, exact: true })
            .getAttribute('href')) === operationPath.href,
          'The current Operation link changed.',
        );
      },
    );
  } finally {
    round = null;
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
});
