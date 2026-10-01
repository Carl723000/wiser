/** Offline protocol only. No provider address, credential, authority or public DTO. */
export type CnemcResource = 'daily' | 'monthly';
export type CnemcCell = string | number | null;
export type CnemcRow = Readonly<Record<string, CnemcCell>>;
export type CnemcQuery =
  | {
      readonly resource: 'daily';
      readonly startDate: string;
      readonly endDate: string;
      readonly evaluationSystem?: '十四五' | '十五五';
      readonly stationCode?: string;
    }
  | {
      readonly resource: 'monthly';
      readonly year: number;
      readonly month: number;
      readonly datatype: 'month' | 'months';
    };

export type CnemcIssue =
  | 'INVALID_QUERY'
  | 'UNSUPPORTED_QUERY'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_RESPONSE'
  | 'SOURCE_AUTHENTICATION'
  | 'SOURCE_XML_ERROR'
  | 'SOURCE_BUSINESS_ERROR'
  | 'SOURCE_REDIRECT'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_TIMEOUT'
  | 'CANCELLED'
  | 'RESPONSE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING'
  | 'NO_PAGES'
  | 'OFFSET_DISCONTINUITY'
  | 'RESOURCE_CHANGED'
  | 'TOTAL_CHANGED'
  | 'EARLY_EMPTY_PAGE'
  | 'SHORT_PAGE'
  | 'REPEATED_PAGE'
  | 'REPEATED_ROW'
  | 'EXCESS_ROWS'
  | 'MISSING_PAGE'
  | 'PAGE_LIMIT';

export class CnemcOfflineError extends Error {
  readonly code: CnemcIssue;
  constructor(code: CnemcIssue) {
    super(code);
    this.name = 'CnemcOfflineError';
    this.code = code;
  }
}

export const CNEMC_PAGE_SIZE = 1000;
export const CNEMC_FIELDS: Readonly<Record<CnemcResource, readonly string[]>> =
  {
    daily: [
      'stationCode',
      'factorCode',
      'measureDate',
      'evaluation_system',
      'dataType',
      'measureDateStr',
      'stationName',
      'stationId',
      'sectionType',
      'basinName',
      'assessProvinceName',
      'liabilityCityName',
      'rankCityName',
      'riverName',
      'riverLevel',
      'waterLevel',
      'exceedFactor',
      'factorVal',
      'factorId',
      'factorName',
      'factorValue',
      'factorNumValue',
      'identifyFlag',
      'whse_tm',
    ],
    monthly: [
      'datatype',
      'wq_inf_month',
      'wq_inf_year',
      'wq_pi_code',
      'area_name',
      'assessment_prov',
      'auto_station_prop',
      'basin_name',
      'classification_index',
      'dow_water_type',
      'duty_city',
      'into_seaarea',
      'lake_district',
      'lm_decisive_items',
      'lm_over_items',
      'ly_decisive_items',
      'ly_over_items',
      'major_point',
      'num_of_participants',
      'op_time',
      'origin_goal',
      'pkid',
      'pollution_parameter',
      'province_name',
      'ranking_city',
      'rl_code',
      'rl_flag',
      'rl_import_rlname',
      'rl_name',
      'rl_property',
      'rs_name',
      'up_water_type',
      'w01001',
      'w01003',
      'w01004',
      'w01009',
      'w01010',
      'w01014',
      'w01017',
      'w01018',
      'w01019',
      'w01022',
      'w01024',
      'w02003',
      'w19002',
      'w20111',
      'w20115',
      'w20117',
      'w20119',
      'w20120',
      'w20122',
      'w20123',
      'w20124',
      'w20128',
      'w21001',
      'w21003',
      'w21006',
      'w21007',
      'w21011',
      'w21016',
      'w21017',
      'w21019',
      'w21038',
      'w22001',
      'w23002',
      'w99029',
      'w99030',
      'w99042',
      'w99069',
      'water_type',
      'waterfunction_name',
      'with_auto_station',
      'wq_inf_time',
      'wq_pi_function',
      'wq_pi_lad',
      'wq_pi_lod',
      'wq_pi_name',
      'wq_pi_prop',
      'wq_pi_time_interval',
      'year_up_to_goal',
      'liabilitydistrictname',
      'w20004',
      'w20061',
      'w20089',
      'remarktype',
      'remark',
      'icityriver',
      'importantseaarea',
      'backgroundfactor',
      'graincounty',
      'vegetablecounty',
      'animalcounty',
      'newsectioncode',
      'newrivercode',
      'sectionid',
      'original_wq_inf_month',
      'poorwaterflag',
      'tncontrol',
    ],
  };

