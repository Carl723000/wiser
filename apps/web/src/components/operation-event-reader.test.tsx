// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationEventReader } from './operation-event-reader';
import type { OperationEventPageDto } from '@/lib/data-foundation';
import { getDictionary } from '@/lib/i18n';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const event = (sequence: number, operationId = id) => ({
  eventId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  operationId,
  sequence,
  operationVersion: sequence,
  eventType: 'PROGRESS_REPORTED' as const,
  status: 'RUNNING' as const,
  progressPercent: 10,
  occurredAt: '2026-10-05T00:00:00Z',
});
const page = (count: number, nextCursor?: string): OperationEventPageDto => ({
  items: Array.from({ length: count }, (_, i) => event(i + 1)),
  ...(nextCursor ? { nextCursor } : {}),
});
const initial = page(100, 'private-cursor');
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(value = initial) {
  return render(
    <OperationEventReader operationId={id} initialPage={value} locale="en">
      <p>Authorized summary</p>
    </OperationEventReader>,
  );
}
it.each([7, 100])(
  'shows %i records without fetching and no continuation without a cursor',
  (count) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mount(page(count));
    expect(screen.getAllByRole('listitem')).toHaveLength(count);
    expect(
      (
        screen.getByRole('button', {
          name: 'Continue reading',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('replaces 100 with record 101 after exactly one keyboard action, and returns to the first segment explicitly', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [event(101)] }))
    .mockResolvedValueOnce(Response.json(initial));
  vi.stubGlobal('fetch', fetch);
  mount();
  const next = screen.getByRole('button', { name: 'Continue reading' });
  next.focus();
  fireEvent.click(next);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe(
      'Showing records 101–101.',
    ),
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(document.activeElement).toBe(screen.getByRole('status'));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/data-foundation/operation-events');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    operationId: id,
    after: 'private-cursor',
  });
  expect(document.body.textContent).not.toContain('private-cursor');
  expect(window.location.href).not.toContain('private-cursor');
  fireEvent.click(
    screen.getByRole('button', { name: 'Return to first segment' }),
  );
  await waitFor(() =>
    expect(screen.getAllByRole('listitem')).toHaveLength(100),
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ operationId: id });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 404, 400, 422, 503])(
  'consumes a continuation %i without retaining old authority or reporting completion',
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('sensitive upstream text', { status }),
      )
      .mockResolvedValueOnce(Response.json({ items: [event(1)] }));
    vi.stubGlobal('fetch', fetch);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
    await screen.findByText(
      'This read did not complete. Previous content is hidden.',
    );
    expect(screen.queryByText('Authorized summary')).toBeNull();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(document.body.textContent).not.toContain('sensitive');
    expect(document.body.textContent).not.toContain(
      'No further record follows',
    );
    if (status === 400 || status === 422)
      expect(
        screen.getByText(/reading position is no longer valid/),
      ).toBeTruthy();
    if (status === 401)
      expect(
        screen
          .getByRole('link', {
            name: getDictionary('en').dataFoundation.failures.authentication
              .action,
          })
          .getAttribute('href'),
      ).toContain('/en/login');
    fireEvent.click(
      screen.getByRole('button', { name: 'Return to first segment' }),
    );
    await screen.findByText('Showing records 1–1.');
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
it.each([
  { items: [event(101, other)] },
  { items: [event(100)] },
  { items: [event(101)], nextCursor: 'private-cursor' },
  { items: [], nextCursor: 'next' },
])(
  'rejects an invalid continuation before replacing the page',
  async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
    await screen.findByText(
      'This read did not complete. Previous content is hidden.',
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  },
);
it('aborts a previous object/session refresh response and never publishes it over fresh first-page props', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
  const refreshed = { items: [event(5, other)] };
  view.rerender(
    <OperationEventReader
      operationId={other}
      initialPage={refreshed}
      locale="en"
    />,
  );
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  resolve(Response.json({ items: [event(101)] }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('Showing records 5–5.'),
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
});
it('refreshes to initial props and never reuses the previous continuation cursor', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ items: [event(101)], nextCursor: 'later' }),
    );
  vi.stubGlobal('fetch', fetch);
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
  await screen.findByText('Showing records 101–101.');
  view.rerender(
    <OperationEventReader operationId={id} initialPage={page(7)} locale="en" />,
  );
  await screen.findByText('Showing records 1–7.');
  expect(
    (
      screen.getByRole('button', {
        name: 'Continue reading',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds an unresolved browser continuation and hides old content', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
  await vi.advanceTimersByTimeAsync(15_001);
  expect(screen.getByRole('status').textContent).toBe(
    'This read did not complete. Previous content is hidden.',
  );
  expect(screen.queryByRole('listitem')).toBeNull();
});
it('rejects an oversized internal response before exposing its events', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [event(101)], padding: 'x'.repeat(1_048_577) }),
      ),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue reading' }));
  await screen.findByText(
    'This read did not complete. Previous content is hidden.',
  );
  expect(screen.queryByRole('listitem')).toBeNull();
});
