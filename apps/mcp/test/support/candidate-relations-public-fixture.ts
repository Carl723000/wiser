export function candidateRelationPublicInputs(
  reference: {
    kind: string;
    ingestionId: string;
    processingBatchId: string;
    reviewHash: string;
  },
  assetId: string,
  relationId: string,
) {
  const evidence = {
    reference,
    assetId,
    sourceHash: 'b'.repeat(64),
    locator: 'row:1',
    excerpt: null,
    polarity: 'SUPPORTS',
  };
  const proposal = {
    reference,
    mappingVersion: 'source/1',
    ruleVersion: 'candidate-relations/1',
    content: {
      subject: {
        key: 'a',
        label: 'Synthetic upstream',
        kind: 'EXTERNAL_ENTITY',
        externalId: null,
      },
      predicate: 'FLOWS_TO',
      object: {
        key: 'b',
        label: 'Synthetic downstream',
        kind: 'EXTERNAL_ENTITY',
        externalId: null,
      },
      qualifiers: {
        measure: null,
        unit: null,
        observedAt: null,
        missing: false,
        spatialScope: null,
        limitations: [],
        reportedConclusion: null,
        context: {
          recordNature: 'SOURCE_RELATION',
          timeRole: 'PUBLICATION_TIME',
          validFrom: null,
          validTo: null,
          locationRole: 'REFERENCE_LOCATION',
          applicability: 'Background only',
        },
      },
      generation: { method: 'SOURCE_FIELDS', model: null },
      evidence: [evidence],
    },
  };
  const selected = {
    relationId,
    revision: 1,
    decisionVersion: 0,
    references: [reference],
  };
  return {
    'data.ingestion.candidate.relations.create': { proposals: [proposal] },
    'data.ingestion.candidate.relations.get': selected,
    'data.ingestion.candidate.relations.list': {
      references: [reference],
      first: 2,
    },
    'data.ingestion.candidate.relations.review': {
      ...selected,
      status: 'CONFIRMED',
      rationale: 'Independent synthetic check',
    },
    'data.ingestion.candidate.relations.withdraw': {
      ...selected,
      rationale: 'Synthetic owner withdrawal',
    },
    'data.ingestion.candidate.relations.rebind': {
      ...selected,
      replacement: proposal,
      mapping: [{ from: evidence, to: evidence }],
    },
  };
}
