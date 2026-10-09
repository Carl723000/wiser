import {
  candidateSavedReferenceKey,
  PlatformUuidSchema,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  calculateProjectReadiness,
  classifyReadinessValue,
  readinessRecordKey,
  readinessSourceKey,
  type CandidateReadinessSourceReference,
  type ProjectReadinessRecord,
  type ProjectReadinessSource,
  type ReadinessEvidence,
  type ProjectReadinessInput,
  type ProjectReadinessResult,
  type ProjectReadinessTrack,
  type ReadinessValue,
} from '@wiser/data-core/project-readiness';
import type {
  CandidateMonthlySemanticRead,
  CandidateMonthlySemanticRecord,
} from './candidate-monthly-semantic-reader';
import {
  buildMonthlyReadout,
  type MonthlyReadoutRow,
} from './spatial-monthly-readout';

export type CandidateMonthlyReadyRead = Extract<
  CandidateMonthlySemanticRead,
  { kind: 'READY' }
>;
export type CandidateMonthlyReadinessRequirement = Omit<
  ProjectReadinessInput['requirement'],
  'dateRole'
> & { readonly track: ProjectReadinessTrack };

/** Explicit record-level scope evidence; a selected region is not this evidence. */
export interface CandidateMonthlyReadinessMapping {
  readonly recordId: string;
  readonly needId: string;
  readonly regionId: string;
  readonly evidence: readonly {
    readonly locator: string;
    readonly excerpt: string;
  }[];
}

export interface CandidateMonthlyOriginalEntry {
  readonly recordKey: string;
  readonly record: CandidateMonthlySemanticRecord;
  readonly value: ReadinessValue;
}
export interface CandidateMonthlySelection {
  readonly recordKey: string;
  readonly candidateReference: IngestionCandidateReference;
  readonly assetId: string;
  readonly sourceLocalIdentity: CandidateMonthlySemanticRecord['sourceLocalIdentity'];
  readonly locators: CandidateMonthlySemanticRecord['locators'];
}
export interface CandidateMonthlyOriginals {
  readonly originals: readonly CandidateMonthlyOriginalEntry[];
  readonly selections: readonly CandidateMonthlySelection[];
}
export interface CandidateMonthlyReadiness extends CandidateMonthlyOriginals {
  readonly readiness: ProjectReadinessResult;
  readonly monthly: readonly MonthlyReadoutRow[];
  /** Native IDs with no explicit mapping to this exact requirement pair. */
  readonly unmappedRecordIds: readonly string[];
}

function invalid(): never {
  throw new Error('Candidate monthly readiness input is inconsistent.');
}

function sourceOf(
  record: CandidateMonthlySemanticRecord,
): CandidateReadinessSourceReference {
  return {
    candidateReference: record.candidateReference,
    assetId: record.source.assetId,
    sourceLocalWorkId: record.source.sourceLocalWorkId,
  };
}

/** Reads already authorized semantics. It grants no scope, series or professional approval. */
export function buildCandidateMonthlyOriginals(
  read: CandidateMonthlyReadyRead,
): CandidateMonthlyOriginals {
  if (read.kind !== 'READY') invalid();
  // Validate the fixed candidate even when the producer returned no rows.
  readinessSourceKey({
    candidateReference: read.candidateReference,
    assetId: read.assetId,
    sourceLocalWorkId: null,
  });
  const seen = new Set<string>();
  const referenceKey = candidateSavedReferenceKey(read.candidateReference);
  const originals = read.records.map(
    (record): CandidateMonthlyOriginalEntry => {
      const recordKey = readinessRecordKey({
        source: sourceOf(record),
        id: record.sourceLocalIdentity.recordId,
      });
      const nativeId = record.sourceLocalIdentity.recordId.toLowerCase();
      if (
        !PlatformUuidSchema.safeParse(record.sourceLocalIdentity.recordId)
          .success ||
        candidateSavedReferenceKey(record.candidateReference) !==
          referenceKey ||
        record.source.assetId.toLowerCase() !== read.assetId.toLowerCase() ||
        seen.has(nativeId)
      )
        invalid();
      seen.add(nativeId);
      return {
        recordKey,
        record,
        value: classifyReadinessValue(record.rawCategory),
      };
    },
  );
  return {
    originals,
    selections: originals.map(({ recordKey, record }) => ({
      recordKey,
      candidateReference: record.candidateReference,
      assetId: record.source.assetId,
      sourceLocalIdentity: record.sourceLocalIdentity,
      locators: record.locators,
    })),
  };
}

