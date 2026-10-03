import {
  MeasurementBindingSchema,
  MeasurementDefinitionSchema,
  MeasurementDefinitionReferenceSchema,
  type MeasurementBinding,
  type MeasurementDefinition,
  type MeasurementDefinitionReference,
  type MeasurementTrack,
} from '@wiser/data-contracts';

export type MeasurementComparisonReason =
  | 'measurement'
  | 'grain'
  | 'denominator'
  | 'categorical'
  | 'metric'
  | 'unit'
  | 'method'
  | 'time'
  | 'position';
export interface MeasurementComparisonFacts {
  readonly binding: MeasurementBinding | undefined;
  readonly track: MeasurementTrack | undefined;
  readonly sourceTrack: MeasurementTrack | undefined;
  /** Authoritative caller supplies review state, never a model's verdict. */
  readonly recordApproved: boolean;
  readonly metric: string;
  readonly unit: string | null;
  readonly method: string | null;
  readonly time: {
    readonly start: string | null;
    readonly end: string | null;
    readonly precision: string;
    readonly role: string;
  };
  readonly positionId: string | null;
  readonly geometryKind: 'POINT' | 'REACH' | 'AREA' | null;
}

export function measurementDefinitionKey(
  reference: MeasurementDefinitionReference,
) {
  return JSON.stringify([
    reference.definitionId,
    reference.definitionVersion,
    reference.sourceId,
    reference.sourceVersionId,
    reference.sourceSha256,
  ]);
}

const known = (value: string | null | undefined) =>
  !!value?.trim() && !/^(unknown|未知)$/i.test(value.trim());
const evidenced = (evidence: { locator: string; text: string } | null) =>
  !!evidence && known(evidence.locator) && known(evidence.text);

function periodLength(time: MeasurementComparisonFacts['time']) {
  if (!time.start || !time.end || time.start > time.end) return null;
  const year = /^(\d{4})$/,
    month = /^(\d{4})-(0[1-9]|1[0-2])$/;
  if (time.precision === 'YEAR') {
    if (!year.test(time.start) || !year.test(time.end)) return null;
    return Number(time.end) - Number(time.start) + 1;
  }
  if (time.precision === 'MONTH') {
    const a = month.exec(time.start),
      b = month.exec(time.end);
    if (!a || !b) return null;
    return (Number(b[1]) - Number(a[1])) * 12 + Number(b[2]) - Number(a[2]) + 1;
  }
  if (time.precision !== 'DAY') return null;
  const day = (value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))
      return null;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
      ? parsed
      : null;
  };
  const a = day(time.start),
    b = day(time.end);
  return a === null || b === null ? null : (b - a) / 86_400_000 + 1;
}

