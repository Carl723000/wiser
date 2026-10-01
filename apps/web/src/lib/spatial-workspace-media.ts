import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { isLocalSpatialPreview } from './spatial-workspace-local';

/** Only local generated PNGs; no remote fetch, original download or path selected by a user. */
export async function loadSpatialMedia(
  environment: Record<string, string | undefined>,
  host: string | null,
  filename: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const root = environment.WISER_SPATIAL_MEDIA_DIRECTORY;
  if (
    !isLocalSpatialPreview(environment, host) ||
    !root ||
    !isAbsolute(root) ||
    !/^[a-zA-Z0-9_-]+\.png$/.test(filename)
  )
    return null;
  try {
    const directory = await realpath(root),
      path = await realpath(join(directory, filename));
    if (dirname(path) !== directory) return null;
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
    const bytes = await readFile(path);
    if (
      bytes.length > 2 * 1024 * 1024 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}
