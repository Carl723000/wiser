// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { getDictionary } from '../lib/i18n';
import { materialReference } from '../lib/spatial-readiness-facts';
import {
  parseLocalReadinessFacts,
  readableLocalReadinessFacts,
} from '../lib/spatial-readiness-input';
import type {
  Material,
  WorkspacePack,
} from '../lib/spatial-workspace-contract';
import { SpatialReadinessPanel } from './spatial-readiness-panel';

const copy = getDictionary('en').dataFoundation.spatialReadiness;
afterEach(cleanup);

it('clears previously readable B evidence from the real inspector after withdrawal while retaining A evidence', () => {
  const source: Material = {
    id: 'current-source-A',
    versionId: 'v1',
    title: 'A original',
    provider: 'Public provider',
    kind: 'report',
    originalSha256: 'a'.repeat(64),
    evidenceUrl: null,
    rights: {
      public: true,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Local inspection',
    },
    regionIds: ['chaobai'],
    needIds: ['K5-001'],
    processingVersion: 'p1',
    duplicateOf: null,
    status: {
      original: 'obtained',
      parsed: 'partial',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'text-only',
      use: 'inspection',
    },
  };
  const other: Material = {
    ...source,
    id: 'withdrawn-source-B',
    title: 'B original',
    originalSha256: 'b'.repeat(64),
  };
  const pack: WorkspacePack = {
    schemaVersion: 1,
    generatedAt: '2026-10-04',
    processingVersion: 'p1',
    sources: [source, other],
    records: [],
    regions: [],
    topicPackages: [],
    rasterReports: [],
  };
  const currentExcerpt = 'CURRENT_A_ORIGINAL_EXCERPT';
  const privateExcerpt = 'WITHDRAWN_PRIVATE_EXCERPT';
  const a = {
    source: materialReference(source),
    locator: 'page:1',
    excerpt: currentExcerpt,
  };
  const b = {
    source: materialReference(other),
    locator: 'page:2',
    excerpt: privateExcerpt,
  };
  const check = {
    id: 'current-A-check',
    kind: 'INTEGRITY',
    state: 'PASSED',
    recordIds: [],
    sources: [materialReference(source)],
    findings: [],
    evidence: [a],
  };
  const facts = readableLocalReadinessFacts(
    pack,
    parseLocalReadinessFacts({
      track: 'REAL',
      requirement: {
        needId: 'K5-001',
        version: 'v1',
        regionId: 'chaobai',
        purpose: 'inspection',
        dateRole: 'OBSERVATION',
        window: null,
      },
      sources: [source, other].map((item) => ({
        ...materialReference(item),
        track: 'REAL',
        kind: 'DOCUMENT',
        needIds: item.needIds,
        regionIds: item.regionIds,
      })),
      records: [],
      series: [],
      correspondences: [],
      checks: [check, { ...check, id: 'B-dependent-check', evidence: [a, b] }],
    }),
  );
  const view = render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="chaobai"
      copy={copy}
      facts={facts}
    />,
  );
  const inspectQuality = () => {
    const question = screen
      .getByRole('heading', { level: 3, name: copy.questionLabels.quality })
      .closest('article')!;
    fireEvent.click(
      within(question).getByRole('button', { name: copy.inspect }),
    );
  };
  inspectQuality();
  expect(screen.getAllByText(privateExcerpt)).toHaveLength(1);
  view.rerender(
    <SpatialReadinessPanel
      pack={{
        ...pack,
        sources: [
          source,
          { ...other, rights: { ...other.rights, displayAllowed: false } },
        ],
      }}
      regionId="chaobai"
      copy={copy}
      facts={facts}
    />,
  );
  inspectQuality();
  expect(screen.queryByText(privateExcerpt)).toBeNull();
  expect(view.container.innerHTML).not.toContain(other.id);
  expect(view.container.textContent).not.toContain('B-dependent-check');
  expect(screen.getByText(currentExcerpt)).toBeTruthy();
});
