// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextHelp } from './context-help';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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

it('keeps an open explanation inside a narrow viewport when its trigger is near the right edge', () => {
  vi.stubGlobal('innerWidth', 390);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return {
        left: 174,
        right: this.getAttribute('role') === 'note' ? 466 : 206,
        width: this.getAttribute('role') === 'note' ? 292 : 32,
        top: 100,
        bottom: 132,
        height: 32,
        x: 174,
        y: 100,
        toJSON() {},
      };
    },
  );
  render(<ContextHelp label="Help">Explanation</ContextHelp>);
  fireEvent.click(screen.getByRole('button', { name: 'Help' }));
  const note = screen.getByRole('note');
  const left = 174 + Number.parseFloat(note.style.left || '0');
  expect(left).toBeGreaterThanOrEqual(8);
  expect(left + 292).toBeLessThanOrEqual(382);
});
