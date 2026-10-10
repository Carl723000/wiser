import 'server-only';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  fixedPublicReferenceHashes,
  parseFixedPublicReferences,
  parsePublicReferenceManifest,
  parsePublicReferenceFile,
  type PublicReferences,
} from './spatial-public-reference';
export interface PublicReferenceInput {
  publicReferenceState?: 'ready' | 'invalid' | 'unavailable';
  publicReferences?: PublicReferences | null;
}

/** Trusted server configuration only; public backgrounds never load a business pack. */
export async function loadPublicReferences(
  environment: Record<string, string | undefined>,
): Promise<PublicReferenceInput> {
  const regional = environment.WISER_SPATIAL_REGIONAL_REFERENCE_GEOJSON;
  const reaches = environment.WISER_SPATIAL_REACH_REFERENCE_GEOJSON;
  const manifestPath = environment.WISER_SPATIAL_PUBLIC_REFERENCE_MANIFEST;
  const manifestHash = environment.WISER_SPATIAL_PUBLIC_REFERENCE_SHA256;
  if (!regional && !reaches && !manifestPath && !manifestHash) return {};
  const read = async (
    path: string | undefined,
    expected: string,
    maxBytes: number,
    extension = '.geojson',
    consume?: (bytes: number) => void,
  ): Promise<unknown> => {
    if (!path) return null;
    if (!isAbsolute(path) || !path.endsWith(extension))
      throw new Error('Invalid local reference path');
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('Invalid local reference size');
    const bytes = await readFile(path);
    if (
      bytes.length > maxBytes ||
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      throw new Error('Local reference changed');
    consume?.(bytes.length);
    return JSON.parse(bytes.toString('utf8'));
  };
  try {
    // An explicitly configured manifest owns the complete background. Its failure
    // cannot fall back to a legacy subset or partially render the good files.
    if (manifestPath || manifestHash) {
      if (
        !manifestPath ||
        !manifestHash ||
        !/^[a-f0-9]{64}$/.test(manifestHash)
      )
        throw new Error('Invalid public reference manifest pin');
      let remainingBytes = 32 * 1024 * 1024;
      const consume = (bytes: number) => {
        remainingBytes -= bytes;
      };
      const manifest = parsePublicReferenceManifest(
        await read(manifestPath, manifestHash, 256 * 1024, '.json', consume),
      );
      const features: PublicReferences['features'] = [];
      // Sequential reads consume the aggregate budget before the next file is
      // allocated. A group cannot multiply the per-file memory allowance.
      for (const file of manifest.files) {
        const value = await read(
          file.path,
          file.sha256,
          Math.min(12 * 1024 * 1024, remainingBytes),
          '.geojson',
          consume,
        );
        features.push(...parsePublicReferenceFile(value, file).features);
      }
      if (
        new Set(features.map((feature) => feature.id)).size !== features.length
      )
        throw new Error('Duplicate public reference identity');
      return {
        publicReferenceState: 'ready',
        publicReferences: {
          type: 'FeatureCollection',
          features,
          manifest: {
            version: manifest.version,
            files: manifest.files.map(
              ({ path: _path, ...metadata }) => metadata,
            ),
          },
        },
      };
    }
    const [regionalInput, reachInput] = await Promise.all([
      read(regional, fixedPublicReferenceHashes.regional, 1024 * 1024),
      read(reaches, fixedPublicReferenceHashes.reaches, 256 * 1024),
    ]);
    return {
      publicReferenceState: 'ready',
      publicReferences: parseFixedPublicReferences(regionalInput, reachInput),
    };
  } catch (error) {
    return {
      publicReferenceState:
        error instanceof Error && 'code' in error ? 'unavailable' : 'invalid',
      publicReferences: null,
    };
  }
}
