// lib/asyncRoute.js
// Express 4 does not catch rejections from async handlers: the promise
// rejects, next() is never called, no response is written, and the request
// hangs until the client gives up. Wrap every async handler so a rejection
// reaches the error handler and becomes a normal 500.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { wrap };
