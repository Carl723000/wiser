import { DataFoundationDomainError } from './domain-error.js';

export type ProjectReadinessTrack = 'REAL' | 'SYNTHETIC';
export interface ReadinessSourceReference {
  readonly workId: string;
  readonly versionId: string;
  readonly assetId: string;
}
export interface ReadinessEvidence {
  readonly source: ReadinessSourceReference;
  readonly locator: string;
  readonly excerpt: string;
}
export interface ProjectReadinessSource extends ReadinessSourceReference {
  readonly track: ProjectReadinessTrack;
  readonly kind:
    'MONTHLY_REPORT' | 'TABLE' | 'DOCUMENT' | 'VECTOR' | 'RASTER' | 'DIRECTORY';
  readonly needIds: readonly string[];
  readonly regionIds: readonly string[];
}
export type ReadinessReviewState =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'REQUIRES_CORRECTION';
export interface ProjectReadinessRecord {
  readonly id: string;
  readonly source: ReadinessSourceReference;
  readonly needIds: readonly string[];
  readonly regionIds: readonly string[];
  readonly object: {
    readonly key: string;
    readonly originalName: string;
    readonly markers: readonly string[];
    readonly footnotes: readonly ReadinessEvidence[];
  } | null;
  readonly series: { readonly id: string; readonly version: string } | null;
  readonly time: {
    readonly value: string | null;
    readonly role: 'PUBLICATION' | 'OBSERVATION' | 'EVENT' | 'UNKNOWN';
    readonly precision: 'MONTH' | 'DAY' | 'YEAR' | 'UNKNOWN';
  };
  readonly rawValue: string | number | null;
  readonly metric: {
    readonly code: string;
    readonly kind: 'CATEGORY' | 'CONCENTRATION' | 'FLOW' | 'OTHER';
    readonly unit: string | null;
    readonly method: string | null;
  } | null;
  readonly parsing: 'READY' | 'PARTIAL' | 'NOT_PARSED' | 'FAILED';
  readonly professionalState: ReadinessReviewState;
  readonly evidence: readonly ReadinessEvidence[];
  readonly spatial: {
    readonly state: 'LOCATED' | 'NAMED_ONLY' | 'UNKNOWN';
    readonly role: string | null;
    readonly geometryKey: string | null;
    readonly geometryKind: 'POINT' | 'LINE' | 'AREA' | 'MIXED' | null;
  } | null;
}
export interface ReadinessPublicationSeries {
  readonly id: string;
  readonly version: string;
  readonly sources: readonly ReadinessSourceReference[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessCorrespondence {
  readonly id: string;
  readonly memberRecordIds: readonly string[];
  readonly status: ReadinessReviewState;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessFactScope {
  readonly recordIds: readonly string[];
  readonly sources: readonly ReadinessSourceReference[];
}
export interface ReadinessCheck extends ReadinessFactScope {
  readonly id: string;
  readonly kind:
    'INTEGRITY' | 'PARSING' | 'UNITS' | 'POSITION' | 'PURPOSE' | 'DUPLICATES';
  readonly state: 'PASSED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  readonly findings: readonly string[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessField {
  readonly id: string;
  readonly source: ReadinessSourceReference;
  readonly name: string;
  readonly type: string;
  readonly unit: string | null;
  readonly timeRole: string | null;
  readonly positionRole: string | null;
  readonly primaryKey: boolean | null;
  readonly formatVersion: string | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessProcessingTask extends ReadinessFactScope {
  readonly id: string;
  readonly kind: 'CLEANING' | 'QUALITY_CONTROL';
  readonly state: 'OPEN' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly processor: {
    readonly name: string;
    readonly version: string;
  } | null;
  readonly owner: string | null;
  readonly nextAction: string | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessUseCheck {
  readonly id: string;
  readonly purpose: string;
  readonly computation:
    'CATEGORY_REVIEW' | 'CONCENTRATION_DIFFERENCE' | 'FLUX' | 'OTHER';
  readonly state: 'CHECKS_PASSED' | 'LIMITED' | 'BLOCKED' | 'UNKNOWN';
  readonly recordIds: readonly string[];
  readonly reasons: readonly string[];
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ReadinessReconciliation {
  readonly id: string;
  readonly status: 'CANDIDATE' | 'VERIFIED' | 'REJECTED';
  readonly recordIds: readonly string[];
  readonly independentObservationCount: number | null;
  readonly evidence: readonly ReadinessEvidence[];
}
export interface ProjectReadinessInput {
  readonly track: ProjectReadinessTrack;
  readonly requirement: {
    readonly needId: string;
    readonly version: string;
    readonly regionId: string;
    readonly purpose: string;
    readonly dateRole: 'PUBLICATION' | 'OBSERVATION' | 'EVENT';
    readonly window: { readonly start: string; readonly end: string } | null;
  };
  readonly sources: readonly ProjectReadinessSource[];
  readonly records: readonly ProjectReadinessRecord[];
  readonly series: readonly ReadinessPublicationSeries[];
  readonly correspondences: readonly ReadinessCorrespondence[];
  readonly checks?: readonly ReadinessCheck[];
  readonly fields?: readonly ReadinessField[];
  readonly tasks?: readonly ReadinessProcessingTask[];
  readonly useChecks?: readonly ReadinessUseCheck[];
  readonly reconciliations?: readonly ReadinessReconciliation[];
  readonly selectedReconciliationId?: string;
  readonly areaDenominator?: {
    readonly recordIds: readonly string[];
    readonly areaKm2: number;
    readonly evidence: readonly ReadinessEvidence[];
  };
}
export type ReadinessValueKind =
  | 'CATEGORY'
  | 'CATEGORY_RANGE'
  | 'DRY'
  | 'UNMONITORED'
  | 'NULL'
  | 'EMPTY'
  | 'NUMERIC'
  | 'TEXT';
export interface ReadinessValue {
  readonly raw: string | number | null;
  readonly kind: ReadinessValueKind;
  readonly numericValue: number | null;
}
export interface ReadinessCoverageRow {
  readonly objectKeys: readonly string[];
  readonly originalNames: readonly string[];
  readonly recordIds: readonly string[];
  readonly observedMonths: readonly string[];
  readonly missingMonths: readonly string[] | null;
}
export interface ReadinessQuestion {
  readonly id:
    | 'KINDS'
    | 'COUNTS'
    | 'QUALITY'
    | 'STRUCTURE'
    | 'DENSITY'
    | 'GAPS'
    | 'CLEANING'
    | 'QUALITY_CONTROL'
    | 'COMPUTATIONS';
  readonly state: 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
  readonly drilldowns: readonly {
    readonly grain:
      | 'WORK'
      | 'VERSION'
      | 'ASSET'
      | 'SOURCE_OBJECT'
      | 'RECORD'
      | 'CHECK'
      | 'FIELD'
      | 'COVERAGE_CELL'
      | 'TASK'
      | 'USE_CHECK'
      | 'CORRESPONDENCE';
    readonly ids: readonly string[];
  }[];
}
export interface ProjectReadinessResult {
  readonly ruleVersion: string;
  readonly track: ProjectReadinessTrack;
  readonly requirement: ProjectReadinessInput['requirement'];
  readonly counts: {
    readonly works: number;
    readonly versions: number;
    readonly assets: number;
    readonly sourceObjects: number;
    readonly records: number;
    readonly monthlyRecords: number;
    readonly nonMonthlyRecords: number;
    readonly knownGeometries: number;
    readonly independentObservations: number | null;
  };
  readonly monthly: {
    readonly namedObjectCount: number | null;
    readonly undeclaredRecordIds: readonly string[];
    readonly unknownTimeRecordIds: readonly string[];
    readonly requiredMonths: readonly string[] | null;
    readonly raw: readonly ReadinessCoverageRow[];
    readonly approved: readonly ReadinessCoverageRow[];
    readonly hypothetical: readonly ReadinessCoverageRow[];
    readonly appliedApprovedIds: readonly string[];
    readonly appliedHypothesisIds: readonly string[];
  };
  readonly density: {
    readonly areaKm2: number | null;
    readonly observationsPerKm2: number | null;
    readonly reason:
      'KNOWN' | 'NOT_CONFIRMED' | 'SCOPE_MISMATCH' | 'DENOMINATOR_UNKNOWN';
  };
  readonly records: readonly ProjectReadinessRecord[];
  readonly values: readonly (ReadinessValue & { readonly recordId: string })[];
  readonly checks: readonly ReadinessCheck[];
  readonly fields: readonly ReadinessField[];
  readonly tasks: readonly ReadinessProcessingTask[];
  readonly useChecks: readonly ReadinessUseCheck[];
  readonly questions: readonly ReadinessQuestion[];
}

export function classifyReadinessValue(
  _raw: string | number | null,
): ReadinessValue {
  throw new DataFoundationDomainError(
    'PROJECT_READINESS_NOT_IMPLEMENTED',
    'Project readiness rules are not implemented.',
  );
}

export function calculateProjectReadiness(
  _input: ProjectReadinessInput,
): ProjectReadinessResult {
  throw new DataFoundationDomainError(
    'PROJECT_READINESS_NOT_IMPLEMENTED',
    'Project readiness rules are not implemented.',
  );
}
