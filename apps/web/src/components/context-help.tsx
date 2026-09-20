'use client';
import { useId, useState, type ReactNode } from 'react';
import styles from './context-help.module.css';
/** Optional explanation: available with pointer, keyboard and touch. */
export function ContextHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  return (
    <span
      className={styles.help}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setHovered(false);
          setPinned(!pinned);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setPinned(false);
            setHovered(false);
          }
        }}
      >
        {'?'}
      </button>
      <span
        id={id}
        role="note"
        aria-label={label}
        hidden={!open}
        className={styles.content}
      >
        {children}
      </span>
    </span>
  );
}
