import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { WorkspacePack } from './spatial-workspace-contract';
import { parseWorkspacePack } from './spatial-workspace-pack';

export type LocalSpatialState =
  'ready' | 'disabled' | 'unavailable' | 'invalid';
export interface LocalSpatialInput {
  state: LocalSpatialState;
  pack: WorkspacePack | null;
}

export function isLocalSpatialPreview(
  environment: Record<string, string | undefined>,
  host: string | null,
): boolean {
  return (
    environment.NODE_ENV !== 'production' &&
    environment.WISER_AUTH_MODE === 'off' &&
    environment.WISER_SPATIAL_WORKSPACE_MODE === 'local' &&
    !!host &&
    /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host)
  );
}

/** A local processing workbench; never a fallback for an authorized Data API read. */
export async function loadLocalSpatialWorkspace(
  environment: Record<string, string | undefined>,
  host: string | null,
): Promise<LocalSpatialInput> {
  if (!isLocalSpatialPreview(environment, host))
    return { state: 'disabled', pack: null };
  const path = environment.WISER_SPATIAL_INPUT_MANIFEST;
  if (!path || !isAbsolute(path) || !path.endsWith('.json'))
    return { state: 'unavailable', pack: null };
  let content: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 12 * 1024 * 1024)
      return { state: 'invalid', pack: null };
    content = await readFile(path, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 12 * 1024 * 1024)
      return { state: 'invalid', pack: null };
  } catch {
    return { state: 'unavailable', pack: null };
  }
  try {
    return { state: 'ready', pack: parseWorkspacePack(JSON.parse(content)) };
  } catch {
    return { state: 'invalid', pack: null };
  }
}
