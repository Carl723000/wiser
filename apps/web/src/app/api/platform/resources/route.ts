export async function GET(_request: Request): Promise<Response> {
  return Response.json(
    { code: 'RESOURCE_COVERAGE_UNAVAILABLE' },
    { status: 503 },
  );
}
