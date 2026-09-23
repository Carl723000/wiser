export class ResourceAdministrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResourceAdministrationError';
  }
}
export function resourceAdministrationFailure(code: string): never {
  throw new ResourceAdministrationError(code);
}
