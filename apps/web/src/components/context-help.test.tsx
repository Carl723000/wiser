// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ContextHelp } from './context-help';
afterEach(cleanup);
it('shows optional help on hover or click and closes with Escape without losing the trigger', () => {
  render(<ContextHelp label="Scope">Exact membership explanation</ContextHelp>);
  const trigger = screen.getByRole('button', { name: 'Scope' });
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.pointerEnter(trigger.parentElement!);
  expect(screen.getByRole('note').textContent).toBe(
    'Exact membership explanation',
  );
  fireEvent.pointerLeave(trigger.parentElement!);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerLeave(trigger.parentElement!);
  expect(screen.getByRole('note')).toBeTruthy();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('note')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
