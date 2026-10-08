// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as FollowupReaderModule from '@/lib/candidate-followup-reader';
import type * as CandidateReaderModule from '@/lib/ingestion-candidate-reader';
const { read, candidate } = vi.hoisted(() => ({
  read: vi.fn(),
  candidate: vi.fn(),
}));
vi.mock('@/lib/candidate-followup-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof FollowupReaderModule>()),
  readCandidateFollowup: read,
}));
vi.mock('@/lib/ingestion-candidate-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof CandidateReaderModule>()),
  readCandidatePage: candidate,
}));
import { CandidateFollowupPanel } from './candidate-followup-panel';
import { candidateSavedReferenceKey } from '@wiser/data-contracts';
import { CandidateReaderError } from '@/lib/ingestion-candidate-reader';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: id(1),
  processingBatchId: id(2),
  reviewHash: 'a'.repeat(64),
};
const source = {
  reference,
  assetId: id(3),
  sourceHash: 'b'.repeat(64),
  locator: `asset:${id(3)}`,
};
const actor = {
  actorId: id(4),
  actorType: 'human' as const,
  delegatedBy: null,
  purpose: 'review',
};
const task = (state = 'OPEN', rowVersion = 1) => ({
  followupId: id(5),
  type: 'GAP',
  state,
  rowVersion,
  source,
  createdBy: actor,
  evidence: [],
  assignee: state === 'OPEN' ? null : actor,
  responsibilities: [actor],
  ruleId: 'coverage',
  ruleVersion: '1',
  reason: 'Missing report month',
  createdAt: '2026-10-08T00:00:00Z',
  technicalOnly: true,
  events: Array.from({ length: rowVersion }, (_, i) => ({
    eventId: id(100 + i),
    rowVersion: i + 1,
    expectedVersion: i,
    action:
      i === 0
        ? 'CREATE'
        : i === 1
          ? 'CLAIM'
          : i === rowVersion - 1
            ? state === 'CLOSED'
              ? 'CLOSE'
              : state === 'REVIEW_PENDING'
                ? 'SUBMIT_REVIEW'
                : state === 'OPEN'
                  ? 'REOPEN'
                  : 'SUPPLEMENT'
            : 'SUPPLEMENT',
    actor,
    target: null,
    stateAfter: i === 0 ? 'OPEN' : i === rowVersion - 1 ? state : 'WORKING',
    evidence: [],
    correction: null,
    note: i === 0 ? 'Missing report month' : `Action ${i}`,
    createdAt: '2026-10-08T00:00:00Z',
  })),
});
const props = {
  locale: 'en' as const,
  references: [{ reference, label: 'Fixed source A' }],
  ruleId: 'coverage',
  ruleVersion: '1',
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('provides a dependency state without creating fictitious references', () => {
  render(<CandidateFollowupPanel {...props} references={[]} />);
  expect(screen.getByText(/Select a fixed candidate source/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create followup' })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it('lists, opens, claims with version and keeps complete history readable', async () => {
  read
    .mockResolvedValueOnce({ items: [task()], nextCursor: null })
    .mockResolvedValueOnce({ followup: task() })
    .mockResolvedValueOnce({ followup: task('WORKING', 2) });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: 'Missing report month' });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Missing report month',
    }),
  );
  await screen.findByText('Open', { selector: 'strong' });
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'I will check the source' },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Claim' }),
  );
  await screen.findByText('Working', { selector: 'strong' });
  expect(read.mock.calls[2][1]).toEqual({
    followupId: id(5),
    expectedVersion: 1,
    action: 'CLAIM',
    note: 'I will check the source',
  });
  expect(read.mock.calls[2][3]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    screen.getAllByText('Missing report month', { selector: 'p' }),
  ).toHaveLength(2);
  expect(
    screen.getByRole('heading', { name: 'Complete action history · 2' }),
  ).toBeTruthy();
});
it('uses actual asset hash and locator, with correction disabled for an asset-only proof', async () => {
  candidate.mockResolvedValue({
    reference,
    parserVersion: 'synthetic.v1',
    status: 'READY',
    createdAt: '2026-10-08T00:00:00Z',
    totalAssetCount: 1,
    knownRecordCount: 0,
    knownFeatureCount: 0,
    unknownAssetCount: 0,
    assets: [
      {
        assetId: id(3),
        sourceHash: 'b'.repeat(64),
        status: 'EMPTY',
        recordCount: 0,
        featureCount: 0,
        reason: null,
      },
    ],
    nextCursor: null,
  });
  read.mockResolvedValue({ followup: task() });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load source evidence',
    }),
  );
  await screen.findByRole('option', { name: `Original · ${id(3)}` });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Missing report month' },
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create followup',
    }).disabled,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create followup' }),
  );
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(read.mock.calls[0][1]).toMatchObject({
    type: 'GAP',
    source,
    ruleId: 'coverage',
    ruleVersion: '1',
  });
  fireEvent.change(screen.getByLabelText('Followup type'), {
    target: { value: 'CORRECTION' },
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create followup',
    }).disabled,
  ).toBe(true);
});
it('removes withdrawn content on denied reads and ignores a late request from a previous source scope', async () => {
  let resolve!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  view.rerender(
    <CandidateFollowupPanel
      {...props}
      references={[
        {
          reference: { ...reference, reviewHash: 'c'.repeat(64) },
          label: 'Source B',
        },
      ]}
    />,
  );
  resolve({ items: [task()], nextCursor: null });
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Missing report month' }),
    ).toBeNull(),
  );
  read.mockRejectedValueOnce(new CandidateReaderError('denied'));
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Current account');
  expect(
    screen.queryByRole('button', { name: 'Missing report month' }),
  ).toBeNull();
});

