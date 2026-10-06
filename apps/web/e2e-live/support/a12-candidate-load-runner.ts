import type {
  CandidateLoadAuthCondition,
  CandidateLoadAuthGuard,
} from './a12-candidate-load-auth.ts';
import type { CandidateLoadHttpAdapter } from './a12-candidate-load-http.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadConditionResult,
  LoadDataset,
  LoadFailure,
  LoadPorts,
} from './a12-candidate-load-driver.ts';
import type { TraversalIteration } from './a12-candidate-load-traversal.ts';

/** Private test runner input; never a package DTO or server-issued checkpoint. */
export interface A12ArtifactPin {
  readonly path: string;
  readonly sha256: string;
}
export interface A12MemberPin {
  readonly receipt: A12ArtifactPin;
  readonly inventory: A12ArtifactPin;
  readonly standardCapture: A12ArtifactPin;
  readonly preparedAssets: readonly {
    readonly assetId: string;
    readonly artifact: A12ArtifactPin;
    readonly sizeBytes: number;
  }[];
  readonly sourceManifest?: A12ArtifactPin;
}
export interface A12TrackPin {
  readonly dataset: LoadDataset;
  readonly declared: {
    readonly members: number;
    readonly assets: number;
    readonly records: number;
    readonly geometry: number;
  };
  /** Frozen representative candidate for each of the six size/action pairs. */
  readonly sampleMembers: Readonly<Record<LoadAction, number>>;
  readonly members: readonly A12MemberPin[];
}
export interface A12RunInput {
  readonly registrationId: 'GOAL101-A12-20261004';
  readonly scope: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly purpose: string;
  };
  readonly tracks: readonly [
    A12TrackPin & { readonly dataset: 'AUTHENTICATED-REAL' },
    A12TrackPin & { readonly dataset: 'SYNTHETIC-S10' },
  ];
}
export interface A12AdmittedRun {
  readonly scope: A12RunInput['scope'];
  readonly tracks: readonly {
    readonly dataset: LoadDataset;
    readonly sampleMembers: A12TrackPin['sampleMembers'];
    readonly members: readonly FrozenCandidateDataset[];
  }[];
}
export type A12PreflightReason =
  | 'runner_not_implemented'
  | 'configuration'
  | 'artifact_read_failed'
  | 'artifact_hash_mismatch'
  | 'receipt_link_mismatch'
  | 'standard_intake_unverified'
  | 'incomplete_inventory';
export type A12Admission =
  | { readonly status: 'ready'; readonly input: A12AdmittedRun }
  | { readonly status: 'not_run'; readonly reason: A12PreflightReason };
export interface A12DispatchLocation {
  readonly phase: 'condition' | 'traversal';
  readonly trackOrdinal: number;
  readonly memberOrdinal: number;
  readonly conditionOrdinal: number | null;
  readonly roundOrdinal: number | null;
}
export interface A12StandardIntakeCheck {
  /** Parsed existing public request/response captures, kept private. */
  readonly receipt: unknown;
  readonly captureBytes: Uint8Array;
  readonly prepared: readonly {
    readonly assetId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly inventory: FrozenCandidateDataset;
}
export interface A12RunnerPorts {
  /** Returns actual bytes. The runner recomputes SHA256; metadata is not proof. */
  readonly readArtifact: (pin: A12ArtifactPin) => Promise<Uint8Array>;
  /**
   * A task-private verifier over actual normal-stack scanner/fingerprint evidence.
   * Generic Operation messages/READY/complete-upload submitted SHA are insufficient.
   * Fake verified results test orchestration only; unknown blocks formal dispatch.
   */
  readonly verifyStandardIntake: (
    check: A12StandardIntakeCheck,
  ) => Promise<'verified' | 'unknown' | 'rejected'>;
  readonly authenticate: (
    scope: A12RunInput['scope'],
  ) => Promise<CandidateLoadAuthGuard>;
  readonly createTransport: (
    condition: CandidateLoadAuthCondition,
    location: A12DispatchLocation,
  ) => CandidateLoadHttpAdapter;
  readonly now: LoadPorts['now'];
  readonly fingerprint: LoadPorts['fingerprint'];
}
export interface A12PageSample {
  readonly trackOrdinal: number;
  readonly roundOrdinal: number;
  readonly memberOrdinal: number;
  readonly pageOrdinal: number;
  readonly action: LoadAction;
  readonly elapsedMs: number | null;
  readonly outcome: 'completed' | LoadFailure;
  readonly wireBytes: number | null;
}
export interface A12RunResult {
  readonly registrationId: 'GOAL101-A12-20261004';
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: A12PreflightReason | LoadFailure | null;
  /** This slice never certifies the 60-minute, memory, first-screen or cold exits. */
  readonly formalA12: 'not_run';
  readonly conditions: readonly {
    readonly trackOrdinal: number;
    readonly memberOrdinal: number;
    readonly ordinal: number;
    readonly result: LoadConditionResult;
  }[];
  readonly rounds: readonly {
    readonly trackOrdinal: number;
    readonly ordinal: number;
    readonly members: readonly {
      readonly memberOrdinal: number;
      readonly result: TraversalIteration;
    }[];
  }[];
  readonly pageSamples: readonly A12PageSample[];
}

/** Behavioral Red placeholder; no ports or network are invoked. */
export function admitA12RunInput(
  value: unknown,
  ports: A12RunnerPorts,
): Promise<A12Admission> {
  void value;
  void ports;
  return Promise.resolve({
    status: 'not_run',
    reason: 'runner_not_implemented',
  });
}

/** Behavioral Red placeholder; real driver/traversal calls belong in Green. */
export function runA12CandidateMatrix(
  value: unknown,
  ports: A12RunnerPorts,
): Promise<A12RunResult> {
  void value;
  void ports;
  return Promise.resolve({
    registrationId: 'GOAL101-A12-20261004',
    status: 'not_run',
    reason: 'runner_not_implemented',
    formalA12: 'not_run',
    conditions: [],
    rounds: [],
    pageSamples: [],
  });
}
