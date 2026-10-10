import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  calculateProjectReadiness,
  type ProjectReadinessInput,
} from '@wiser/data-core/project-readiness';
import type { WorkspacePack } from './spatial-workspace-contract';
import { parseWorkspacePack } from './spatial-workspace-pack';
import {
  parseLocalReadinessFacts,
  readableLocalReadinessFacts,
} from './spatial-readiness-input';
import type { PublicReferences } from './spatial-public-reference';
import { loadPublicReferences } from './spatial-public-reference.server';

export type LocalSpatialState =
  'ready' | 'disabled' | 'unavailable' | 'invalid';
export interface LocalSpatialInput {
  state: LocalSpatialState;
  pack: WorkspacePack | null;
  readinessState?: 'absent' | 'ready' | 'invalid' | 'unavailable';
  readinessFacts?: ProjectReadinessInput | null;
  publicReferenceState?: 'ready' | 'invalid' | 'unavailable';
  publicReferences?: PublicReferences | null;
}

async function loadReadinessFacts(
  environment: Record<string, string | undefined>,
  pack: WorkspacePack,
): Promise<Pick<LocalSpatialInput, 'readinessState' | 'readinessFacts'>> {
  const path = environment.WISER_SPATIAL_READINESS_INPUT_MANIFEST;
  const hash = environment.WISER_SPATIAL_READINESS_INPUT_SHA256;
  if (!path && !hash) return { readinessState: 'absent', readinessFacts: null };
  if (
    !path ||
    !isAbsolute(path) ||
    !path.endsWith('.json') ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    return { readinessState: 'invalid', readinessFacts: null };
  let content: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 12 * 1024 * 1024)
      return { readinessState: 'invalid', readinessFacts: null };
    content = await readFile(path, 'utf8');
    if (
      Buffer.byteLength(content, 'utf8') > 12 * 1024 * 1024 ||
      createHash('sha256').update(content).digest('hex') !== hash
    )
      return { readinessState: 'invalid', readinessFacts: null };
  } catch {
    return { readinessState: 'unavailable', readinessFacts: null };
  }
  try {
    const parsed = parseLocalReadinessFacts(JSON.parse(content));
    calculateProjectReadiness(parsed);
    const readinessFacts = readableLocalReadinessFacts(pack, parsed);
    return { readinessState: 'ready', readinessFacts };
  } catch {
    return { readinessState: 'invalid', readinessFacts: null };
  }
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
    const pack = parseWorkspacePack(JSON.parse(content));
    return {
      state: 'ready',
      pack,
      ...(await loadReadinessFacts(environment, pack)),
      ...(await loadPublicReferences(environment)),
    };
  } catch {
    return { state: 'invalid', pack: null };
  }
}
