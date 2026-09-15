/** Bounded display controls; these never filter or authorize graph data. */
export interface GraphLayoutSettings {
  readonly layout: 'network' | 'hierarchy' | 'circular';
  readonly grouping: 'topology' | 'kind' | 'source';
  readonly nodeSpacing: number;
  readonly groupSpacing: number;
}
export const defaultGraphLayoutSettings: GraphLayoutSettings = {
  layout: 'network',
  grouping: 'topology',
  nodeSpacing: 40,
  groupSpacing: 200,
};
export function readGraphLayoutSettings(
  search: Pick<URLSearchParams, 'getAll'>,
): GraphLayoutSettings {
  const single = (key: string) => {
    const v = search.getAll(key);
    return v.length === 1 ? v[0] : undefined;
  };
  const layout = single('businessLayout'),
    grouping = single('businessGrouping');
  const number = (
    key: string,
    min: number,
    max: number,
    step: number,
    fallback: number,
  ) => {
    const text = single(key);
    if (text === undefined || !/^\d{1,3}$/.test(text)) return fallback;
    const n = Number(text);
    return n >= min && n <= max && n % step === 0 ? n : fallback;
  };
  return {
    layout:
      layout === 'hierarchy' || layout === 'circular' ? layout : 'network',
    grouping:
      grouping === 'kind' || grouping === 'source' ? grouping : 'topology',
    nodeSpacing: number('businessNodeSpacing', 20, 100, 20, 40),
    groupSpacing: number('businessGroupSpacing', 0, 400, 100, 200),
  };
}
export function writeGraphLayoutSettings(
  params: URLSearchParams,
  value: GraphLayoutSettings,
) {
  for (const [key, field] of [
    ['businessLayout', 'layout'],
    ['businessGrouping', 'grouping'],
    ['businessNodeSpacing', 'nodeSpacing'],
    ['businessGroupSpacing', 'groupSpacing'],
  ] as const) {
    params.delete(key);
    if (value[field] !== defaultGraphLayoutSettings[field])
      params.set(key, String(value[field]));
  }
}