const mixedFields = new Set([
  'factorVal',
  'factorValue',
  'factorNumValue',
  'dataType',
  'sectionType',
  'riverLevel',
  'waterLevel',
  'identifyFlag',
  'wq_inf_year',
  'wq_inf_month',
  'num_of_participants',
  'dow_water_type',
  'up_water_type',
  'water_type',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: CnemcIssue): never {
  throw new CnemcOfflineError(code);
}
function safeInteger(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function offsetValid(offset: number) {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset % CNEMC_PAGE_SIZE === 0
  );
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]!
  );
}
function label(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

export interface CnemcRequest {
  readonly resource: CnemcResource;
  readonly method: 'POST';
  readonly path: '/synthetic/daily' | '/synthetic/monthly';
  readonly body: '';
  readonly query: Readonly<Record<string, string>>;
  readonly uniqueIdSemantics: 'unknown';
}
export function buildCnemcRequest(query: CnemcQuery, offset = 0): CnemcRequest {
  if (!object(query) || !offsetValid(offset)) fail('INVALID_QUERY');
  let parameters: Record<string, string>;
  if (query.resource === 'daily') {
    const allowed = new Set([
      'resource',
      'startDate',
      'endDate',
      'evaluationSystem',
      'stationCode',
    ]);
    if (
      Object.keys(query).some((key) => !allowed.has(key)) ||
      !calendarDate(query.startDate) ||
      !calendarDate(query.endDate) ||
      query.startDate > query.endDate ||
      (query.evaluationSystem !== undefined &&
        !['十四五', '十五五'].includes(query.evaluationSystem)) ||
      (query.stationCode !== undefined && !label(query.stationCode))
    )
      fail('INVALID_QUERY');
    parameters = { start_date: query.startDate, end_date: query.endDate };
    if (query.evaluationSystem !== undefined)
      parameters.evaluation_system = query.evaluationSystem;
    if (query.stationCode !== undefined)
      parameters.stationCode = query.stationCode;
  } else if (query.resource === 'monthly') {
    if (query.datatype === 'months') fail('UNSUPPORTED_QUERY');
    const allowed = new Set(['resource', 'year', 'month', 'datatype']);
    if (
      Object.keys(query).some((key) => !allowed.has(key)) ||
      query.datatype !== 'month' ||
      !Number.isInteger(query.year) ||
      query.year < 1000 ||
      query.year > 9999 ||
      !Number.isInteger(query.month) ||
      query.month < 1 ||
      query.month > 12
    )
      fail('INVALID_QUERY');
    const month = String(query.month).padStart(2, '0');
    parameters = {
      datatype: 'month',
      wq_inf_year: String(query.year),
      wq_inf_month: query.month < 10 ? `'${month}'` : month,
    };
  } else fail('INVALID_QUERY');
  parameters.offsetValue = String(offset);
  return {
    resource: query.resource,
    method: 'POST',
    path: `/synthetic/${query.resource}`,
    body: '',
    query: parameters,
    uniqueIdSemantics: 'unknown',
  };
}

export interface CnemcPage {
  readonly resource: CnemcResource;
  readonly offset: number;
  readonly total: number;
  readonly columns: readonly string[];
  readonly rows: readonly CnemcRow[];
  readonly sentinelCells: number;
  readonly valuePreference: 'unknown';
  readonly uniqueIdSemantics: 'unknown';
}
/** XML is accepted only as an error envelope, never as data or an entity parser. */
export function decodeCnemcResponse(
  resource: CnemcResource,
  text: string,
  offset = 0,
): CnemcPage {
  if (!['daily', 'monthly'].includes(resource) || !offsetValid(offset))
    fail('INVALID_QUERY');
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4_194_304)
    fail('RESPONSE_TOO_LARGE');
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const envelope =
      /^(?:<\?xml[^?]*\?>\s*)?<([A-Za-z_][\w:.-]*)\b[^>]*>[\s\S]*<\/\1>$/u.exec(
        trimmed,
      );
    if (
      !envelope ||
      envelope[1]?.toLowerCase() === 'html' ||
      /<!DOCTYPE|<!ENTITY/iu.test(trimmed)
    )
      fail('INVALID_RESPONSE');
    if (/<code>\s*2009\s*<\/code>/u.test(trimmed))
      fail('SOURCE_AUTHENTICATION');
    fail('SOURCE_XML_ERROR');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    fail('INVALID_RESPONSE');
  }
  if (!object(payload)) fail('INVALID_RESPONSE');
  if (payload.errCode !== 'DLM.0') fail('SOURCE_BUSINESS_ERROR');
  const body = payload.data;
  if (!object(body)) fail('INVALID_RESPONSE');
  if (body.success !== true) fail('SOURCE_BUSINESS_ERROR');
  const total = safeInteger(body.totalSize),
    size = safeInteger(body.rowSize),
    columnSize = safeInteger(body.columnSize);
  const rawRows = body.data,
    columns = body.columnNames;
  const expected = CNEMC_FIELDS[resource];
  if (
    total === null ||
    size === null ||
    columnSize === null ||
    !Array.isArray(rawRows) ||
    !Array.isArray(columns) ||
    size !== rawRows.length ||
    size > CNEMC_PAGE_SIZE ||
    columns.length !== columnSize ||
    columns.length !== expected.length ||
    new Set(columns).size !== columns.length ||
    !columns.every(
      (column) => typeof column === 'string' && expected.includes(column),
    ) ||
    size > total
  )
    fail('INVALID_RESPONSE');
  let sentinelCells = 0;
  const rows: CnemcRow[] = rawRows.map((raw: unknown) => {
    if (!Array.isArray(raw) && !object(raw)) fail('INVALID_RESPONSE');
    if (
      Array.isArray(raw)
        ? raw.length !== columns.length
        : Object.keys(raw).length !== columns.length
    )
      fail('INVALID_RESPONSE');
    const row: Record<string, CnemcCell> = {};
    for (const [index, field] of (columns as string[]).entries()) {
      const value: unknown = Array.isArray(raw) ? raw[index] : raw[field];
      const mayBeNumber =
        mixedFields.has(field) ||
        /^w\d{5}$/u.test(field) ||
        ['wq_pi_lad', 'wq_pi_lod'].includes(field);
      if (
        value !== null &&
        !(typeof value === 'string' && value.length <= 8192) &&
        !(mayBeNumber && typeof value === 'number' && Number.isFinite(value))
      )
        fail('INVALID_RESPONSE');
      if (value === '-' || value === '-1' || value === '-1.0' || value === -1)
        sentinelCells++;
      row[field] = value;
    }
    return Object.freeze(row);
  });
  return {
    resource,
    offset,
    total,
    columns: columns as string[],
    rows,
    sentinelCells,
    valuePreference: 'unknown',
    uniqueIdSemantics: 'unknown',
  };
}

