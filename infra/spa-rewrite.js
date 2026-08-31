// CloudFront viewer-request function on the default (SPA) behavior only.
// Rewrites extension-less paths to /index.html so client-side routes like
// /players/1 resolve. `/api/*` has its own cache behavior and never hits this;
// the guard is just belt-and-suspenders. Requests for real files (they contain a
// ".") pass through untouched.
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  if (uri.startsWith('/api/')) return req;
  if (uri.indexOf('.') !== -1) return req;
  req.uri = '/index.html';
  return req;
}
