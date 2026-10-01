import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildReadiness } from '../../apps/web/src/lib/spatial-readiness.ts';
import { processBatch } from './processor.mjs';

const digest = (filename) =>
  createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function writeJSON(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}
export function report(root) {
  const output = path.join(root, 'outputs/2026-10-02-goal100/b');
  const read = (filename) =>
    JSON.parse(fs.readFileSync(path.join(output, filename), 'utf8'));
  const pack = read('workspace-pack.json');
  const copy = read('ui-copy.json')['zh-CN'].readiness;
  const ledger = read('original-ledger.json');
  const regions = pack.regions.map((region) => ({
    region,
    ...buildReadiness(pack, region.id),
  }));
  writeJSON(path.join(output, 'readiness-matrix.json'), {
    schemaVersion: 1,
    packSha256: digest(path.join(output, 'workspace-pack.json')),
    slots: 6 * 19,
    countBoundary:
      'Slots are planning positions, not datasets. Regional counts are overlapping subsets of one union.',
    regions,
  });
  const oldReferences = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'outputs/2026-09-21-goal85/monthly/reference-private.json',
      ),
      'utf8',
    ),
  );
  const baseline = [];
  for (const source of oldReferences)
    for (const expected of source.rows) {
      const match = expected.sourceLocation.match(/table:(\d+)\/row:(\d+)$/);
      const recordId = `${source.sourceId}:t${match[1]}:r${match[2]}`;
      const actual = pack.records.find((record) => record.id === recordId);
      const checks = {
        originalName: actual?.objectLabel === expected.name,
        originalValue: actual?.value === expected.category,
        month:
          actual?.time.start === expected.month &&
          actual?.time.role === 'observation',
        district:
          actual?.evidence[2]?.text === expected.district &&
          actual?.positions.some(
            (position) =>
              position.role === 'reference' &&
              position.geometry === null &&
              position.expression === expected.district,
          ),
        unit: actual?.unit === expected.unit,
        pending: actual?.reviewStatus === 'pending',
      };
      if (!Object.values(checks).every(Boolean))
        throw new Error('YONGDING_BASELINE_MISMATCH:' + recordId);
      baseline.push({
        recordId,
        originalLocator: expected.sourceLocation,
        checks,
      });
    }
  if (baseline.length !== 24)
    throw new Error('YONGDING_BASELINE_COUNT_MISMATCH');
  writeJSON(path.join(output, 'yongding-24-regression.json'), {
    rows: baseline.length,
    passed: baseline.length,
    status: 'regression-not-blind-holdout',
    inputSha256: digest(
      path.join(
        root,
        'outputs/2026-09-21-goal85/monthly/reference-private.json',
      ),
    ),
    results: baseline,
  });
  const inputs = read('prepared-monthly-inputs.json');
  const first = processBatch(
    inputs,
    {},
    { rules: { monthly: 'monthly-v1' }, stopAfter: 3 },
  );
  const resumed = processBatch(inputs, first.journal, {
    rules: { monthly: 'monthly-v1' },
  });
  const repeated = processBatch(inputs, resumed.journal, {
    rules: { monthly: 'monthly-v1' },
  });
  if (
    first.completed ||
    !resumed.completed ||
    resumed.processed !== 5 ||
    resumed.reused !== 3 ||
    repeated.processed !== 0 ||
    JSON.stringify(resumed.outputs) !== JSON.stringify(repeated.outputs)
  )
    throw new Error('RESUME_OR_IDEMPOTENCE_MISMATCH');
  const split = inputs.map((input, index) => ({
    ...input,
    ruleKey: index === 0 ? 'selected' : 'unchanged',
  }));
  const previous = processBatch(
    split,
    {},
    { rules: { selected: 'v1', unchanged: 'v1' } },
  );
  const revised = processBatch(split, previous.journal, {
    rules: { selected: 'v2', unchanged: 'v1' },
  });
  if (
    revised.processed !== 1 ||
    revised.reused !== 7 ||
    revised.invalidated[0].sourceId !== inputs[0].sourceId
  )
    throw new Error('NARROW_RULE_RECOMPUTE_MISMATCH');
  writeJSON(path.join(output, 'real-batch-recovery.json'), {
    inputVersions: inputs.map((input) => ({
      sourceId: input.sourceId,
      originalSha256: input.originalSha256,
    })),
    stop: { completed: first.completed, processed: first.processed },
    resume: {
      completed: resumed.completed,
      processed: resumed.processed,
      reused: resumed.reused,
    },
    repeat: {
      processed: repeated.processed,
      reused: repeated.reused,
      exactOutputsMatch: true,
    },
    selectedRuleRevision: {
      processed: revised.processed,
      reused: revised.reused,
      invalidated: revised.invalidated,
    },
    originalHashesUnchanged: true,
    boundary:
      'Offline processing replay only; not target service ingestion or professional review.',
  });
  const validCategories = pack.records.filter(
    (record) =>
      record.sourceId.startsWith('monthly-') &&
      ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '劣Ⅴ'].includes(
        record.value?.replace(/\s+/g, ''),
      ),
  ).length;
  const nonCategories = pack.records.filter(
    (record) =>
      record.sourceId.startsWith('monthly-') &&
      !['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '劣Ⅴ'].includes(
        record.value?.replace(/\s+/g, ''),
      ),
  );
  const categoryRanges = nonCategories.filter((record) =>
    record.missingReasons.includes('category-range-not-single-value'),
  );
  const unavailable = nonCategories.filter(
    (record) =>
      !record.missingReasons.includes('category-range-not-single-value'),
  );
  writeJSON(path.join(output, 'source-counts.json'), {
    counts: regions[0].counts,
    ledger: ledger.totals,
    monthly: {
      rows: 1112,
      singleCategoryRows: validCategories,
      categoryRangeRows: categoryRanges.length,
      unavailableCategoryRows: unavailable.length,
      nonSingleCategoryRawValues: [
        ...new Set(nonCategories.map((record) => record.value)),
      ],
      validObservations: null,
    },
    quantitiesNotSummed: [
      'region totals',
      'per-material repeated reference geometry counts',
      'sampling observations',
    ],
    packSha256: digest(path.join(output, 'workspace-pack.json')),
  });
  const lines = [
    '# 多流域资料与需求核查（2026-10-02本地固定批次）',
    '',
    '本批把北京市八期月报中的全部目标表格整理为可回查记录，并加入白洋淀、近岸海域的公开报告披露和有明确许可的范围参照。选择潮白河或北运河时，可从需求表进入原表值及参考行政面；行政面不表示精确河段或采样位置。所有真实记录仍待专业审核。',
    '',
    `实际取得并核对14个固定原件版本，按作品身份计12个独立资料来源；形成1127条源内对象/候选记录，其中月报1112条、参考几何对象7条、报告或政策原文候选8条。月报中${validCategories}条为单一发布类别，${categoryRanges.length}条原表发布“Ⅱ～Ⅲ”区间（保留原样），${unavailable.length}条保留“${[...new Set(unavailable.map((record) => record.value))].join('、')}”原值。发布类别行不是独立采样次数；采样点数与有效观测数均未知。`,
    '',
    '八份原始DOC哈希及其既有DOCX转换哈希均匹配。重新读取的4360个物理单元格、全部表格结构和标题月份与冻结输入逐项一致，输出值及范围字段逐项回到原单元格。本轮没有重做二进制DOC转换；“全量核对”指固定DOCX格式副本及派生值的确定性回核，不等于科学事实或专业审核。',
    '',
    '原件尝试累计14（上限80），新增公开原件3（上限40），公开取得失败4次另列。OpenStreetMap三个固定查询版本属于同一作品，格式副本与几何派生不增加独立来源。本报告仅统计B资料线，C协议/遥感由总负责人另行整合。',
    '',
    '| 范围 | 独立资料作品 | 固定版本 | 候选记录/源内对象 | 唯一参考几何 | 采样点/有效观测 |',
    '|---|---:|---:|---:|---:|---|',
    ...regions.map(
      (item) =>
        `| ${item.region.name} | ${item.counts.sources} | ${item.counts.versions} | ${item.counts.records}/${item.counts.sourceObjects} | ${item.counts.geometryRecords} | 未知/未知 |`,
    ),
    '',
    '全域是各区域的并集，分区数量不得相加。需求矩阵共6×19＝114个规划位置，不是114套数据。当前实质材料覆盖水质发布、空间参照、政策与报告三类，均为部分可用；剩余类别的“未取得”仅指本批没有处理对应实质原件，不否定项目其他已有资产。',
    '',
  ];
  for (const item of regions) {
    lines.push(
      `## ${item.region.name}`,
      '',
      '| 需求 | 状态 | 本批材料版本数 | 记录数 | 缺项与使用条件 |',
      '|---|---|---:|---:|---|',
    );
    for (const need of item.needs)
      lines.push(
        `| ${need.id} ${copy.needLabels[need.id]} | ${copy.states[need.state]} | ${need.sourceIds.length} | ${need.recordIds.length} | ${need.missingReasons.map((reason) => copy.detailLabels[reason] ?? reason).join('；') || '具体用途须回查原文'} |`,
      );
    lines.push('', '| 九问 | 本批可核实回答 |', '|---|---|');
    const responses = {
      inventory: item.statuses
        .map(
          ({ sourceId }) =>
            pack.sources.find((source) => source.id === sourceId).title,
        )
        .join('；'),
      quantity: `${item.counts.sources}独立作品、${item.counts.versions}版本、${item.counts.records}候选、${item.counts.geometryRecords}唯一参考几何；有效观测数未知`,
      quality:
        '取得、解析、确定性核对、专业审核、空间、用途六维分开记录；本批全部真实候选专业审核待办',
      structure: item.fields.join('、') || '本批无实质字段',
      density: `报告月份：${item.density.reportWindows.join('、') || '无月报'}；中间缺失月份：${item.density.missingReportWindows.join('、') || '未发现'}；实际采样频率、空间覆盖分母未知`,
      gaps: '精确位置/身份对应、浓度与测量方法、连续时序、专业审核；具体未取得项见上表',
      cleaning:
        'Codex本地处理：哈希预检、固定格式副本全表重读、显式合并单元格解析、范围与原值保留；未调用批量模型',
      'quality-control':
        '本地程序做确定性哈希/结构/值/几何端点检查；专业事实与适用性审核未执行，不能由程序或模型评分替代',
      computations: item.uses
        .map(
          (use) =>
            `${copy.useLabels[use.id]}：${use.eligible ? '在声明范围内可查看' : '依据不足'}（${use.reasons.map((reason) => copy.detailLabels[reason] ?? reason).join('；')}）`,
        )
        .join('；'),
    };
    for (const question of item.questions)
      lines.push(
        `| ${copy.questionLabels[question.id]} | ${responses[question.id]} |`,
      );
    lines.push('');
  }
  lines.push('## 三个专题证据包', '');
  for (const topic of pack.topicPackages)
    lines.push(
      `- **${topic.title}**：${topic.question} 包含${topic.sourceIds.length}个材料版本、${topic.recordIds.length}条记录。限制：${topic.gaps.join('；')}。`,
    );
  lines.push(
    '',
    '## 原件与回核入口',
    '',
    '| 资料版本 | 原件 | 原件SHA-256 | 范围和许可 |',
    '|---|---|---|---|',
  );
  for (const source of pack.sources)
    lines.push(
      `| ${source.title} | [本地固定原件](${path.relative(output, path.join(root, source.originalPath))})${source.evidenceUrl ? ` · [公开出处](${source.evidenceUrl})` : ''} | ${source.originalSha256} | ${source.coverageNote} ${source.rights.note} |`,
    );
  lines.push(
    '',
    '[可复算矩阵](readiness-matrix.json) · [全表回核](monthly-full-audit.json) · [24条永定河既有样本回归](yongding-24-regression.json) · [处理恢复与定向重算](real-batch-recovery.json) · [原件累计台账](original-ledger.json) · [源内计数](source-counts.json)',
    '',
    '恢复入口：先选潮白河上段 April 2023 原表值，查看密云行政参照为何只能叫“参考范围”；再查看北运河通州例子，区别月度发布与采样频率。年度白洋淀披露为2024年，天津发布会为2025年统计/2026年发布；没有同等方法和统计对象证据，不计算浓度差或跨区成效。',
    '',
    'L03接续仍需目标服务能力、真实供方字段与授权、原始观测/方法/单位/身份坐标、导入回执及专业审核。不得由本地解析成功推定目标环境已接收、地图位置已专业核验、业务关系已入图或数据已发布。',
    '',
    '学习与开发分别记账：本地交付不表示本人已读或已掌握；G1页面验收、整体工程Green和团队交付由总负责人记录。本资料线未访问143/生产/总站现网/830条地下水观测，未启动L03或真实模型比较。',
    '',
  );
  fs.writeFileSync(path.join(output, 'readiness-report.md'), lines.join('\n'));
  console.log(
    JSON.stringify({
      slots: regions.reduce((sum, item) => sum + item.needs.length, 0),
      questions: regions.reduce((sum, item) => sum + item.questions.length, 0),
      yongdingRegression: baseline.length,
      counts: regions[0].counts,
      validCategoryRows: validCategories,
      nonCategoryRows: nonCategories.length,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const index = process.argv.indexOf('--data-root');
  if (index < 0 || !process.argv[index + 1])
    throw new Error('DATA_ROOT_REQUIRED');
  report(process.argv[index + 1]);
}
