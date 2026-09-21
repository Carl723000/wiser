import { RELATION_BATCH_MAX_BYTES } from '@wiser/data-contracts';

/** Called only after the full immutable scope has been reauthorized. */
export function boundedRelationPage<T extends { assertionId: string }>(
  rows: readonly T[],
  offset: number,
  first: number,
  maxBytes = RELATION_BATCH_MAX_BYTES,
): { items: T[]; totalCount: number; nextCursor?: string } {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > rows.length ||
    !Number.isInteger(first) ||
    first < 1 ||
    first > 500 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new RangeError('Invalid page bounds');
  const totalCount = rows.length;
  let itemBytes = 0;
  let accepted = 0;
  const end = Math.min(rows.length, offset + first);
  for (let index = offset; index < end; index++) {
    const item = rows[index]!;
    itemBytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
    const count = index - offset + 1;
    const envelope = {
      items: [],
      totalCount,
      ...(index + 1 < rows.length ? { nextCursor: item.assertionId } : {}),
    };
    const size =
      Buffer.byteLength(JSON.stringify(envelope), 'utf8') +
      itemBytes +
      count -
      1;
    if (size <= maxBytes) accepted = count;
  }
  if (offset < rows.length && accepted === 0)
    throw new RangeError('Relation exceeds response budget');
  const items = rows.slice(offset, offset + accepted);
  const output = {
    items,
    totalCount,
    ...(offset + accepted < rows.length
      ? { nextCursor: items.at(-1)!.assertionId }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > maxBytes)
    throw new RangeError('Relation exceeds response budget');
  return output;
}
