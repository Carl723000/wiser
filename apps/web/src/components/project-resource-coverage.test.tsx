// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ProjectResourceCoverage } from './project-resource-coverage';
const tenantId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const otherProject = '44444444-4444-4444-8444-444444444444';
const queryId = '33333333-3333-4333-8333-333333333333';
const source = {
  dataItemId: tenantId,
  versionId: projectId,
  name: '公开水质月报',
  provider: '公开发布单位',
  kind: 'DATASET',
  assetCount: 1,
  readiness: {
    records: 'READY',
    spatial: 'NO_SPATIAL_DATA',
    graph: 'NOT_PARSED',
  },
  recordCount: 120,
  featureCount: null,
  limitations: [],
};
const result = {
  queryId,
  spec: {},
  createdAt: '2026-09-23T00:00:00Z',
  expiresAt: '2099-09-23T00:30:00Z',
  view: 'resources',
  totalCount: 155,
  resources: [source],
  nextCursor: 'page2',
  summary: {
    resourceCount: 155,
    analyzedResourceCount: 153,
    indexedRecordCount: 87350,
    indexedFeatureCount: 21,
    records: [{ status: 'READY', count: 138 }],
    spatial: [{ status: 'NO_SPATIAL_DATA', count: 134 }],
  },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('uses whole authorized-query totals, provides drilldown and preserves the fixed query across pages', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(Response.json(result)));
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectResourceCoverage
      locale="zh-CN"
      tenantId={tenantId}
      projectId={projectId}
    />,
  );
  await screen.findByText('公开水质月报');
  expect(screen.getByTestId('coverage-resource-total').textContent).toBe('155');
  expect(screen.getByText('87,350')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一页资源' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(String(fetch.mock.calls[1][0])).toContain(`queryId=${queryId}`);
  expect(String(fetch.mock.calls[1][0])).toContain('after=page2');
  await screen.findByText('公开水质月报');
  fireEvent.click(
    screen.getByRole('button', { name: '内容状态：可用，138项' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(String(fetch.mock.calls[2][0])).toContain('records=READY');
  expect(String(fetch.mock.calls[2][0])).not.toContain('queryId=');
});
it('clears resources on denial and never displays unknown aggregate counts as zero', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ...result, summary: undefined }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectResourceCoverage
      locale="en"
      tenantId={tenantId}
      projectId={projectId}
    />,
  );
  await screen.findByText('公开水质月报');
  expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh resources' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('公开水质月报')).toBeNull();
  expect(screen.queryByTestId('coverage-resource-total')).toBeNull();
});
it('ignores a late previous-project response after scope changes', async () => {
  let finish!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(
      Response.json({
        ...result,
        resources: [{ ...source, name: '第二项目资料' }],
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const view = render(
    <ProjectResourceCoverage
      locale="zh-CN"
      tenantId={tenantId}
      projectId={projectId}
    />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  view.rerender(
    <ProjectResourceCoverage
      locale="zh-CN"
      tenantId={tenantId}
      projectId={otherProject}
    />,
  );
  await screen.findByText('第二项目资料');
  finish(Response.json(result));
  await waitFor(() => expect(screen.queryByText('公开水质月报')).toBeNull());
  expect(screen.getByText('第二项目资料')).toBeTruthy();
});
