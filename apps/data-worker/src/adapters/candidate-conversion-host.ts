import type { CandidateConversionRunner } from '../handlers/candidate-conversion.js';

export interface CandidateConversionHostConfig {
  readonly converter: {
    readonly executablePath: string;
    readonly sha256: string;
    readonly version: string;
    readonly platform: NodeJS.Platform;
  };
  readonly structure: {
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly scriptSha256: string;
    readonly pythonImportPath?: string;
  };
  readonly maximumMilliseconds?: number;
  readonly authorityIntervalMilliseconds?: number;
  readonly temporaryRoot?: string;
}

/** Explicit trusted-host configuration only; no implicit converter discovery. */
export function createCandidateConversionHostRunner(
  _config: CandidateConversionHostConfig,
): CandidateConversionRunner {
  throw new Error('Bounded conversion host is not implemented');
}
