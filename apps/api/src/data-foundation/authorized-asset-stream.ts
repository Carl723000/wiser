export async function* authorizedAssetStream(
  body: ReadableStream<Uint8Array>,
  _authorize: () => Promise<boolean>,
): AsyncGenerator<Uint8Array, void, unknown> {
  yield* body;
}
