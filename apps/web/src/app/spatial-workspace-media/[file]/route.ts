import { NextResponse, type NextRequest } from 'next/server';
import { loadSpatialMedia } from '@/lib/spatial-workspace-media';

export const dynamic = 'force-dynamic';
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  const bytes = await loadSpatialMedia(
    process.env,
    request.headers.get('host'),
    file,
  );
  return bytes
    ? new NextResponse(bytes, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    : new NextResponse(null, { status: 404 });
}
