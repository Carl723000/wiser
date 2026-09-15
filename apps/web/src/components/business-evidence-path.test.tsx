// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RelationAssertion } from '@wiser/data-contracts';
import { BusinessEvidencePathPanel } from './business-evidence-path';
import { relationNodeIdentity } from '@/lib/relation-graph';
vi.mock('./data-foundation-graph', () => ({
  KnowledgeGraphCanvas: ({ result }: { result: { edges: unknown[] } }) => (
    <div data-testid="path-canvas">{result.edges.length}</div>
  ),
}));
afterEach(cleanup);
const rows = [
  {
    assertionId: 'a',
    dataItemId: 'source',
    versionId: 'version',
    mappingVersion: 'v1',
    candidate: {
      subject: { key: 'doc', label: '研究原文', kind: 'DOCUMENT' },
      object: { key: 'river', label: '永定河', kind: 'RIVER_REACH' },
      predicate: 'ABOUT_ENTITY',
      evidence: [
        { assetId: 'file', locator: 'page:4', excerpt: '原文具体证据' },
      ],
    },
  },
  {
    assertionId: 'b',
    dataItemId: 'source',
    versionId: 'version',
    mappingVersion: 'v1',
    candidate: {
      subject: { key: 'measure', label: '采样指标', kind: 'OBSERVATION' },
      object: { key: 'river', label: '永定河', kind: 'RIVER_REACH' },
      predicate: 'ABOUT_ENTITY',
      evidence: [],
    },
  },
] as RelationAssertion[];
it('shows the full connecting path, original directed statements and evidence, without changing the query', () => {
  render(<BusinessEvidencePathPanel rows={rows} locale="zh-CN" />);
  fireEvent.click(screen.getByText('查看对象之间的联系'));
  fireEvent.change(screen.getByLabelText('起点'), {
    target: {
      value: relationNodeIdentity(rows[0], rows[0].candidate.subject),
    },
  });
  fireEvent.change(screen.getByLabelText('终点'), {
    target: {
      value: relationNodeIdentity(rows[1], rows[1].candidate.subject),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: '显示联系路径' }));
  expect(screen.getByTestId('path-canvas').textContent).toBe('2');
  expect(screen.getByText('研究原文 → 涉及对象 → 永定河')).toBeTruthy();
  expect(screen.getByText('采样指标 → 涉及对象 → 永定河')).toBeTruthy();
  fireEvent.click(screen.getByText('展开原文依据 (1)'));
  expect(screen.getByText('原文具体证据')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'page:4' }).getAttribute('href'),
  ).toBe('/api/data-foundation/assets/version/file');
  fireEvent.change(screen.getByLabelText('终点'), { target: { value: '' } });
  expect(screen.queryByTestId('path-canvas')).toBeNull();
});

it('lets readers narrow long endpoint lists by name or source independently', () => {
  render(<BusinessEvidencePathPanel rows={rows} locale="zh-CN" />);
  fireEvent.click(screen.getByText('查看对象之间的联系'));
  fireEvent.change(screen.getByLabelText('查找起点（名称或来源）'), {
    target: { value: '采样指标' },
  });
  expect(screen.getByLabelText<HTMLSelectElement>('起点').options).toHaveLength(
    2,
  );
  expect(screen.getByLabelText<HTMLSelectElement>('终点').options).toHaveLength(
    4,
  );
});

it('opens evidence from the pinned external version while keeping the owner relation', () => {
  const externalRows = structuredClone(rows);
  externalRows[0].candidate.evidence[0].source = {
    dataItemId: 'metadata',
    versionId: 'metadata-version',
    analysisId: 'analysis',
    recordId: 'record',
  };
  render(<BusinessEvidencePathPanel rows={externalRows} locale="zh-CN" />);
  fireEvent.click(screen.getByText('查看对象之间的联系'));
  fireEvent.change(screen.getByLabelText('起点'), {
    target: { value: relationNodeIdentity(rows[0], rows[0].candidate.subject) },
  });
  fireEvent.change(screen.getByLabelText('终点'), {
    target: { value: relationNodeIdentity(rows[1], rows[1].candidate.subject) },
  });
  fireEvent.click(screen.getByRole('button', { name: '显示联系路径' }));
  fireEvent.click(screen.getByText('展开原文依据 (1)'));
  expect(
    screen.getByRole('link', { name: 'page:4' }).getAttribute('href'),
  ).toBe('/api/data-foundation/assets/metadata-version/file');
});