it('supplements from a second authorized candidate without losing the open followup', async () => {
  const second = {
    ...reference,
    ingestionId: id(11),
    processingBatchId: id(12),
    reviewHash: 'c'.repeat(64),
  };
  const secondProof = {
    reference: second,
    assetId: id(13),
    sourceHash: 'd'.repeat(64),
    locator: `asset:${id(13)}`,
  };
  read
    .mockResolvedValueOnce({ items: [task('WORKING', 2)], nextCursor: null })
    .mockResolvedValueOnce({ followup: task('WORKING', 2) })
    .mockResolvedValueOnce({
      followup: { ...task('WORKING', 3), evidence: [secondProof] },
    });
  candidate.mockResolvedValueOnce({
    reference: second,
    assets: [{ assetId: id(13), sourceHash: 'd'.repeat(64) }],
    nextCursor: null,
  });
  render(
    <CandidateFollowupPanel
      {...props}
      references={[
        ...props.references,
        { reference: second, label: 'Fixed source B' },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: 'Missing report month' });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Missing report month',
    }),
  );
  await screen.findByText('Working', { selector: 'strong' });
  fireEvent.change(screen.getByLabelText('Evidence source'), {
    target: { value: candidateSavedReferenceKey(second) },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load source evidence',
    }),
  );
  await screen.findByRole('option', { name: `Original · ${id(13)}` });
  expect(candidate.mock.calls[0][1]).toMatchObject({ ...second, first: 50 });
  expect(screen.getByText('Working', { selector: 'strong' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'Received a fixed additional source' },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Supplement evidence',
    }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2][1]).toEqual({
    followupId: id(5),
    expectedVersion: 2,
    action: 'SUPPLEMENT',
    note: 'Received a fixed additional source',
    evidence: [secondProof],
  });
});

