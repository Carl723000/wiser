/** Task-host observation inputs only. Does not launch, register or issue verified authority. */
import type {
  RuntimeObservationBinding,
  RuntimeWindowReason,
} from './a12-normal-runtime-window.ts';
export interface A12NativeFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
export interface A12NativeRootPin {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly identity?: A12NativeFileIdentity;
}
export interface A12NativePathPin {
  readonly path: string;
  readonly realPath: string;
  readonly identity: A12NativeFileIdentity;
}
// Pins/selectors are read inputs only. The factory does not attest a launch or issue authority.
export interface A12NativeFilePin {
  readonly path: string;
  readonly sha256: string;
  readonly realPath: string;
  readonly identity: A12NativeFileIdentity;
}
export interface A12NativeService {
  readonly service: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly startedAt: string;
  readonly restartGeneration: number;
  readonly ownerLabelKey:
    'com.docker.compose.project' | 'com.supabase.cli.project';
  readonly ownerLabelValue: string;
  readonly mountsSha256: string;
  readonly portsSha256: string;
}
/** Inputs selected by the task-private launcher. These ordinary values cannot attest that it ran. */
export interface A12NativeRuntimeSelectors {
  readonly dockerExecutable: string;
  readonly daemonSocket: string;
  readonly services: readonly A12NativeService[];
  readonly sourceBuildFiles: readonly A12NativeFilePin[];
  readonly configurationFiles: readonly A12NativeFilePin[];
  readonly appliedMigrationReceipt: A12NativeFilePin;
  readonly signatureSourceReceipt: A12NativeFilePin;
  readonly signatureContainerId: string;
  readonly signatureFiles: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly rootPins: readonly A12NativeRootPin[];
  readonly executablePin: A12NativePathPin;
  readonly socketPin: A12NativePathPin;
  readonly observerDockerConfigRoot: A12NativeRootPin & {
    readonly identity: A12NativeFileIdentity;
  };
}

/** Trusted task host supplies the explicit local read scope. Values are not launch evidence. */
export interface A12NativeRuntimePolicy {
  readonly workspaceRoot: string;
  readonly runtimeRoots: readonly string[];
  readonly dockerExecutablePaths: readonly string[];
  readonly daemonSocketPaths: readonly string[];
}
export type A12NativeRuntimeObservation =
  | { readonly status: 'observed'; readonly binding: RuntimeObservationBinding }
  | {
      readonly status: 'unknown' | 'rejected';
      readonly reason: RuntimeWindowReason;
    };
export function createA12NativeRuntimeObserver(
  selectors: A12NativeRuntimeSelectors,
  policy: A12NativeRuntimePolicy,
): (signal: AbortSignal) => Promise<A12NativeRuntimeObservation> {
  void selectors;
  void policy;
  return (_signal) =>
    Promise.resolve({
      status: 'unknown',
      reason: 'observation_missing',
    });
}
