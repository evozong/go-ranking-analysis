// Vercel serverless entry. All `/api/*` paths are funnelled here by the rewrite
// in vercel.json.
//
// The server workspace is native ESM (`"type": "module"` + NodeNext), but
// Vercel's Node builder compiles this file to CommonJS, and `require()` of an
// ESM module throws. So load the Express app through a dynamic `import()` (legal
// from CJS) and forward each request to it — an Express app is itself a
// `(req, res)` handler. The import is memoized so it happens once per instance.
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<NodeHandler> | undefined;

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await (appPromise ??= import('../server/src/app.js').then(
    (m) => m.default as unknown as NodeHandler,
  ));
  app(req, res);
}
