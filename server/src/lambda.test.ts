import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './lambda.js';

// Minimal Lambda Function URL (payload format 2.0) event.
function fnUrlEvent(method: string, path: string): any {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'node:test',
      },
    },
    isBase64Encoded: false,
  };
}

// Smoke test for the serverless-express wiring: a Function URL event must be
// parsed, routed through the real Express app, and mapped back to the Function
// URL response shape. Uses the DB-free 404 path so it needs no Neon connection.
test('handler maps a Function URL event through Express to a JSON 404', async () => {
  const res: any = await (handler as any)(fnUrlEvent('GET', '/api/does-not-exist'));

  assert.equal(res.statusCode, 404);
  assert.match(String(res.headers['content-type']), /application\/json/);
  const body = JSON.parse(res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString() : res.body);
  assert.deepEqual(body, { error: 'not found' });
});
