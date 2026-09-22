export function compileResourceAccessScope(
  _input: unknown,
):
  | {
      mode: 'managed';
      permissions: Record<string, readonly unknown[]>;
      validUntil: string | null;
    }
  | { mode: 'legacy' }
  | null {
  return null;
}