/** Evidence-based eligibility only. It does not issue approval, convert units or values. */
export function assessMeasurementComparison(
  left: MeasurementComparisonFacts,
  right: MeasurementComparisonFacts,
  definitions: readonly MeasurementDefinition[],
) {
  const reasons = new Set<MeasurementComparisonReason>();
  const resolve = (facts: MeasurementComparisonFacts) => {
    const binding = MeasurementBindingSchema.safeParse(facts.binding);
    if (!binding.success) {
      reasons.add('measurement');
      return null;
    }
    const matches = definitions.filter((definition) => {
      const reference = MeasurementDefinitionReferenceSchema.safeParse(
        definition?.reference,
      );
      return (
        reference.success &&
        measurementDefinitionKey(reference.data) ===
          measurementDefinitionKey(binding.data.definition)
      );
    });
    const parsed =
      matches.length === 1
        ? MeasurementDefinitionSchema.safeParse(matches[0])
        : null;
    if (!parsed?.success) {
      reasons.add('measurement');
      return null;
    }
    const definition = parsed.data,
      review = definition.professionalReview;
    if (
      facts.track !== binding.data.track ||
      facts.sourceTrack !== facts.track ||
      definition.track !== facts.track ||
      !facts.recordApproved ||
      definition.sourceDeclaration.state !== 'DECLARED' ||
      !evidenced(definition.sourceDeclaration.evidence) ||
      review.state !== 'APPROVED' ||
      !known(review.submittedBy) ||
      !known(review.reviewedBy) ||
      review.submittedBy.trim() === review.reviewedBy?.trim() ||
      !known(review.decisionId) ||
      !evidenced(review.evidence) ||
      definition.differenceUse !== 'ALLOWED'
    )
      reasons.add('measurement');
    if (definition.measurementType !== 'CONTINUOUS')
      reasons.add(
        definition.measurementType === 'UNKNOWN'
          ? 'measurement'
          : 'categorical',
      );
    if (
      !known(definition.metric.definition) ||
      !evidenced(definition.metric.evidence) ||
      definition.metric.code !== facts.metric
    )
      reasons.add('metric');
    if (
      !definition.unit ||
      !known(definition.unit.code) ||
      !evidenced(definition.unit.evidence) ||
      definition.unit.code !== facts.unit
    )
      reasons.add('unit');
    if (
      !definition.method ||
      !known(definition.method.code) ||
      !evidenced(definition.method.evidence) ||
      definition.method.code !== facts.method
    )
      reasons.add('method');
    const temporal = definition.temporal,
      length = periodLength(facts.time);
    if (
      temporal.kind === 'UNKNOWN' ||
      temporal.precision === 'UNKNOWN' ||
      temporal.role === 'UNKNOWN' ||
      !known(temporal.basis) ||
      !evidenced(temporal.evidence) ||
      temporal.role !== facts.time.role ||
      temporal.precision !== facts.time.precision ||
      temporal.length === null ||
      length !== temporal.length ||
      (temporal.kind === 'INSTANT' &&
        (temporal.length !== 1 || facts.time.start !== facts.time.end))
    )
      reasons.add('time');
    if (
      definition.spatial.kind === 'UNKNOWN' ||
      definition.spatial.kind !== facts.geometryKind ||
      !known(definition.spatial.support) ||
      !evidenced(definition.spatial.evidence) ||
      binding.data.positionId !== facts.positionId
    )
      reasons.add('position');
    const aggregation = definition.aggregation,
      expected = aggregation.denominator,
      actual = binding.data.denominator;
    if (
      !known(aggregation.definition) ||
      !evidenced(aggregation.evidence) ||
      aggregation.rule === 'UNKNOWN' ||
      expected.kind === 'UNKNOWN' ||
      !known(expected.basis) ||
      !evidenced(expected.evidence)
    )
      reasons.add('grain');
    if (aggregation.rule === 'SINGLE') {
      if (
        expected.kind !== 'NONE' ||
        expected.unit !== null ||
        actual !== null ||
        definition.spatial.kind !== 'POINT' ||
        temporal.kind !== 'INSTANT'
      )
        reasons.add('denominator');
    } else if (
      expected.kind === 'NONE' ||
      !actual ||
      actual.kind !== expected.kind ||
      !known(expected.unit) ||
      actual.unit !== expected.unit ||
      actual.basis !== expected.basis ||
      !evidenced(actual.evidence) ||
      !Number.isFinite(actual.value) ||
      actual.value <= 0 ||
      (actual.kind === 'OBSERVATIONS' && !Number.isInteger(actual.value)) ||
      (aggregation.rule === 'MEAN' && expected.kind !== 'OBSERVATIONS') ||
      (aggregation.rule === 'SUM' && expected.kind !== 'OBSERVATIONS') ||
      (aggregation.rule === 'WEIGHTED_MEAN' &&
        !['AREA', 'LENGTH'].includes(expected.kind))
    )
      reasons.add('denominator');
    return { definition, binding: binding.data };
  };
  const a = resolve(left),
    b = resolve(right);
  if (left.track !== right.track) reasons.add('measurement');
  if (a && b) {
    // Different fixed definitions cannot be equated by matching display labels.
    if (
      measurementDefinitionKey(a.definition.reference) !==
      measurementDefinitionKey(b.definition.reference)
    )
      reasons.add('measurement');
    if (
      JSON.stringify(a.definition.temporal) !==
        JSON.stringify(b.definition.temporal) ||
      JSON.stringify(a.definition.spatial) !==
        JSON.stringify(b.definition.spatial) ||
      JSON.stringify(a.definition.aggregation) !==
        JSON.stringify(b.definition.aggregation)
    )
      reasons.add('grain');
    const ad = a.binding.denominator,
      bd = b.binding.denominator;
    if (
      (ad === null) !== (bd === null) ||
      (ad &&
        bd &&
        (ad.kind !== bd.kind ||
          ad.value !== bd.value ||
          ad.unit !== bd.unit ||
          ad.basis !== bd.basis))
    )
      reasons.add('denominator');
  }
  return { eligible: reasons.size === 0, reasons: [...reasons] };
}
