'use strict';

// Backend smoke test under the REAL Electron runtime (not host Node): the full
// workspace → router → handlers stack in the main process, including the
// encryption recipe. Electron links BoringSSL rather than OpenSSL, so the
// scrypt and AES-GCM parameters that pass under `npm test` are proved here
// too. No window. Exits 0 on PASS.
//
//   npm run smoke

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.whenReady().then(async () => {
    let failed = false;
    const check = (label, cond) => {
        console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
        if (!cond) failed = true;
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citrine-smoke-'));
    try {
        const Plan = require('../../static/js/sim/plan.js');
        const { simulate } = require('../../static/js/sim/engine.js');
        const { createWorkspace } = require('../backend/workspace');
        const { dispatch } = require('../backend/routes');

        const file = path.join(tmp, 'plans.prism');
        const ws = createWorkspace({ filePath: file });
        ws.init();
        const ctx = { workspace: ws, dialogs: {} };

        const status = await dispatch(ctx, 'GET', '/api/file/status', null);
        check('status 200 and unlocked', status.status === 200 && status.body.locked === false);

        const plan = Plan.createPlan({ name: 'Smoke', start: '2026-01', years: 3 });
        const salary = Plan.createNode(plan, 'salary', 0, 0);
        salary.params.amount = 60000;   // presets start with no amount
        const savings = Plan.createNode(plan, 'bank-account', 300, 0);
        plan.nodes.push(salary, savings);
        plan.links.push(Plan.createLink(plan, salary.id, savings.id));
        const created = await dispatch(ctx, 'POST', '/api/plans', { plan });
        check('plan created', created.status === 200 && created.body.plan.id === plan.id);

        const r = simulate(created.body.plan);
        check('simulation runs in the main process', r.months === 36 && r.totals.endNetWorth > 0);

        const t0 = Date.now();
        const enc = await dispatch(ctx, 'POST', '/api/file/encryption', { action: 'encrypt', password: 'smoke password' });
        check(`encrypt under Electron's crypto (${Date.now() - t0} ms)`, enc.status === 200 && enc.body.encrypted === true);
        check('file on disk is sealed', !fs.readFileSync(file, 'utf8').includes('Smoke'));

        const again = createWorkspace({ filePath: file });
        again.init();
        const ctx2 = { workspace: again, dialogs: {} };
        check('reopened file is locked', (await dispatch(ctx2, 'GET', '/api/plans', null)).status === 423);
        const unlock = await dispatch(ctx2, 'POST', '/api/file/unlock', { password: 'smoke password' });
        check('unlock with the password', unlock.status === 200 && unlock.body.locked === false);
        const list = await dispatch(ctx2, 'GET', '/api/plans', null);
        check('plans readable after unlock', list.status === 200 && list.body.plans[0].name === 'Smoke');
    } catch (e) {
        console.error('FAIL  exception:', e);
        failed = true;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(failed ? 'SMOKE: FAIL' : 'SMOKE: PASS');
    app.exit(failed ? 1 : 0);
});
