import { createHash } from 'node:crypto';

export const wordHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function wordPairFixture(
  tenant: string,
  project: string,
  recordExtra: Record<string, unknown> = {},
) {
  const id = (n: number) =>
    `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const original = new TextEncoder().encode('synthetic original DOC bytes');
  const prepared = new TextEncoder().encode('synthetic prepared DOCX bytes');
  const pair = {
    original: {
      assetId: id(1),
      sha256: wordHash(original),
      byteSize: original.length,
    },
    prepared: {
      assetId: id(2),
      sha256: wordHash(prepared),
      byteSize: prepared.length,
    },
    sourceLocalWorkId: 'synthetic-monthly-2023-04',
    historicalToolVersion: null,
  };
  const claims = {
    schemaVersion: 'wiser.candidate-conversion-claims.v1',
    pairs: [pair],
  };
  const body = JSON.stringify({
    schemaVersion: 'wiser.source-registration.v1',
    sourceId: 'DS-D1',
    record: { candidateConversionPairs: claims, ...recordExtra },
    files: [pair.original, pair.prepared].map((member, index) => ({
      assetId: member.assetId,
      path: `report.${index === 0 ? 'doc' : 'docx'}`,
      sha256: member.sha256,
      sizeBytes: member.byteSize,
      preparedSha256: member.sha256,
      preparedSizeBytes: member.byteSize,
      artifactClass: 'synthetic-test',
      completeness: 'PARTIAL',
      disposition: 'IMPORT',
      relatedSourceIds: ['DS-D1'],
    })),
  });
  const contents = [original, prepared, new TextEncoder().encode(body)];
  const assets = contents.map((bytes, index) => ({
    assetId: id(index + 1),
    uploadId: id(index + 11),
    ordinal: index,
    objectRef: `tenants/${tenant}/projects/${project}/quarantine/${id(index + 11)}/object`,
    sourceKind: 'document' as const,
    size: bytes.length,
    sourceHash: wordHash(bytes),
    mediaType: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/json',
    ][index]!,
  }));
  const registration = {
    sourceId: 'DS-D1',
    kind: 'FILE_COLLECTION' as const,
    name: 'Synthetic historical Word pair',
    bundleId: 'd1-synthetic',
    providerName: 'synthetic-test',
    accessStatus: 'test-only',
    completeness: 'PARTIAL' as const,
    manifestAssetId: assets[2]!.assetId,
    manifestSha256: wordHash(body),
    limitations: [
      'Synthetic unit fixture, not a real converter or SQL acceptance.',
    ],
  };
  const declaration = {
    schemaVersion: 'wiser.candidate-conversion-pair.v1',
    ...pair,
    manifest: {
      assetId: registration.manifestAssetId,
      sha256: registration.manifestSha256,
    },
  };
  return { pair, claims, body, contents, assets, registration, declaration };
}
export const wordStructure = {
  tables: [
    {
      locator: 'word/document.xml#table:1',
      width: { type: 'dxa', value: '9600' },
      gridWidths: ['4800', '4800'],
      rows: [
        {
          locator: 'word/document.xml#table:1/row:1',
          cells: [
            {
              locator: 'word/document.xml#table:1/row:1/cell:1',
              column: 1,
              columnSpan: 1,
              verticalMerge: 'restart',
              width: { type: 'dxa', value: '4800' },
              text: '潮白河',
            },
            {
              locator: 'word/document.xml#table:1/row:1/cell:2',
              column: 2,
              columnSpan: 1,
              verticalMerge: null,
              width: { type: 'dxa', value: '4800' },
              text: '',
            },
          ],
        },
      ],
    },
  ],
  paragraphs: [{ locator: 'word/document.xml#paragraph:1', text: '2023年4月' }],
  monthTitles: [
    { locator: 'word/document.xml#paragraph:1', text: '2023年4月' },
  ],
};
