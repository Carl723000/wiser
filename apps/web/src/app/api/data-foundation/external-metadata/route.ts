import { ExternalMetadataInputSchema } from '@wiser/data-contracts';
import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import { externalMetadataFailureCode } from '@/lib/external-metadata-state';
import { isSameOriginRequest } from '@/lib/request-origin';

const headers = { 'cache-control': 'private, no-store' };
const failure = (status: number, code: string) =>
  Response.json({ code }, { status, headers });
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return failure(403, 'FORBIDDEN');
  if (request.signal.aborted) return failure(499, 'REQUEST_CANCELLED');
  const reader = request.body?.getReader();
  if (!reader) return failure(422, 'INVALID_QUERY');
  let timedOut = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 5000);
  let input: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (request.signal.aborted) return failure(499, 'REQUEST_CANCELLED');
      if (timedOut) return failure(408, 'INVALID_QUERY');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {
        cancel();
        return failure(413, 'INVALID_QUERY');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return request.signal.aborted
      ? failure(499, 'REQUEST_CANCELLED')
      : failure(422, 'INVALID_QUERY');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const checked = ExternalMetadataInputSchema.safeParse(input);
  if (!checked.success) return failure(422, 'INVALID_QUERY');
  try {
    const dal = await getDataFoundationDal();
    return Response.json(
      await dal.externalMetadata(checked.data, request.signal),
      { headers },
    );
  } catch (error) {
    if (request.signal.aborted) return failure(499, 'REQUEST_CANCELLED');
    if (error instanceof DataFoundationApiError) {
      const code =
        externalMetadataFailureCode(error.code, error.status) ??
        (error.status === 401
          ? 'AUTHENTICATION_REQUIRED'
          : error.status === 403
            ? 'FORBIDDEN'
            : 'EXTERNAL_METADATA_FAILED');
      return failure(error.status, code);
    }
    return failure(503, 'EXTERNAL_METADATA_FAILED');
  }
}
