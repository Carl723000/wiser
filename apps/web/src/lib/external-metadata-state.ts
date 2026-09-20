/** Only these source outcomes may cross the web transport; upstream prose never does. */
export const externalMetadataErrorStatuses = {
  EXTERNAL_SOURCE_UNCONFIGURED: 503,
  EXTERNAL_SOURCE_UNAVAILABLE: 503,
  EXTERNAL_SOURCE_TIMEOUT: 504,
  EXTERNAL_AUTHORIZATION_EXPIRED: 403,
  EXTERNAL_SOURCE_ACCESS_DENIED: 403,
  EXTERNAL_METADATA_INVALID: 502,
  REQUEST_CANCELLED: 499,
} as const;
export type ExternalMetadataFailureCode =
  keyof typeof externalMetadataErrorStatuses;
export function externalMetadataFailureCode(
  value: unknown,
  status: number,
): ExternalMetadataFailureCode | undefined {
  if (
    typeof value !== 'string' ||
    !Object.hasOwn(externalMetadataErrorStatuses, value)
  )
    return undefined;
  const code = value as ExternalMetadataFailureCode;
  return externalMetadataErrorStatuses[code] === status ? code : undefined;
}
