// Vercel serverless entry. The Node runtime accepts an Express app as the
// default export and drives it per request; there is no `app.listen` here.
// All `/api/*` paths are funnelled here by the rewrite in vercel.json.
import app from '../server/src/app.js';

export default app;