export interface CnemcCompletenessReport {
  readonly state: 'empty' | 'complete' | 'incomplete';
  readonly total: number | null;
  readonly receivedRows: number;
  readonly offsets: readonly number[];
  readonly issues: readonly CnemcIssue[];
  readonly sentinelCells: number;
  readonly supplierSnapshotVerified: false;
  readonly uniqueIdSemantics: 'unknown';
}
/** Checks returned representations, not unique stations, observations or authority IDs. */
export function inspectCnemcPages(
  pages: readonly CnemcPage[],
  extraIssues: readonly CnemcIssue[] = [],
): CnemcCompletenessReport {
  const issues = new Set<CnemcIssue>(extraIssues);
  const total = pages[0]?.total ?? null;
  const rowRepresentations = new Set<string>(),
    pageRepresentations = new Set<string>();
  let receivedRows = 0,
    sentinelCells = 0;
  if (pages.length === 0) issues.add('NO_PAGES');
  for (const [index, page] of pages.entries()) {
    if (page.offset !== index * CNEMC_PAGE_SIZE)
      issues.add('OFFSET_DISCONTINUITY');
    if (page.resource !== pages[0]?.resource) issues.add('RESOURCE_CHANGED');
    if (page.total !== total) issues.add('TOTAL_CHANGED');
    if (page.rows.length === 0 && total !== null && receivedRows < total)
      issues.add('EARLY_EMPTY_PAGE');
    if (
      total !== null &&
      page.rows.length <
        Math.min(CNEMC_PAGE_SIZE, Math.max(0, total - page.offset))
    )
      issues.add('SHORT_PAGE');
    const representations = page.rows.map((row) =>
      JSON.stringify(
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key]]),
      ),
    );
    const pageRepresentation = JSON.stringify(representations);
    if (
      representations.length > 0 &&
      pageRepresentations.has(pageRepresentation)
    )
      issues.add('REPEATED_PAGE');
    pageRepresentations.add(pageRepresentation);
    for (const representation of representations) {
      if (rowRepresentations.has(representation)) issues.add('REPEATED_ROW');
      rowRepresentations.add(representation);
    }
    receivedRows += page.rows.length;
    sentinelCells += page.sentinelCells;
  }
  if (total !== null && receivedRows > total) issues.add('EXCESS_ROWS');
  if (total !== null && receivedRows < total) issues.add('MISSING_PAGE');
  return {
    state: issues.size ? 'incomplete' : total === 0 ? 'empty' : 'complete',
    total,
    receivedRows,
    offsets: pages.map((page) => page.offset),
    issues: [...issues],
    sentinelCells,
    supplierSnapshotVerified: false,
    uniqueIdSemantics: 'unknown',
  };
}
