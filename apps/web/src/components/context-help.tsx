'use client';
import {
  useId,
  useState,
  useRef,
  useLayoutEffect,
  type ReactNode,
} from 'react';
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
  const anchor = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !content.current) return;
      const origin = anchor.current.getBoundingClientRect().left;
      const width = content.current.getBoundingClientRect().width;
      setLeft(
        Math.max(8, Math.min(origin, window.innerWidth - width - 8)) - origin,
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  return (
    <span
      className={styles.help}
      ref={anchor}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        data-context-help="true"
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
        ref={content}
        style={{ left }}
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
