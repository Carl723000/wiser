import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CNEMC_FIELDS,
  CNEMC_PAGE_SIZE,
  CnemcOfflineError,
  type CnemcCell,
  type CnemcResource,
} from './protocol.js';
import { SYNTHETIC_ONLINE_TOKEN } from './loopback.js';

export type SyntheticFault =
  | 'none'
  | 'empty'
  | 'duplicate-page'
  | 'early-empty'
  | 'short-page'
  | 'total-changed'
  | 'xml-auth'
  | 'json-business'
  | 'timeout'
  | 'body-timeout'
  | 'redirect'
  | 'oversize'
  | 'chunked-oversize'
  | 'unsupported-encoding';
export function syntheticEnvelope(
  resource: CnemcResource,
  size: number,
  total: number,
  start = 0,
) {
  if (
    ![size, total, start].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    size > CNEMC_PAGE_SIZE ||
    !['daily', 'monthly'].includes(resource)
  )
    throw new CnemcOfflineError('INVALID_QUERY');
  const columns = [...CNEMC_FIELDS[resource]];
  const rows = Array.from({ length: size }, (_, index) => {
    const row: Record<string, CnemcCell> = Object.fromEntries(
      columns.map((field) => [field, null]),
    );
    const identity = `SYNTHETIC_ROW_${start + index}`;
    if (resource === 'daily')
      Object.assign(row, {
        stationCode: identity,
        factorCode: 'SYNTHETIC_FACTOR',
        measureDateStr: '2026-08-24',
        evaluation_system: '十五五',
        factorNumValue: (start + index) / 10,
      });
    else
      Object.assign(row, {
        pkid: identity,
        wq_pi_code: identity,
        datatype: 'month',
        wq_inf_month: '08',
        wq_inf_year: 2026,
        w01001: 7.25,
      });
    return row;
  });
  return {
    synthetic: true,
    errCode: 'DLM.0',
    data: {
      totalSize: String(total),
      rowSize: size,
      columnSize: columns.length,
      success: true,
      columnNames: columns,
      data: rows,
    },
  };
}

export interface SyntheticRequestReceipt {
  readonly method: string | undefined;
  readonly bodyBytes: number;
  readonly query: Readonly<Record<string, string>>;
  readonly onlineTokenSpellingMatches: boolean;
}
export interface SyntheticSupplier {
  readonly origin: string;
  readonly requests: readonly SyntheticRequestReceipt[];
  readonly redirectTargetRequests: number;
  close(): Promise<void>;
}
/** Fixed, generated data only. No caller-supplied rows, real URLs or real tokens. */
export async function startSyntheticSupplier(
  options: { readonly rowCount?: number; readonly fault?: SyntheticFault } = {},
): Promise<SyntheticSupplier> {
  const rowCount = options.rowCount ?? 2,
    fault = options.fault ?? 'none';
  if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 32000)
    throw new CnemcOfflineError('INVALID_CONFIGURATION');
  const requests: SyntheticRequestReceipt[] = [];
  let redirects = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/trap') {
      redirects++;
      response.writeHead(500).end();
      return;
    }
    if (!['/synthetic/daily', '/synthetic/monthly'].includes(url.pathname)) {
      response.writeHead(404).end();
      return;
    }
    let bodyBytes = 0;
    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        bodyBytes,
        query: Object.fromEntries(url.searchParams),
        onlineTokenSpellingMatches:
          request.rawHeaders.includes('OnlineToken') &&
          request.headers.onlinetoken === SYNTHETIC_ONLINE_TOKEN,
      });
      const resource = url.pathname.endsWith('daily') ? 'daily' : 'monthly';
      const offset = Number(url.searchParams.get('offsetValue'));
      if (fault === 'redirect') {
        response.writeHead(302, { Location: '/trap' }).end();
        return;
      }
      if (fault === 'xml-auth') {
        response
          .writeHead(200, { 'Content-Type': 'text/xml' })
          .end(
            '<response><code>2009</code><message>SYNTHETIC_PRIVATE_TEXT</message></response>',
          );
        return;
      }
      if (fault === 'json-business') {
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify({
              errCode: 'SYNTHETIC_ERROR',
              errMsg: 'SYNTHETIC_PRIVATE_TEXT',
            }),
          );
        return;
      }
      if (fault === 'oversize') {
        response
          .writeHead(200, { 'Content-Length': '8192' })
          .end('x'.repeat(8192));
        return;
      }
      if (fault === 'chunked-oversize') {
        response.writeHead(200);
        response.write('x'.repeat(4096));
        response.end('x'.repeat(4096));
        return;
      }
      if (fault === 'unsupported-encoding') {
        response
          .writeHead(200, { 'Content-Encoding': 'gzip' })
          .end('SYNTHETIC_BYTES');
        return;
      }
      const total = fault === 'empty' ? 0 : rowCount;
      let count = Math.min(CNEMC_PAGE_SIZE, Math.max(0, total - offset));
      if (fault === 'early-empty' && offset > 0) count = 0;
      if (fault === 'short-page') count = Math.min(count, 1);
      const payload = JSON.stringify(
        syntheticEnvelope(
          resource,
          count,
          fault === 'total-changed' && offset > 0 ? total + 1 : total,
          fault === 'duplicate-page' ? 0 : offset,
        ),
      );
      if (fault === 'timeout' || fault === 'body-timeout') {
        if (fault === 'body-timeout') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{');
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          response.end(fault === 'body-timeout' ? payload.slice(1) : payload);
        }, 500);
        timers.add(timer);
        response.once('close', () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(payload);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get redirectTargetRequests() {
      return redirects;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
