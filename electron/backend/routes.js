'use strict';

// The full route table. Handlers are plain functions (ctx, { params, query,
// body }) so they are testable without Electron; registration stays here.
// Literal segments ('/api/plans/import', '/api/plans/order') are listed before
// the '<id>' patterns beside them.

const { buildRouter } = require('./router');

const routes = [
    ...require('./handlers/file').routes,
    ...require('./handlers/plans').routes,
];

const router = buildRouter(routes);

module.exports = { routes, dispatch: router.dispatch };
