'use strict';

// Plans: the tabs of the app. Thin handlers over workspace.js, which owns
// validation and the file. Export and import go through native dialogs that
// main.js injects as ctx.dialogs: the renderer never hands the backend a path.

const { ApiError } = require('../router');

function planBody(body) {
    if (!body || typeof body !== 'object' || !body.plan) throw new ApiError('plan required', 400);
    return body.plan;
}

function list(ctx) {
    return ctx.workspace.listPlans();
}

function get(ctx, { params }) {
    return { plan: ctx.workspace.getPlan(params.id) };
}

function create(ctx, { body }) {
    return { plan: ctx.workspace.addPlan(planBody(body)) };
}

function update(ctx, { params, body }) {
    return ctx.workspace.putPlan(params.id, planBody(body));
}

function remove(ctx, { params }) {
    return ctx.workspace.deletePlan(params.id);
}

function tabs(ctx, { body }) {
    return ctx.workspace.setTabs(body || {});
}

async function exportPlan(ctx, { params }) {
    const plan = ctx.workspace.getPlan(params.id);
    const file = await ctx.dialogs.chooseExportPath(plan.name);
    if (!file) return { canceled: true };
    return ctx.workspace.exportPlan(plan.id, file);
}

async function importPlan(ctx) {
    const file = await ctx.dialogs.chooseImportPath();
    if (!file) return { canceled: true };
    return { plan: ctx.workspace.importPlanFile(file) };
}

const routes = [
    ['GET',    '/api/plans', list],
    ['POST',   '/api/plans', create],
    ['POST',   '/api/plans/import', importPlan],
    ['PUT',    '/api/plans/order', tabs],
    ['GET',    '/api/plans/<id>', get],
    ['PUT',    '/api/plans/<id>', update],
    ['DELETE', '/api/plans/<id>', remove],
    ['POST',   '/api/plans/<id>/export', exportPlan],
];

module.exports = { routes };
