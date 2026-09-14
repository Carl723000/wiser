/** Screen-space label allocation; source nodes and edges remain unchanged. */
export function visibleGraphLabels(
  nodes: readonly { id: string; x: number; y: number; preferred: boolean }[],
  zoom: number,
  selected: string | null,
): Set<string> {
  const visible = new Set<string>();
  const cells = new Map<string, { x: number; y: number }[]>();
  const detailed = zoom >= 0.65 || nodes.length <= 14;
  const priority = (n: (typeof nodes)[number]) =>
    n.id === selected ? 2 : n.preferred ? 1 : 0;
  for (const node of [...nodes].sort((a, b) => priority(b) - priority(a))) {
    if (!detailed && !node.preferred && node.id !== selected) continue;
    const x = node.x * zoom,
      y = node.y * zoom;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const cx = Math.floor(x / 160),
      cy = Math.floor(y / 56);
    let collides = false;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (
          cells
            .get(`${cx + dx},${cy + dy}`)
            ?.some((p) => Math.abs(p.x - x) < 160 && Math.abs(p.y - y) < 56)
        )
          collides = true;
      }
    if (collides) continue;
    visible.add(node.id);
    const key = `${cx},${cy}`;
    const bucket = cells.get(key) ?? [];
    bucket.push({ x, y });
    cells.set(key, bucket);
  }
  return visible;
}