/** Only exact, evidenced need/region pairs enter the existing core calculation. */
export function buildCandidateMonthlyReadiness(
  read: CandidateMonthlyReadyRead,
  requirement: CandidateMonthlyReadinessRequirement,
  mappings: readonly CandidateMonthlyReadinessMapping[],
): CandidateMonthlyReadiness {
  const originals = buildCandidateMonthlyOriginals(read);
  const nativeIds = new Set(
    read.records.map((r) => r.sourceLocalIdentity.recordId.toLowerCase()),
  );
  const seen = new Set<string>();
  const selectedMappings = new Map<string, CandidateMonthlyReadinessMapping>();
  for (const mapping of mappings) {
    const id = mapping.recordId.toLowerCase();
    const key = JSON.stringify([id, mapping.needId, mapping.regionId]);
    if (
      !nativeIds.has(id) ||
      !mapping.needId.trim() ||
      !mapping.regionId.trim() ||
      seen.has(key) ||
      mapping.evidence.length === 0 ||
      mapping.evidence.some((e) => !e.locator.trim() || !e.excerpt.trim())
    )
      invalid();
    seen.add(key);
    if (
      mapping.needId === requirement.needId &&
      mapping.regionId === requirement.regionId
    )
      selectedMappings.set(id, mapping);
  }

  const sources = new Map<string, ProjectReadinessSource>();
  const records: ProjectReadinessRecord[] = [];
  const unmappedRecordIds: string[] = [];
  for (const record of read.records) {
    const mapping = selectedMappings.get(
      record.sourceLocalIdentity.recordId.toLowerCase(),
    );
    if (!mapping) {
      unmappedRecordIds.push(record.sourceLocalIdentity.recordId);
      continue;
    }
    const source: ProjectReadinessSource = {
      ...sourceOf(record),
      track: requirement.track,
      kind: 'MONTHLY_REPORT',
      needIds: [requirement.needId],
      regionIds: [requirement.regionId],
    };
    sources.set(readinessSourceKey(source), source);
    const evidence: ReadinessEvidence[] = [
      {
        source,
        locator: record.locators.row,
        excerpt: `${record.originalName} | ${record.rawCategory}`,
      },
      ...mapping.evidence.map((item) => ({ ...item, source })),
    ];
    records.push({
      id: record.sourceLocalIdentity.recordId,
      source: sourceOf(record),
      needIds: source.needIds,
      regionIds: source.regionIds,
      object: {
        key: record.sourceLocalIdentity.recordId,
        originalName: record.originalName,
        markers: [],
        footnotes: [],
      },
      // A native row or title does not declare a publication series.
      series: null,
      time: record.time,
      rawValue: record.rawCategory,
      metric: {
        code: 'rawCategory',
        kind: 'CATEGORY',
        unit: null,
        method: null,
      },
      parsing: 'READY',
      professionalState: 'PENDING_REVIEW',
      evidence,
      spatial: {
        state: 'NAMED_ONLY',
        role: null,
        geometryKey: null,
        geometryKind: null,
      },
    });
  }
  const { track, ...required } = requirement;
  const readiness = calculateProjectReadiness({
    track,
    requirement: { ...required, dateRole: 'REPORT_PERIOD' },
    sources: [...sources.values()],
    records,
    series: [],
    correspondences: [],
  });
  return {
    ...originals,
    readiness,
    monthly: buildMonthlyReadout(readiness),
    unmappedRecordIds,
  };
}
