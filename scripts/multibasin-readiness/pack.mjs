import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { processBatch } from './processor.mjs';

export const processingVersion = 'goal100-b-monthly-v1:reference-v1:report-v1';
const compact = (value) => (value ?? '').replace(/\s+/g, '');
const systemRegions = new Map([
  ['永定河水系', 'yongding'],
  ['潮白河水系', 'chaobai'],
  ['北运河水系', 'beiyun'],
  ['大清河水系', 'daqing-baiyangdian'],
]);
export function monthlyRegions(row) {
  const region = systemRegions.get(compact(row.waterSystem));
  const named =
    compact(row.objectLabel) === '官厅水库'
      ? 'yongding'
      : compact(row.objectLabel) === '密云水库'
        ? 'chaobai'
        : null;
  return [
    ...new Set(['bth', ...(region ? [region] : []), ...(named ? [named] : [])]),
  ];
}
function textPosition(id, expression, role, locator) {
  return {
    id,
    expression,
    role,
    match: 'text-only',
    geometry: null,
    crs: null,
    nativeCrs: null,
    geometrySourceId: null,
    geometryVersionId: null,
    locator,
    scaleNote: null,
    evidence: { locator, text: expression },
  };
}
function referencePosition(geo, id, evidence) {
  return {
    id,
    expression: geo.properties.name,
    role: 'reference',
    match: 'bound',
    geometry: geo.geometry,
    crs: 'EPSG:4326',
    nativeCrs: 'EPSG:4326',
    geometrySourceId: geo.sourceId,
    geometryVersionId: geo.versionId,
    locator: `osm:${geo.id}`,
    scaleNote: geo.properties.limitation,
    evidence,
  };
}
export function monthlyRecord(row, source, geometries) {
  const categoryRange = /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|劣Ⅴ)[~～－-](Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|劣Ⅴ)$/.test(
    compact(row.rawValue),
  );
  const positions = [
    textPosition(
      `${row.id}:reach`,
      row.objectLabel,
      'study-area',
      row.objectLocator,
    ),
    textPosition(`${row.id}:area`, row.area, 'reference', row.areaLocator),
  ];
  if (row.waterSystem && row.waterSystemLocator)
    positions.push(
      textPosition(
        `${row.id}:system`,
        row.waterSystem,
        'mention',
        row.waterSystemLocator,
      ),
    );
  // Three declared examples get coarse references. No centroid or guessed sampling point.
  const referenceName =
    row.month === '2023-04' &&
    compact(row.objectLabel).startsWith('潮白河上段') &&
    compact(row.area).includes('密云')
      ? '密云区'
      : row.month === '2023-04' &&
          compact(row.objectLabel) === '北运河' &&
          compact(row.area) === '通州'
        ? '通州区'
        : row.month === '2023-04' &&
            compact(row.objectLabel).startsWith('永定河平原段')
          ? '永定河（开放地图参考河线）'
          : null;
  const geo =
    referenceName &&
    geometries.find((item) => item.properties.name === referenceName);
  if (geo)
    positions.push(
      referencePosition(geo, `${row.id}:reference`, {
        locator: row.areaLocator,
        text: row.area,
      }),
    );
  return {
    id: row.id,
    sourceId: source.sourceId,
    versionId: source.originalSha256,
    objectId: row.objectId,
    objectLabel: row.objectLabel,
    kind: 'observation',
    regionIds: monthlyRegions(row),
    needIds: ['K5-001'],
    time: {
      start: row.month,
      end: row.month,
      precision: row.month ? 'month' : 'unknown',
      role: 'observation',
    },
    metric: '现状水质类别',
    value: row.rawValue,
    unit: null,
    positions,
    evidence: [
      { locator: row.valueLocator, text: row.rawValue, url: null },
      { locator: row.objectLocator, text: row.objectLabel, url: null },
      { locator: row.areaLocator, text: row.area, url: null },
      ...(row.waterSystemLocator
        ? [
            {
              locator: row.waterSystemLocator,
              text: row.waterSystem,
              url: null,
            },
          ]
        : []),
    ],
    processingVersion,
    reviewStatus: 'pending',
    missingReasons: [
      'concentrations-not-published',
      'sampling-frequency-unknown',
      'exact-position-unknown',
      'professional-review-pending',
      ...(categoryRange
        ? ['category-range-not-single-value']
        : row.categoryValid
          ? []
          : ['category-not-reported']),
    ],
  };
}
const scopeRegions = [
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
];
const publicRights = {
  public: true,
  displayAllowed: true,
  redistributionAllowed: false,
  note: '公开披露事实与必要原文摘录仅供本地核查；原件再分发许可未确认。',
};
function sourceMaterial(
  id,
  title,
  kind,
  provider,
  receipt,
  regionIds,
  needIds,
  evidenceUrl,
  fieldNames,
  coverageNote,
) {
  return {
    id,
    workId: id,
    versionId: receipt.sha256,
    title,
    provider,
    kind,
    originalSha256: receipt.sha256,
    originalPath: receipt.path,
    evidenceUrl,
    rights: { ...publicRights },
    regionIds,
    needIds,
    processingVersion,
    status: {
      original: 'obtained',
      parsed: 'partial',
      checked: 'evidence-verified',
      professionalReview: 'pending',
      space: 'text-only',
      use: 'local-inspection',
    },
    duplicateOf: null,
    fieldNames,
    coverageNote,
  };
}
function reportRecord(
  source,
  suffix,
  objectLabel,
  regionIds,
  time,
  metric,
  value,
  unit,
  block,
  excerpt,
  needIds = ['K5-001', 'K5-013'],
) {
  if (!block.text.includes(excerpt))
    throw new Error('REPORT_VALUE_EVIDENCE_MISMATCH');
  return {
    id: `${source.id}:${suffix}`,
    sourceId: source.id,
    versionId: source.versionId,
    objectId: `${source.id}:object:${suffix}`,
    objectLabel,
    kind: source.kind === 'policy' ? 'policy' : 'observation',
    regionIds,
    needIds,
    time,
    metric,
    value,
    unit,
    positions: [
      textPosition(
        `${source.id}:${suffix}:scope`,
        objectLabel,
        source.kind === 'policy' ? 'applicable-area' : 'study-area',
        block.locator,
      ),
    ],
    evidence: [
      { locator: block.locator, text: excerpt, url: source.evidenceUrl },
    ],
    processingVersion,
    reviewStatus: 'pending',
    missingReasons: [
      source.kind === 'policy'
        ? 'policy-not-observed-outcome'
        : 'reported-aggregate-only',
      'exact-position-unknown',
      'professional-review-pending',
      'method-not-disclosed',
    ],
  };
}
function blockContaining(report, text) {
  const matches = report.blocks.filter((block) => block.text.includes(text));
  if (matches.length !== 1) throw new Error('REPORT_LOCATOR_AMBIGUOUS:' + text);
  return matches[0];
}
export function buildPack(
  inputs,
  batch,
  reports,
  geometries,
  ledger,
  generatedAt,
) {
  const sources = [];
  const records = [];
  for (const input of inputs) {
    const output = batch.outputs.find(
      (item) => item.sourceId === input.sourceId,
    );
    const original = ledger.entries
      .find(
        (item) =>
          item.id === input.sourceId && item.versionId === input.originalSha256,
      )
      .files.find((file) => file.role === 'original');
    const monthlyProcessingVersion = `${processingVersion}:monthly:${batch.journal[input.sourceId].ruleVersion}`;
    const rows = output.rows.map((row) => ({
      ...monthlyRecord(row, input, geometries),
      processingVersion: monthlyProcessingVersion,
    }));
    // Independent recheck: each emitted value and position must equal its physical source cell.
    for (const record of rows)
      for (const evidence of record.evidence) {
        const match = evidence.locator.match(
          /table:(\d+)\/row:(\d+)\/column:(\d+)$/,
        );
        const cell = input.tables
          .find(
            (row) =>
              row.tableIndex === Number(match[1]) &&
              row.rowIndex === Number(match[2]),
          )
          ?.cells.find((cell) => cell.column === Number(match[3]));
        if (!cell || cell.text !== evidence.text)
          throw new Error('OUTPUT_FULL_VALUE_MISMATCH:' + record.id);
      }
    const material = sourceMaterial(
      input.sourceId,
      `北京市${output.month}地表水水质状况（月度发布类别）`,
      'report',
      '北京市生态环境局',
      original,
      [...new Set(rows.flatMap((record) => record.regionIds))],
      ['K5-001'],
      null,
      ['水系', '河流（河段）/湖泊/水库', '所在区', '现状水质类别'],
      '仅北京市公开月报所列河段、湖泊、水库；不代表全流域、连续采样或浓度明细。',
    );
    material.status.parsed = 'table-complete';
    material.processingVersion = monthlyProcessingVersion;
    material.status.checked = 'all-physical-cells-verified';
    material.status.space = rows.some((record) =>
      record.positions.some((position) => position.geometry),
    )
      ? 'reference'
      : 'text-only';
    material.quantity = {
      candidateRows: rows.length,
      sourceObjects: new Set(rows.map((record) => record.objectId)).size,
      geometryRecords: new Set(
        rows.flatMap((record) =>
          record.positions
            .filter((position) => position.geometry)
            .map((position) => position.locator),
        ),
      ).size,
      validObservations: null,
    };
    sources.push(material);
    records.push(...rows);
  }
  for (const sourceId of [...new Set(geometries.map((geo) => geo.sourceId))]) {
    const selected = geometries.filter((geo) => geo.sourceId === sourceId);
    const original = ledger.entries.find((item) => item.id === sourceId)
      .files[0];
    const material = sourceMaterial(
      sourceId,
      sourceId === 'osm-two-areas'
        ? '密云、通州行政区开放地图参考范围（2026-10-01固定查询）'
        : sourceId.includes('admin')
          ? '北京四区开放地图参考范围（2026-09-19固定查询）'
          : '永定河开放地图部分原生河线（2026-09-19固定查询）',
      'spatial',
      'OpenStreetMap contributors',
      original,
      sourceId === 'osm-two-areas'
        ? ['bth', 'chaobai', 'beiyun']
        : ['bth', 'yongding'],
      ['K5-004'],
      'https://www.openstreetmap.org/copyright',
      ['OSM原生ID', '名称', '边界类型', '原生坐标', '快照时点'],
      '用于行政区/部分河线参照；不是法定边界、精确河段、采样范围或历史水质分布。',
    );
    material.rights = {
      public: true,
      displayAllowed: true,
      redistributionAllowed: true,
      note: '© OpenStreetMap contributors · ODbL 1.0；保留署名、许可与派生几何同许可要求。',
    };
    material.workId = 'openstreetmap';
    material.status.parsed = 'geometry-complete';
    material.status.checked = 'identity-endpoints-coordinates-verified';
    material.status.space = 'reference';
    material.quantity = {
      candidateRows: selected.length,
      sourceObjects: selected.length,
      geometryRecords: selected.length,
      validObservations: null,
    };
    sources.push(material);
    for (const geo of selected) {
      const regionIds =
        geo.properties.name === '密云区'
          ? ['bth', 'chaobai']
          : geo.properties.name === '通州区'
            ? ['bth', 'beiyun']
            : ['bth', 'yongding'];
      records.push({
        id: `${sourceId}:${geo.id}`,
        sourceId,
        versionId: material.versionId,
        objectId: `${sourceId}:${geo.id}`,
        objectLabel: geo.properties.name,
        kind: 'spatial',
        regionIds,
        needIds: ['K5-004'],
        time: {
          start: geo.properties.geometry_date.slice(0, 10),
          end: geo.properties.geometry_date.slice(0, 10),
          precision: 'day',
          role: 'acquisition',
        },
        metric: '开放地图参考几何',
        value: geo.properties.osm_id ?? geo.properties.osm_way_ids,
        unit: null,
        positions: [
          referencePosition(geo, `${sourceId}:${geo.id}:position`, {
            locator: `osm:${geo.id}`,
            text: geo.properties.name,
          }),
        ],
        evidence: [
          {
            locator: `osm:${geo.id}`,
            text: geo.properties.name,
            url: geo.properties.source_url,
          },
        ],
        processingVersion,
        reviewStatus: 'pending',
        missingReasons: [
          'reference-not-precise-reach',
          'historical-boundary-not-verified',
          'professional-review-pending',
        ],
      });
    }
  }
  const tianjin = reports.find(
    (report) => report.sourceId === 'tianjin-2025-release',
  );
  const tj = sourceMaterial(
    tianjin.sourceId,
    '天津市2025年生态环境状况公报发布会实录',
    'report',
    '天津市人民政府/市生态环境局',
    tianjin.original,
    ['bth', 'bohai'],
    ['K5-001', 'K5-013'],
    tianjin.url,
    ['统计年度', '近岸海域优良水质比例', '入海河流总氮平均浓度相对变化'],
    '2026-06-04发布会披露2025年天津市统计；不是完整公报PDF或逐站观测。',
  );
  sources.push(tj);
  const year2025 = {
    start: '2025',
    end: '2025',
    precision: 'year',
    role: 'observation',
  };
  records.push(
    reportRecord(
      tj,
      'coastal-good-ratio',
      '天津市近岸海域',
      ['bth', 'bohai'],
      year2025,
      '近岸海域优良水质比例（报告统计）',
      '73.3',
      '%',
      blockContaining(tianjin, '近岸海域优良水质比例73.3%'),
      '近岸海域优良水质比例73.3%，持续稳定在70%以上。',
    ),
  );
  records.push(
    reportRecord(
      tj,
      'river-tn-change',
      '天津市12条入海河流',
      ['bth', 'bohai'],
      year2025,
      '总氮平均浓度较2020年下降幅度（报告统计）',
      '9.3',
      '%',
      blockContaining(tianjin, '12条入海河流总氮平均浓度较2020年下降9.3%'),
      '12条入海河流总氮平均浓度较2020年下降9.3%',
    ),
  );
  const hebei = reports.find(
    (report) => report.sourceId === 'hebei-2024-bulletin-lf',
  );
  const hb = sourceMaterial(
    hebei.sourceId,
    '《2024年河北省生态环境状况公报》发布报道（廊坊市政府转载）',
    'report',
    '廊坊市人民政府（来源：河北省人民政府网；河北日报）',
    hebei.original,
    ['bth', 'daqing-baiyangdian', 'bohai'],
    ['K5-001', 'K5-013'],
    hebei.url,
    ['统计年度', '湖库淀水质类别', '近岸海域海水水质优良比例'],
    '2025-05-29公开转载2024年公报披露内容；不是公报全文或站点采样明细。河北省近岸海域不能外推至全部渤海湾。',
  );
  sources.push(hb);
  const annual = blockContaining(
    hebei,
    '官厅水库、洋河水库、白洋淀和衡水湖为Ⅲ类',
  );
  const year2024 = {
    start: '2024',
    end: '2024',
    precision: 'year',
    role: 'observation',
  };
  records.push(
    reportRecord(
      hb,
      'baiyangdian-category',
      '白洋淀',
      ['bth', 'daqing-baiyangdian'],
      year2024,
      '年度披露水质类别',
      'Ⅲ',
      null,
      annual,
      '官厅水库、洋河水库、白洋淀和衡水湖为Ⅲ类，水质均为良好。',
    ),
  );
  records.push(
    reportRecord(
      hb,
      'coastal-good-ratio',
      '河北省近岸海域',
      ['bth', 'bohai'],
      year2024,
      '近岸海域海水水质优良比例（报告统计）',
      '99.2',
      '%',
      annual,
      '全省近岸海域海水水质优良比例达到99.2%，比2023年上升0.9个百分点。',
    ),
  );
  const policy = reports.find((report) => report.sourceId === 'bth-haihe-2023');
  const pol = sourceMaterial(
    policy.sourceId,
    '海河流域“十四五”水生态环境保护规划解读',
    'policy',
    '生态环境部（水生态环境司；作者范兰池）',
    policy.original,
    scopeRegions,
    ['K5-013'],
    policy.url,
    ['空间布局', '规划措施', '发布日', '作者归属'],
    '2023-06-05规划解读；提取四段原文，规划目标和措施不是已经实现的监测结果。',
  );
  sources.push(pol);
  const policyScopes = [
    { label: '白洋淀', regions: ['bth', 'daqing-baiyangdian'] },
    { label: '京津冀及环渤海滨海区', regions: scopeRegions },
    {
      label: '海河流域六条绿色河流生态廊道',
      regions: ['bth', 'yongding', 'chaobai', 'daqing-baiyangdian'],
    },
    {
      label: '海河流域重点水体生态保护措施',
      regions: ['bth', 'daqing-baiyangdian'],
    },
  ];
  for (const [index, block] of policy.blocks.entries()) {
    records.push(
      reportRecord(
        pol,
        `paragraph-${block.locator.split(':').at(-1)}`,
        policyScopes[index].label,
        policyScopes[index].regions,
        {
          start: '2023-06-05',
          end: '2023-06-05',
          precision: 'day',
          role: 'publication',
        },
        '规划布局或措施（原文候选）',
        null,
        null,
        block,
        index === 3
          ? block.text.slice(0, block.text.indexOf('永定河以官厅水库'))
          : block.text,
        ['K5-013'],
      ),
    );
  }
  for (const material of sources.filter((source) => !source.quantity)) {
    const owned = records.filter((record) => record.sourceId === material.id);
    material.quantity = {
      candidateRows: owned.length,
      sourceObjects: new Set(owned.map((record) => record.objectId)).size,
      geometryRecords: 0,
      validObservations: null,
    };
  }
  const regions = [
    {
      id: 'bth',
      name: '京津冀全域',
      aliases: ['京津冀'],
      type: 'regional-overview',
      bounds: [113, 36, 120, 43],
    },
    {
      id: 'yongding',
      name: '永定河',
      aliases: ['永定河流域'],
      type: 'basin-priority',
      bounds: [114.5, 38.7, 117.2, 41.4],
    },
    {
      id: 'chaobai',
      name: '潮白河',
      aliases: ['潮白河流域'],
      type: 'basin-priority',
      bounds: [115.8, 39.4, 118.1, 41.2],
    },
    {
      id: 'beiyun',
      name: '北运河',
      aliases: ['北运河流域'],
      type: 'basin-priority',
      bounds: [115.8, 38.9, 117.6, 40.5],
    },
    {
      id: 'daqing-baiyangdian',
      name: '大清河—白洋淀',
      aliases: ['大清河', '白洋淀'],
      type: 'basin-lake-priority',
      bounds: [114.3, 38.3, 117.3, 40.1],
    },
    {
      id: 'bohai',
      name: '渤海湾海陆交汇带',
      aliases: ['天津近岸', '河北近岸'],
      type: 'coastal-priority',
      bounds: [117, 37.8, 119.6, 40.1],
    },
  ];
  const makeTopic = (id, title, regionIds, selected, question, gaps) => ({
    id,
    title,
    regionIds,
    sourceIds: [
      ...new Set(
        selected.flatMap((record) => [
          record.sourceId,
          ...record.positions.flatMap((position) =>
            position.geometrySourceId ? [position.geometrySourceId] : [],
          ),
        ]),
      ),
    ],
    recordIds: selected.map((record) => record.id),
    question,
    gaps,
  });
  const topicPackages = [
    makeTopic(
      'chaobai-monthly-reference',
      '潮白河：月度类别与范围参照',
      ['chaobai'],
      records.filter(
        (record) =>
          record.regionIds.includes('chaobai') &&
          (compact(record.objectLabel).startsWith('潮白河上段') ||
            compact(record.objectLabel) === '密云水库' ||
            record.objectLabel === '密云区'),
      ),
      '报告所列类别能支持哪些比较，密云行政面能说明什么范围？',
      [
        '精确河段/采样位置未得',
        '浓度、采样次数和方法未披露',
        '行政面时点与2023年资料不同',
      ],
    ),
    makeTopic(
      'beiyun-monthly-reference',
      '北运河：河段月报与通州参照',
      ['beiyun'],
      records.filter(
        (record) =>
          record.regionIds.includes('beiyun') &&
          (compact(record.objectLabel) === '北运河' ||
            record.objectLabel === '通州区'),
      ),
      '北运河月报类别与通州参考范围能怎样回到原表？',
      [
        '不代表全流域完整覆盖',
        '行政面不是精确河段或监测点',
        '正式专业审核未完成',
      ],
    ),
    makeTopic(
      'cross-region-report-boundaries',
      '跨区域：白洋淀与近岸海域报告边界',
      ['daqing-baiyangdian', 'bohai', 'chaobai', 'beiyun'],
      records.filter(
        (record) =>
          ['tianjin-2025-release', 'hebei-2024-bulletin-lf'].includes(
            record.sourceId,
          ) ||
          record.id === 'monthly-2023-04:t1:r14' ||
          record.id === 'monthly-2023-04:t1:r38',
      ),
      '年度报告统计与月报类别为什么不能直接当作同一观测序列？',
      [
        '不同年度、对象和统计分母',
        '报告摘要/发布会不是站点明细',
        '无方法同等证据，不计算浓度差或措施因果效果',
      ],
    ),
  ];
  return {
    schemaVersion: 1,
    generatedAt,
    processingVersion,
    sources,
    records,
    regions,
    topicPackages,
    rasterReports: [],
  };
}
function writeJSON(filename, value) {
  fs.writeFileSync(`${filename}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filename}.tmp`, filename);
}
export function main(args) {
  const root = args[args.indexOf('--data-root') + 1];
  if (!args.includes('--data-root') || !root)
    throw new Error('DATA_ROOT_REQUIRED');
  const output = path.join(root, 'outputs/2026-10-02-goal100/b');
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
  const inputs = read('prepared-monthly-inputs.json');
  const previous = fs.existsSync(path.join(output, 'processing-journal.json'))
    ? read('processing-journal.json')
    : {};
  const stopAfter = args.includes('--stop-after')
    ? Number(args[args.indexOf('--stop-after') + 1])
    : undefined;
  if (
    stopAfter !== undefined &&
    (!Number.isInteger(stopAfter) || stopAfter < 0)
  )
    throw new Error('INVALID_STOP_AFTER');
  const rule = args.includes('--monthly-rule')
    ? args[args.indexOf('--monthly-rule') + 1]
    : 'monthly-v1';
  const batch = processBatch(inputs, previous, {
    rules: { monthly: rule },
    stopAfter,
  });
  writeJSON(path.join(output, 'processing-journal.json'), batch.journal);
  const receipt = {
    completed: batch.completed,
    processed: batch.processed,
    reused: batch.reused,
    invalidated: batch.invalidated,
    rules: { monthly: rule },
    originalVersions: inputs.map((input) => ({
      sourceId: input.sourceId,
      originalSha256: input.originalSha256,
    })),
    recordedAt: new Date().toISOString(),
  };
  const history = fs.existsSync(path.join(output, 'processing-runs.json'))
    ? read('processing-runs.json')
    : [];
  writeJSON(path.join(output, 'processing-runs.json'), [...history, receipt]);
  if (!batch.completed) {
    console.log(JSON.stringify(receipt));
    return;
  }
  const pack = buildPack(
    inputs,
    batch,
    read('prepared-report-paragraphs.json'),
    read('prepared-reference-geometries.json'),
    read('original-ledger.json'),
    '2026-10-02',
  );
  writeJSON(path.join(output, 'workspace-pack.json'), pack);
  writeJSON(
    path.join(output, 'processing-findings.json'),
    batch.outputs.map((item) => ({
      sourceId: item.sourceId,
      rows: item.rows.length,
      findings: item.findings,
      excludedRows: item.excludedRows,
    })),
  );
  console.log(
    JSON.stringify({
      ...receipt,
      materials: pack.sources.length,
      records: pack.records.length,
      topics: pack.topicPackages.length,
      bytes: fs.statSync(path.join(output, 'workspace-pack.json')).size,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
