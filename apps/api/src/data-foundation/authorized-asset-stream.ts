export async function* authorizedAssetStream(
  body: ReadableStream<Uint8Array>,
  authorize: () => Promise<boolean>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = body.getReader();
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        return;
      }
      // Check after the potentially slow upstream read, before releasing bytes.
      if (!(await authorize())) throw new Error('Asset delivery unavailable');
      yield next.value;
    }
  } catch {
    // Neither authority failures nor upstream errors expose internal details.
    throw new Error('Asset delivery unavailable');
  } finally {
    try {
      if (!complete) await reader.cancel();
    } catch {
      // Cancellation failure must not mask the sanitized delivery error.
    } finally {
      reader.releaseLock();
    }
  }
}
