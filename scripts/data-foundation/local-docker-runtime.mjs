import { Buffer } from 'node:buffer';

function endpointError() {
  return new Error(
    'Local Docker endpoint must be an unambiguous local Unix socket.',
  );
}

function configured(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048 || /[\s\0]/.test(value))
    throw endpointError();
  return value;
}

function localEndpoint(value) {
  if (typeof value !== 'string' || !/^unix:\/\/\/[^%?#\s\0]+$/.test(value))
    throw endpointError();
  return value;
}

// Context inspection reads CLI metadata, not the engine. Pinning DOCKER_HOST
// makes the Docker CLI and Supabase's Docker client select the same endpoint.
export async function resolveLocalDockerEnvironment(environment, execute) {
  const context = configured(environment['DOCKER_CONTEXT']);
  const host = configured(environment['DOCKER_HOST']);
  if (context !== undefined && host !== undefined) throw endpointError();
  let endpoint = host;
  if (endpoint === undefined) {
    let output;
    try {
      output = await execute(
        'docker',
        [
          'context',
          'inspect',
          ...(context === undefined ? [] : [context]),
          '--format',
          '{{json .Endpoints.docker.Host}}',
        ],
        { environment },
      );
      if (typeof output !== 'string' || Buffer.byteLength(output) > 4096)
        throw endpointError();
      endpoint = JSON.parse(output);
    } catch {
      throw endpointError();
    }
  }
  endpoint = localEndpoint(endpoint);
  if (
    host === endpoint &&
    context === undefined &&
    environment['DOCKER_TLS_VERIFY'] === undefined &&
    environment['DOCKER_CERT_PATH'] === undefined
  )
    return environment;
  const pinned = { ...environment, DOCKER_HOST: endpoint };
  delete pinned['DOCKER_CONTEXT'];
  delete pinned['DOCKER_TLS_VERIFY'];
  delete pinned['DOCKER_CERT_PATH'];
  return Object.freeze(pinned);
}
