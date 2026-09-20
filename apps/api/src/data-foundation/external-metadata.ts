// Red checkpoint: implement source-specific authorization before registering an HTTP capability.
export class ExternalMetadataReader {
  constructor(_options: unknown) {}
  read(_request: unknown, _context: unknown): Promise<Record<string, unknown>> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }
}
