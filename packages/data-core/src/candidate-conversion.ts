// Red checkpoint: no verified equivalence or narrow consumption is available.
export function compareCandidateConversionStructure(
  _prepared: unknown,
  _reconverted: unknown,
) {
  return { kind: 'UNVERIFIABLE' as const, reason: 'INVALID_STRUCTURE' };
}

export function candidateConversionEligibility(
  _batch: unknown,
  _check: unknown,
  _expectedRule: { readonly id: string; readonly version: string },
) {
  return { eligible: false as const, reason: 'CONVERSION_UNVERIFIED' };
}
