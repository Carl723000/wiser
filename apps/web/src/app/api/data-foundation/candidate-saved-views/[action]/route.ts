export async function POST(
  _request: Request,
  _context: { params: Promise<{ action: string }> },
): Promise<Response> {
  return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
}