it('uses a whole-record source and explicit old/new geometry pair for correction supplementation', async () => {
  const original = {
    ...source,
    recordId: id(21),
    locator: 'table:1/row:1',
    sourceCrs: 'EPSG:4326',
    geometry: { type: 'Point' as const, coordinates: [116, 40] },
  };
  const replacement = {
    ...original,
    recordId: id(22),
    locator: 'table:1/row:2',
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [116, 40],
        [116.1, 40.1],
      ],
    },
  };
  const current = {
    ...task('WORKING', 2),
    type: 'CORRECTION',
    source: original,
  };
  read
    .mockResolvedValueOnce({ items: [current], nextCursor: null })
    .mockResolvedValueOnce({ followup: current })
    .mockResolvedValueOnce({
      followup: { ...current, rowVersion: 3, evidence: [replacement] },
    });
  candidate
    .mockResolvedValueOnce({
      reference,
      assets: [{ assetId: id(3), sourceHash: source.sourceHash }],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      reference,
      features: [
        {
          assetId: id(3),
          recordId: id(22),
          sourceId: 'table:1/row:2',
          sourceCrs: 'EPSG:4326',
          geometry: replacement.geometry,
        },
      ],
      nextCursor: null,
    });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: current.reason });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: current.reason }),
  );
  await screen.findByText('Working', { selector: 'strong' });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load source evidence',
    }),
  );
  await screen.findByRole('option', { name: `Original · ${id(3)}` });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load record positions',
    }),
  );
  await screen.findByRole('option', {
    name: `Whole-record geometry · ${id(22)}`,
  });
  expect(candidate.mock.calls[1][1]).toMatchObject({
    ...reference,
    assetId: id(3),
    first: 50,
  });
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'Original and replacement checked' },
  });
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Supplement evidence',
    }).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Old/new record correspondence'), {
    target: {
      value: 'Same received object; whole line replaces original point',
    },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Supplement evidence',
    }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2][1]).toMatchObject({
    expectedVersion: 2,
    evidence: [replacement],
    correction: {
      scope: 'WHOLE_RECORD',
      old: original,
      new: replacement,
      mappingReason: 'Same received object; whole line replaces original point',
    },
  });
});
it('keeps handoff limited to the target UUID and clears withdrawn history on a version conflict', async () => {
  read
    .mockResolvedValueOnce({ items: [task('WORKING', 2)], nextCursor: null })
    .mockResolvedValueOnce({ followup: task('WORKING', 2) })
    .mockRejectedValueOnce(new CandidateReaderError('stale'));
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: 'Missing report month' });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Missing report month',
    }),
  );
  await screen.findByLabelText('Action note');
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'Transfer for current source check' },
  });
  fireEvent.change(screen.getByLabelText('Recipient actor ID'), {
    target: { value: id(41) },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Handoff' }),
  );
  await screen.findByRole('alert');
  expect(read.mock.calls[2][1]).toEqual({
    followupId: id(5),
    expectedVersion: 2,
    action: 'HANDOFF',
    targetActorId: id(41),
    note: 'Transfer for current source check',
  });
  expect(
    screen.queryByRole('heading', { name: /Complete action history/ }),
  ).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('changed');
});
it.each(['CLOSE', 'RETURN'])(
  'invokes independent review %s without deriving reviewer authority from the page',
  async (decision) => {
    const pending = { ...task('REVIEW_PENDING', 4), evidence: [source] };
    read
      .mockResolvedValueOnce({ items: [pending], nextCursor: null })
      .mockResolvedValueOnce({ followup: pending })
      .mockRejectedValueOnce(new CandidateReaderError('denied'));
    render(<CandidateFollowupPanel {...props} />);
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
    );
    await screen.findByRole('button', { name: pending.reason });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>('button', { name: pending.reason }),
    );
    await screen.findByLabelText('Action note');
    fireEvent.change(screen.getByLabelText('Action note'), {
      target: { value: 'Independent current evidence check' },
    });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>('button', {
        name:
          decision === 'CLOSE'
            ? 'Close technical followup'
            : 'Return for handling',
      }),
    );
    await screen.findByRole('alert');
    expect(read.mock.calls[2][0]).toBe('review');
    expect(read.mock.calls[2][1]).toEqual({
      followupId: id(5),
      expectedVersion: 4,
      decision,
      note: 'Independent current evidence check',
    });
    expect(
      screen.queryByRole('heading', { name: /Complete action history/ }),
    ).toBeNull();
  },
);
it('reopens a closed followup and expands complete bounded history without another history request', async () => {
  const closed = { ...task('CLOSED', 23), evidence: [source] };
  read
    .mockResolvedValueOnce({ items: [closed], nextCursor: null })
    .mockResolvedValueOnce({ followup: closed })
    .mockResolvedValueOnce({ followup: task('OPEN', 24) });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: closed.reason });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: closed.reason }),
  );
  await screen.findByRole('heading', { name: 'Complete action history · 23' });
  const history = screen.getByRole('heading', {
    name: 'Complete action history · 23',
  }).nextElementSibling as HTMLElement;
  expect(within(history).getAllByRole('listitem').length).toBe(20);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Show more history',
    }),
  );
  expect(within(history).getAllByRole('listitem').length).toBe(23);
  expect(read).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'New evidence requires another check' },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Reopen' }),
  );
  await screen.findByText('Open', { selector: 'strong' });
  expect(read.mock.calls[2][1]).toMatchObject({
    action: 'REOPEN',
    expectedVersion: 23,
  });
});
it('reads one explicit followup page at a time and prevents writes in a readonly topic', async () => {
  read
    .mockResolvedValueOnce({ items: [task()], nextCursor: 'cursor-one' })
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  render(<CandidateFollowupPanel {...props} readOnly />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: 'Next page' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Create followup' })).toBeNull();
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1][1]).toMatchObject({
    ...reference,
    first: 25,
    after: 'cursor-one',
  });
  expect(candidate).not.toHaveBeenCalled();
});

