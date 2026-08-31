import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { createApp } from './app.js';

// AWS Lambda entry. Fronted by a CloudFront Function URL origin; the adapter
// decodes base64 request bodies (needed for the multipart `/api/imports` upload)
// and maps the Express response back to the Function URL payload shape.
//
// The schema is NOT applied here — run `npm run migrate` against the target Neon
// branch out-of-band. A cold start must not race N containers through schema.sql.
export const handler = serverlessExpress({ app: createApp() });
