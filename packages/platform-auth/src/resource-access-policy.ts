export function evaluateResourceAccess(_input: unknown) {
  return {
    allowed: false,
    reason: 'INVALID_POLICY',
    grantIds: [] as string[],
    validUntil: null as string | null,
  };
}
