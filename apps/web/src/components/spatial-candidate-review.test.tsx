// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { syntheticReviewRecord } from '../lib/spatial-candidate-review';
import {
  SpatialCandidateReview,
  type CandidateReviewCopy,
  type SpatialCandidateReviewProps,
} from './spatial-candidate-review';

const copy: CandidateReviewCopy = {
  title: 'Candidate review',
  noSelection: 'Choose a record',
  realPendingNote: 'Real records remain pending',
  exerciseNote: 'Synthetic exercise',
  startExercise: 'Start exercise',
  returnToReal: 'Return to real record',
  sourceEvidence: 'Source evidence',
  candidatePosition: 'Candidate position',
  reasonLabel: 'Reason',
  actionLabel: 'Decision',
  actions: { accept: 'Accept', exclude: 'Exclude', pending: 'Pending' },
  saveDecision: 'Save decision',
  regenerate: 'Regenerate',
  history: 'Local decisions',
  versionLabel: 'Decision version',
  errorLabels: { REASON_REQUIRED: 'Reason required' },
  regeneratedNote: 'Regenerated locally',
  positionRoleLabels: {
    'study-area': 'Study area',
    sampling: 'Sampling',
    'event-location': 'Event',
    'applicable-area': 'Applies',
    mention: 'Mention',
    'institution-address': 'Institution address',
    reference: 'Reference',
  },
};
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('keeps real evidence read only and offers a separately identified synthetic exercise', () => {
  const record = {
    ...syntheticReviewRecord(),
    reviewStatus: 'pending' as const,
    id: 'real',
  };
  render(<SpatialCandidateReview record={record} copy={copy} />);
  expect(screen.getByText(copy.realPendingNote)).toBeTruthy();
  expect(screen.queryByLabelText(copy.reasonLabel)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: copy.startExercise }));
  expect(screen.getByText(copy.exerciseNote)).toBeTruthy();
  expect(screen.getByLabelText(copy.reasonLabel)).toBeTruthy();
  expect(record.reviewStatus).toBe('pending');
});
it('requires a reason, persists a local version, and regenerates without touching the real source', () => {
  const regenerate =
    vi.fn<NonNullable<SpatialCandidateReviewProps['onRegenerate']>>();
  const record = {
    ...syntheticReviewRecord(),
    reviewStatus: 'pending' as const,
    id: 'real',
  };
  const view = render(
    <SpatialCandidateReview
      record={record}
      copy={copy}
      onRegenerate={regenerate}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: copy.startExercise }));
  fireEvent.click(screen.getByRole('button', { name: copy.saveDecision }));
  expect(screen.getByRole('alert').textContent).toBe(
    copy.errorLabels.REASON_REQUIRED,
  );
  fireEvent.change(screen.getByLabelText(copy.reasonLabel), {
    target: { value: 'Exact synthetic evidence' },
  });
  fireEvent.change(screen.getByLabelText(copy.actionLabel), {
    target: { value: 'exclude' },
  });
  fireEvent.click(screen.getByRole('button', { name: copy.saveDecision }));
  fireEvent.click(screen.getByRole('button', { name: copy.regenerate }));
  expect(regenerate).toHaveBeenCalledOnce();
  expect(regenerate.mock.calls[0][0].positions).toHaveLength(0);
  expect(regenerate.mock.calls[0][0].processingVersion).toContain(
    ':decision:d1',
  );
  expect(regenerate.mock.calls[0][2].originalRecordId).toBe('real');
  expect(record.positions).toHaveLength(1);
  view.unmount();
  render(<SpatialCandidateReview record={record} copy={copy} />);
  fireEvent.click(screen.getByRole('button', { name: copy.startExercise }));
  expect(screen.getByText('Exact synthetic evidence')).toBeTruthy();
});
