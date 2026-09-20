import type { ExternalMetadataProviderPort } from './external-metadata.js';

export interface ExternalMetadataHttpOptions {
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorization?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLoopback?: boolean;
}

export class ExternalMetadataHttpProvider implements ExternalMetadataProviderPort {
  constructor(_options: ExternalMetadataHttpOptions) {}
  readPage(
    _input: Parameters<ExternalMetadataProviderPort['readPage']>[0],
  ): Promise<unknown> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }
}
