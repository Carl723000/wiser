import { fromArrayBuffer } from 'geotiff';

/** Four retained 20 m TIFF derivatives of one scene, independently hashed on disk. */
export const RETAINED_RASTER_HASHES = {
  B03: 'ce2f3e34a59bb195ac4f0ee901f083681cc7b6a78138e2f74b13158488ce0a34',
  B8A: '6d7822cfdd6b04a38d2c69ff4ac3d97399ee8e6800d6e53924d23eee48615e25',
  SCL: '179a0ae54118bfe018c8cd577673137707caf76ab8721e693d24a217c8b2cd96',
  TCI: 'eda0c86c5069243c1dc788e5177b5c19daa502f37f83c879e3fd4e03a7520d67',
} as const;
export type CandidateRasterBand = keyof typeof RETAINED_RASTER_HASHES;
export const CANDIDATE_RASTER_BANDS = ['B03', 'B8A', 'SCL', 'TCI'] as const;
export const CANDIDATE_RASTER_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const CANDIDATE_RASTER_MAX_CELLS = 4096;
const GRID = { columns: 1080, rows: 1292 } as const;

export interface CandidateRasterWindow {
  readonly row: number;
  readonly column: number;
  readonly rows: number;
  readonly columns: number;
}
export type CandidateRasterQuality =
  | { readonly kind: 'raw' }
  | {
      readonly kind: 'scl-classes';
      readonly allowedClasses: readonly number[];
      readonly ruleVersion: string;
    };
export interface CandidateRasterSelection {
  readonly window: CandidateRasterWindow;
  readonly quality: CandidateRasterQuality;
  readonly bands: readonly CandidateRasterBand[];
}
export interface CandidateRasterDecode {
  readonly assets: readonly {
    readonly band: CandidateRasterBand;
    readonly sha256: string;
    readonly bytes: ArrayBuffer;
  }[];
  readonly window: CandidateRasterWindow;
  readonly quality: CandidateRasterQuality;
}
export interface CandidateRasterWindowResult {
  readonly window: CandidateRasterWindow;
  readonly crs: 'EPSG:32650';
  readonly affine: readonly [20, 0, 385180, 0, -20, 4481920];
  /** Encoded native values, without resampling, normalization or NoData inference. */
  readonly values: {
    readonly B03: Uint16Array;
    readonly B8A: Uint16Array;
    readonly SCL: Uint8Array;
    readonly TCI: readonly [Uint8Array, Uint8Array, Uint8Array];
  };
  /** The exact four TIFFs have all_valid masks; this is not a general TIFF mask decoder. */
  readonly validMask: Uint8Array;
  readonly qualityMask: Uint8Array;
  readonly quality: CandidateRasterQuality;
  readonly sourceProduct: string;
  readonly sensingTime: string;
}

