import type {
  IngestionCandidateBatch,
  IngestionCandidateRecordPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';

export const CANDIDATE_MONTHLY_RULE_VERSION = 'beijing-monthly-docx-c3/1.0.0';

export interface CandidateMonthlyProjectionInput {
  readonly batch: IngestionCandidateBatch;
  readonly pages: readonly IngestionCandidateRecordPage[];
  readonly fixed: {
    readonly workId: string;
    readonly assetId: string;
    readonly sourceHash: string;
  };
}

export interface CandidateMonthlyProjectedRecord {
  readonly candidateReference: IngestionCandidateReference;
  readonly source: {
    readonly workId: string;
    readonly assetId: string;
    readonly originalSha256: string;
  };
  readonly sourceLocalIdentity: {
    readonly recordId: string;
    readonly sourceId: string | null;
    readonly index: number;
  };
  readonly objectType: 'RIVER_REACH' | 'LAKE' | 'RESERVOIR';
  readonly originalName: string;
  readonly waterSystemOriginal: string | null;
  readonly districtOriginal: string;
  readonly rawCategory: string;
  readonly time: {
    readonly value: string;
    readonly role: 'PUBLICATION';
    readonly precision: 'MONTH';
  };
  readonly locators: {
    readonly title: string;
    readonly row: string;
    readonly nameCell: string;
    readonly categoryCell: string;
    readonly districtCell: string;
    readonly waterSystemCell: string | null;
  };
  readonly processingRuleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
}

export type CandidateMonthlyUnparsedReason =
  | 'INVALID_INPUT'
  | 'INCOMPLETE_RECORD_PAGES'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_CHANGED'
  | 'UNKNOWN_LAYOUT';

export type CandidateMonthlyProjection =
  | {
      readonly kind: 'READY';
      readonly reason: null;
      readonly ruleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly publicationMonth: string;
      readonly records: readonly CandidateMonthlyProjectedRecord[];
    }
  | {
      readonly kind: 'NOT_PARSED';
      readonly reason: CandidateMonthlyUnparsedReason;
      readonly ruleVersion: typeof CANDIDATE_MONTHLY_RULE_VERSION;
      readonly publicationMonth: null;
      readonly records: readonly [];
    };

/** Pure projection only: the candidate authority and current read permission live upstream. */
export function projectCandidateMonthlyReport(
  _input: CandidateMonthlyProjectionInput,
): CandidateMonthlyProjection {
  return {
    kind: 'NOT_PARSED',
    reason: 'UNKNOWN_LAYOUT',
    ruleVersion: CANDIDATE_MONTHLY_RULE_VERSION,
    publicationMonth: null,
    records: [],
  };
}