it('retains the same mutation key after an ambiguous create failure and explicit evidence reload', async () => {
  const page = {
    reference,
    assets: [{ assetId: id(3), sourceHash: source.sourceHash }],
    nextCursor: null,
  };
  candidate.mockResolvedValue(page);
  read
    .mockRejectedValueOnce(new CandidateReaderError('unavailable'))
    .mockResolvedValueOnce({ followup: task() });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load source evidence',
    }),
  );
  await screen.findByRole('option', { name: `Original · ${id(3)}` });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Missing report month' },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create followup' }),
  );
  await screen.findByRole('alert');
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load source evidence',
    }),
  );
  await screen.findByRole('option', { name: `Original · ${id(3)}` });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create followup' }),
  );
  await screen.findByText('Open', { selector: 'strong' });
  expect(read.mock.calls[1][1]).toEqual(read.mock.calls[0][1]);
  expect(read.mock.calls[1][3]).toBe(read.mock.calls[0][3]);
});
it('submits only the current version after supplemental evidence has been accepted', async () => {
  const working = { ...task('WORKING', 3), evidence: [source] };
  read
    .mockResolvedValueOnce({ items: [working], nextCursor: null })
    .mockResolvedValueOnce({ followup: working })
    .mockResolvedValueOnce({
      followup: { ...task('REVIEW_PENDING', 4), evidence: [source] },
    });
  render(<CandidateFollowupPanel {...props} />);
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Load followups' }),
  );
  await screen.findByRole('button', { name: working.reason });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', { name: working.reason }),
  );
  await screen.findByLabelText('Action note');
  fireEvent.change(screen.getByLabelText('Action note'), {
    target: { value: 'Source evidence ready for independent handling' },
  });
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Submit for independent review',
    }),
  );
  await screen.findByText('Independent review pending', { selector: 'strong' });
  expect(read.mock.calls[2][1]).toEqual({
    followupId: id(5),
    expectedVersion: 3,
    action: 'SUBMIT_REVIEW',
    note: 'Source evidence ready for independent handling',
  });
});