function invalid(): never {
  throw new TypeError('Unsupported bounded candidate raster');
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Native row/column coordinates only; the selection never implies a map CRS transform. */
export function validateRasterSelection(
  raw: unknown,
): CandidateRasterSelection {
  const value = object(raw);
  const window = object(value?.window);
  const quality = object(value?.quality);
  const bands = value?.bands;
  if (!value || !window || !quality || !Array.isArray(bands)) invalid();
  const { row, column, rows, columns } = window;
  if (
    ![row, column, rows, columns].every(Number.isSafeInteger) ||
    (row as number) < 0 ||
    (column as number) < 0 ||
    (rows as number) < 1 ||
    (columns as number) < 1 ||
    (row as number) + (rows as number) > GRID.rows ||
    (column as number) + (columns as number) > GRID.columns ||
    (rows as number) * (columns as number) > CANDIDATE_RASTER_MAX_CELLS
  )
    invalid();
  if (
    bands.length !== 4 ||
    CANDIDATE_RASTER_BANDS.some((band) => !bands.includes(band)) ||
    new Set(bands).size !== 4
  )
    invalid();
  if (quality.kind === 'raw') {
    if (Object.keys(quality).length !== 1) invalid();
  } else if (quality.kind === 'scl-classes') {
    if (
      !Array.isArray(quality.allowedClasses) ||
      quality.allowedClasses.length < 1 ||
      quality.allowedClasses.length > 12 ||
      !quality.allowedClasses.every(
        (item) => Number.isInteger(item) && item >= 0 && item <= 11,
      ) ||
      new Set(quality.allowedClasses).size !== quality.allowedClasses.length ||
      typeof quality.ruleVersion !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(quality.ruleVersion) ||
      Object.keys(quality).length !== 3
    )
      invalid();
  } else invalid();
  return value as unknown as CandidateRasterSelection;
}

export function sclQualityMask(
  scl: Uint8Array,
  quality: CandidateRasterQuality,
): Uint8Array {
  if (quality.kind === 'raw') return new Uint8Array(scl.length).fill(1);
  const allowed = new Set(quality.allowedClasses);
  return Uint8Array.from(scl, (value) => (allowed.has(value) ? 1 : 0));
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** Runs inside one dedicated Worker in production. No GeoTIFF.js nested decoder Pool. */
export async function decodeCandidateRasterWindow(
  input: CandidateRasterDecode,
  signal: AbortSignal = new AbortController().signal,
): Promise<CandidateRasterWindowResult> {
  const selection = validateRasterSelection({
    ...input,
    bands: input.assets.map((asset) => asset.band),
  });
  if (signal.aborted) throw signal.reason;
  const byBand = new Map<
    CandidateRasterBand,
    CandidateRasterDecode['assets'][number]
  >();
  let compressedBytes = 0;
  for (const asset of input.assets) {
    if (
      !(asset.bytes instanceof ArrayBuffer) ||
      asset.sha256 !== RETAINED_RASTER_HASHES[asset.band] ||
      byBand.has(asset.band)
    )
      invalid();
    compressedBytes += asset.bytes.byteLength;
    if (
      asset.bytes.byteLength < 1 ||
      compressedBytes > CANDIDATE_RASTER_MAX_COMPRESSED_BYTES
    )
      invalid();
    byBand.set(asset.band, asset);
  }
  const values: {
    B03?: Uint16Array;
    B8A?: Uint16Array;
    SCL?: Uint8Array;
    TCI?: [Uint8Array, Uint8Array, Uint8Array];
  } = {};
  let sourceProduct: string | null = null;
  let sensingTime: string | null = null;
  for (const band of CANDIDATE_RASTER_BANDS) {
    if (signal.aborted) throw signal.reason;
    const asset = byBand.get(band);
    if (!asset || (await digest(asset.bytes)) !== RETAINED_RASTER_HASHES[band])
      invalid();
    const tiff = await fromArrayBuffer(asset.bytes, signal);
    if ((await tiff.getImageCount()) !== 1) invalid();
    const image = await tiff.getImage();
    const samples = band === 'TCI' ? 3 : 1;
    const bits = band === 'B03' || band === 'B8A' ? 16 : 8;
    const metadata = await image.getGDALMetadata();
    const product = metadata?.source_product;
    const time = metadata?.sensing_time;
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    if (
      image.getWidth() !== GRID.columns ||
      image.getHeight() !== GRID.rows ||
      image.getSamplesPerPixel() !== samples ||
      Array.from({ length: samples }, (_, index) => index).some(
        (index) =>
          image.getBitsPerSample(index) !== bits ||
          image.getSampleFormat(index) !== 1,
      ) ||
      image.getGeoKeys()?.ProjectedCSTypeGeoKey !== 32650 ||
      origin[0] !== 385180 ||
      origin[1] !== 4481920 ||
      resolution[0] !== 20 ||
      resolution[1] !== -20 ||
      !image.pixelIsArea() ||
      image.getGDALNoData() !== null ||
      metadata?.source_band !== band ||
      typeof product !== 'string' ||
      !product ||
      typeof time !== 'string' ||
      !time ||
      (sourceProduct !== null && product !== sourceProduct) ||
      (sensingTime !== null && time !== sensingTime)
    )
      invalid();
    sourceProduct = product;
    sensingTime = time;
    const { row, column, rows, columns } = selection.window;
    const rasters = await image.readRasters({
      window: [column, row, column + columns, row + rows],
      samples: Array.from({ length: samples }, (_, index) => index),
      signal,
    });
    if (
      rasters.length !== samples ||
      rasters.some((raster) => raster.length !== rows * columns)
    )
      invalid();
    if (band === 'B03' || band === 'B8A') {
      if (!(rasters[0] instanceof Uint16Array)) invalid();
      if (band === 'B03') values.B03 = rasters[0];
      else values.B8A = rasters[0];
    } else if (band === 'SCL') {
      if (!(rasters[0] instanceof Uint8Array)) invalid();
      values.SCL = rasters[0];
    } else {
      if (rasters.some((raster) => !(raster instanceof Uint8Array))) invalid();
      values.TCI = [
        rasters[0] as Uint8Array,
        rasters[1] as Uint8Array,
        rasters[2] as Uint8Array,
      ];
    }
  }
  if (
    !values.B03 ||
    !values.B8A ||
    !values.SCL ||
    !values.TCI ||
    !sourceProduct ||
    !sensingTime
  )
    invalid();
  const length = selection.window.rows * selection.window.columns;
  return {
    window: selection.window,
    crs: 'EPSG:32650',
    affine: [20, 0, 385180, 0, -20, 4481920],
    values: values as CandidateRasterWindowResult['values'],
    validMask: new Uint8Array(length).fill(255),
    qualityMask: sclQualityMask(values.SCL, selection.quality),
    quality: selection.quality,
    sourceProduct,
    sensingTime,
  };
}
