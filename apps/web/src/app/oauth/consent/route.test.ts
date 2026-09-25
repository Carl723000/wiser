import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('OAuth consent entry', () => {
  it('keeps the browser on its public origin when Next sees an internal listener URL', () => {
    const response = GET(
      new Request(
        'http://0.0.0.0:3000/oauth/consent?authorization_id=request_123',
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/zh-CN/oauth/consent?authorization_id=request_123',
    );
  });
});
