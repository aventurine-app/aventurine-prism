'use strict';

// The plan document's rules: which links may be drawn, what a new link starts
// as, how a rule is kept inside what its source allows, and the validator that
// guards every save.

const test = require('node:test');
const assert = require('node:assert/strict');

const Catalog = require('../../static/js/sim/catalog.js');
const Plan = require('../../static/js/sim/plan.js');

// Choice fields have no empty value, so a module may pick how often it pays.
const FIELD_CADENCE = new Set(['per', 'payMonth']);

function planWith(...types) {
    const plan = Plan.createPlan({ name: 'T', start: '2026-01', years: 5 });
    const nodes = types.map((t, i) => {
        const n = Plan.createNode(plan, t, i * 300, 0);
        plan.nodes.push(n);
        return n;
    });
    return { plan, nodes };
}

test('the catalog: every preset has a known role, category and icon name', () => {
    const cats = new Set(Catalog.CATEGORIES.map((c) => c.id));
    for (const p of Catalog.PRESETS) {
        assert.ok(Catalog.ROLES[p.role], p.id);
        assert.ok(cats.has(p.cat), p.id);
        assert.match(p.icon, /^[a-z0-9-]+$/, p.id);
        for (const k of Catalog.fieldsFor(p)) assert.ok(Catalog.FIELDS[k], `${p.id}.${k}`);
    }
    assert.ok(Catalog.PRESETS.length >= 60);
});

test('year-month arithmetic', () => {
    assert.equal(Plan.ymAdd('2026-11', 3), '2027-02');
    assert.equal(Plan.ymAdd('2026-01', -1), '2025-12');
    assert.equal(Plan.ymDiff('2026-10', '2031-10'), 60);
    assert.equal(Plan.ymLabel('2028-03'), 'Mar 2028');
    assert.equal(Plan.ymParse('2026-13'), null);
    assert.equal(Plan.ymParse('26-01'), null);
});

test('a new module starts empty: no amounts, rates or dates are pre-filled', () => {
    for (const p of Catalog.PRESETS) {
        const params = Catalog.defaultParams(p);
        for (const [key, value] of Object.entries(params)) {
            if (FIELD_CADENCE.has(key) || (p.fixed && key in p.fixed)) continue;
            assert.ok(value === 0 || value === null, `${p.id}.${key} starts as ${value}`);
        }
        if (p.inLink) assert.equal(p.inLink.value, 0, `${p.id} inLink`);
    }
    const { nodes } = planWith('cd');
    assert.equal(nodes[0].params.lockUntil, null);
});

test('links: nothing into income, no self links, no duplicates, spending routes only onward', () => {
    const { plan, nodes: [salary, living, savings, card] } = planWith('salary', 'living', 'savings', 'credit-card');
    assert.equal(Plan.canConnect(plan, salary.id, living.id).ok, true);
    assert.equal(Plan.canConnect(plan, living.id, salary.id).reason, 'role');
    assert.equal(Plan.canConnect(plan, salary.id, salary.id).reason, 'self');
    assert.equal(Plan.canConnect(plan, living.id, savings.id).reason, 'role');
    assert.equal(Plan.canConnect(plan, living.id, card.id).reason, 'role');
    assert.equal(Plan.canConnect(plan, card.id, living.id).ok, true);
    plan.links.push(Plan.createLink(plan, salary.id, living.id));
    assert.equal(Plan.canConnect(plan, salary.id, living.id).reason, 'duplicate');
});

test('default rules: first link takes the rest, the next a slice, a priced target asks its price', () => {
    const { plan, nodes: [salary, living, savings, rent] } = planWith('salary', 'living', 'savings', 'rent');
    const first = Plan.createLink(plan, salary.id, living.id);
    plan.links.push(first);
    assert.equal(first.mode, 'rest');
    const second = Plan.createLink(plan, salary.id, savings.id);
    plan.links.push(second);
    assert.deepEqual([second.mode, second.value], ['percent', 10]);
    const third = Plan.createLink(plan, salary.id, rent.id);
    assert.deepEqual([third.mode, third.value, third.when], ['fixed', 0, 'monthly']);
});

test('default rules: accounts send earnings to accounts and pay bills from the balance', () => {
    const { plan, nodes: [brokerage, savings, rent, wedding] } = planWith('brokerage', 'savings', 'living', 'wedding');
    brokerage.params.rate = 7;
    const toAccount = Plan.createLink(plan, brokerage.id, savings.id);
    assert.deepEqual([toAccount.basis, toAccount.mode, toAccount.value], ['earnings', 'percent', 50]);
    const toBill = Plan.createLink(plan, savings.id, rent.id);
    assert.deepEqual([toBill.basis, toBill.mode], ['balance', 'fixed']);
    const toEvent = Plan.createLink(plan, savings.id, wedding.id);
    assert.deepEqual([toEvent.basis, toEvent.mode, toEvent.when, toEvent.date], ['balance', 'fixed', 'once', '2027-07']);
});

test('a debt dated inside the plan offers its proceeds first', () => {
    const { plan, nodes: [mortgage, home] } = planWith('mortgage', 'home');
    mortgage.params.start = '2027-06';
    const l = Plan.createLink(plan, mortgage.id, home.id);
    assert.deepEqual([l.basis, l.mode], ['proceeds', 'rest']);
    mortgage.params.start = null;
    Plan.fitRule(l, mortgage);
    assert.equal(l.basis, 'inflow');
});

test('fitRule keeps a rule inside what its source allows', () => {
    const { nodes: [salary] } = planWith('salary');
    const l = { mode: 'above', basis: 'balance', when: 'once', value: 5 };
    Plan.fitRule(l, salary);
    assert.deepEqual([l.basis, l.mode, l.when], ['inflow', 'percent', 'monthly']);
});

test('validatePlan normalizes numbers and rejects structure it cannot trust', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'savings');
    plan.links.push({ ...Plan.createLink(plan, salary.id, savings.id), mode: 'percent', value: 250 });
    salary.params.tax = 400;
    salary.name = 'Pay\u0007 day';
    const v = Plan.validatePlan(plan);
    assert.equal(v.links[0].value, 100);
    assert.equal(v.nodes[0].params.tax, 95);
    assert.equal(v.nodes[0].name, 'Pay day');
    assert.notEqual(v, plan);

    const bad = (mutate, re) => {
        const copy = JSON.parse(JSON.stringify(plan));
        mutate(copy);
        assert.throws(() => Plan.validatePlan(copy), re);
    };
    bad((p) => { p.nodes[0].type = 'nope'; }, /unknown type/);
    bad((p) => { p.links[0].to = 'n_ghost'; }, /does not exist/);
    bad((p) => { p.links.push({ ...p.links[0], id: 'l_dup' }); }, /duplicates/);
    bad((p) => { p.links[0].from = p.nodes[1].id; p.links[0].to = p.nodes[0].id; }, /cannot be linked/);
    bad((p) => { p.nodes[0].params.amount = 'lots'; }, /must be a number/);
    bad((p) => { p.settings.start = 'soon'; }, /month/);
    bad((p) => { p.nodes[0].id = '<script>'; }, /valid id/);
    bad((p) => { p.nodes = new Array(Plan.LIMITS.nodes + 1).fill(p.nodes[0]); }, /at most/);
});

test('two rest links on one basis cannot both stand', () => {
    const { plan, nodes: [salary, a, b] } = planWith('salary', 'living', 'savings');
    plan.links.push({ ...Plan.createLink(plan, salary.id, a.id), mode: 'rest' });
    plan.links.push({ ...Plan.createLink(plan, salary.id, b.id), mode: 'rest' });
    const v = Plan.validatePlan(plan);
    assert.deepEqual(v.links.map((l) => l.mode), ['rest', 'percent']);
});

test('cloneWithNewIds gives a plan that shares no id with the original', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'savings');
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    const copy = Plan.cloneWithNewIds(plan, 'Copy');
    const ids = (p) => [p.id, ...p.nodes.map((n) => n.id), ...p.links.map((l) => l.id)];
    assert.equal(ids(copy).filter((id) => ids(plan).includes(id)).length, 0);
    assert.equal(copy.links[0].from, copy.nodes[0].id);
    assert.doesNotThrow(() => Plan.validatePlan(copy));
});

test('default rules: a debt asks for its minimum payment, a match for a slice of pay', () => {
    const { plan, nodes: [salary, loan, match, savings] } = planWith('salary', 'car-loan', 'employer-match', 'savings');
    loan.params.minPayment = 400;
    const pay = Plan.createLink(plan, salary.id, loan.id);
    assert.deepEqual([pay.mode, pay.value, pay.when], ['fixed', 400, 'monthly']);
    const fromSavings = Plan.createLink(plan, savings.id, loan.id);
    assert.deepEqual([fromSavings.basis, fromSavings.mode, fromSavings.value], ['balance', 'fixed', 400]);
    const contribute = Plan.createLink(plan, salary.id, match.id);
    assert.deepEqual([contribute.mode, contribute.value], ['percent', 6]);
});

// ── Output ports ─────────────────────────────────────────────────────────────

test('each module offers one output port per thing it can send', () => {
    const { nodes: [salary, checking, groceries, mortgage, card] } = planWith('salary', 'checking', 'groceries', 'mortgage', 'credit-card');
    const bases = (n) => Plan.portsFor(n).map((p) => p.basis);
    assert.deepEqual(bases(salary), ['inflow']);
    assert.deepEqual(bases(checking), ['inflow', 'earnings', 'balance']);
    assert.deepEqual(bases(groceries), ['inflow']);
    assert.deepEqual(bases(mortgage), ['inflow']);
    assert.deepEqual(bases(card), ['inflow', 'charges', 'cashback']);
    mortgage.params.start = '2026-06';
    assert.deepEqual(bases(mortgage), ['inflow', 'proceeds']);
});

test('a port reaches only the roles it can send to', () => {
    const { plan, nodes: [checking, card, groceries, savings, mortgage] } = planWith('checking', 'credit-card', 'groceries', 'savings', 'mortgage');
    assert.deepEqual(Plan.portTargets(card, 'charges'), ['expense']);
    assert.deepEqual(Plan.portTargets(card, 'cashback'), ['account', 'debt']);
    assert.equal(Plan.canConnect(plan, card.id, groceries.id, 'charges').ok, true);
    assert.equal(Plan.canConnect(plan, card.id, savings.id, 'charges').reason, 'basis');
    assert.equal(Plan.canConnect(plan, card.id, savings.id, 'cashback').ok, true);
    assert.equal(Plan.canConnect(plan, card.id, groceries.id, 'cashback').reason, 'basis');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'earnings').ok, true);
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'charges').reason, 'basis');
});

test('two modules link once per port, not once in all', () => {
    const { plan, nodes: [checking, savings] } = planWith('checking', 'savings');
    const a = Plan.createLink(plan, checking.id, savings.id, 'earnings');
    assert.equal(a.basis, 'earnings');
    plan.links.push(a);
    assert.equal(Plan.canConnect(plan, checking.id, savings.id, 'earnings').reason, 'duplicate');
    assert.equal(Plan.canConnect(plan, checking.id, savings.id, 'inflow').ok, true);
});

test('a link drawn from a port starts on that port with a sensible rule', () => {
    const { plan, nodes: [checking, savings, card] } = planWith('checking', 'savings', 'credit-card');
    const earn = Plan.createLink(plan, checking.id, savings.id, 'earnings');
    assert.deepEqual([earn.basis, earn.mode, earn.value], ['earnings', 'percent', 50]);
    const bal = Plan.createLink(plan, checking.id, card.id, 'balance');
    assert.deepEqual([bal.basis, bal.mode], ['balance', 'fixed']);
    const back = Plan.createLink(plan, card.id, savings.id);
    assert.deepEqual([back.basis, back.mode], ['cashback', 'rest']);
});

test('validatePlan rejects a link that leaves a port for a role it cannot reach', () => {
    const { plan, nodes: [card, savings] } = planWith('credit-card', 'savings');
    const l = Plan.createLink(plan, card.id, savings.id, 'cashback');
    plan.links.push(l);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
    l.basis = 'charges';
    assert.throws(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))), /cannot take it/);
});

// ── Docks ────────────────────────────────────────────────────────────────────

test('a loan docks under an asset that can hold it, and follows it', () => {
    const { plan, nodes: [home] } = planWith('home');
    home.x = 100;
    home.y = 50;
    const m = Plan.addLoan(plan, home.id, 'mortgage');
    assert.equal(m.dock, home.id);
    assert.deepEqual([m.x, m.y], [100, 50 + Plan.GEOM.NODE_H]);
    const second = Plan.addLoan(plan, home.id, 'home-equity');
    assert.equal(second.y, 50 + Plan.GEOM.NODE_H + Plan.GEOM.DOCK_H);
    home.x = 400;
    Plan.relayout(plan);
    assert.equal(m.x, 400);
    assert.equal(Plan.addLoan(plan, home.id, 'car-loan'), null);
});

test('only secured loans dock: not a card, not unsecured, not under an asset that holds none', () => {
    const { plan, nodes: [home, salary, card, loan, personal] } = planWith('home', 'salary', 'credit-card', 'mortgage', 'personal-loan');
    assert.equal(Plan.canDock(plan, loan.id, home.id).ok, true);
    assert.equal(Plan.canDock(plan, card.id, home.id).reason, 'kind');
    assert.equal(Plan.canDock(plan, personal.id, home.id).reason, 'kind');
    assert.equal(Plan.canDock(plan, loan.id, salary.id).reason, 'asset');
    assert.equal(Plan.addLoan(plan, salary.id, 'mortgage'), null);
});

test('undocking sets the loan beside its asset and closes the gap', () => {
    const { plan, nodes: [home] } = planWith('home');
    const a = Plan.addLoan(plan, home.id, 'mortgage');
    const b = Plan.addLoan(plan, home.id, 'home-equity');
    Plan.undockLoan(plan, a.id);
    assert.equal(a.dock, undefined);
    assert.equal(a.x, home.x + Plan.GEOM.NODE_W + 56);
    assert.equal(b.y, home.y + Plan.GEOM.NODE_H);
});

test('validatePlan keeps docks, re-derives their place, and rejects a bad one', () => {
    const { plan, nodes: [home] } = planWith('home');
    const m = Plan.addLoan(plan, home.id, 'mortgage');
    m.x = 9999;
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    const vm = v.nodes.find((n) => n.id === m.id);
    assert.equal(vm.dock, home.id);
    assert.equal(vm.x, home.x);
    const bad = JSON.parse(JSON.stringify(plan));
    bad.nodes.find((n) => n.id === m.id).dock = 'nope';
    assert.throws(() => Plan.validatePlan(bad), /cannot hold it/);
});

test('a saved loan an asset no longer takes is undocked, not rejected', () => {
    const { plan, nodes: [home, personal] } = planWith('home', 'personal-loan');
    personal.dock = home.id;
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    const vp = v.nodes.find((n) => n.id === personal.id);
    assert.equal(vp.dock, undefined);
    assert.equal(vp.x, home.x + Plan.GEOM.NODE_W + 56);
});

test('a loan added under an asset bought inside the plan starts that month', () => {
    const { plan, nodes: [home] } = planWith('home');
    home.params.bought = '2027-06';
    assert.equal(Plan.addLoan(plan, home.id, 'mortgage').params.start, '2027-06');
});

test('property saved as an account keeps its value', () => {
    const { plan, nodes: [home] } = planWith('home');
    home.params = { balance: 350000, rate: 3 };
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.equal(v.nodes[0].params.value, 350000);
    assert.equal(v.nodes[0].params.balance, undefined);
});

test('an asset sends nothing until sold, and only a rental sends rent', () => {
    const { plan, nodes: [home, rental, savings] } = planWith('home', 'rental-property', 'savings');
    assert.deepEqual(Plan.basesFor(home), []);
    assert.deepEqual(Plan.basesFor(rental), ['rent']);
    home.params.sold = '2030-01';
    assert.deepEqual(Plan.basesFor(home), ['sale']);
    const sale = Plan.createLink(plan, home.id, savings.id);
    assert.deepEqual([sale.basis, sale.mode, sale.when], ['sale', 'rest', 'once']);
    plan.links.push(sale);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('paying for an asset defaults to its price on the month it is bought', () => {
    const { plan, nodes: [savings, car] } = planWith('savings', 'vehicle');
    car.params.value = 30000;
    car.params.bought = '2027-03';
    const l = Plan.createLink(plan, savings.id, car.id);
    assert.deepEqual([l.basis, l.mode, l.value, l.when, l.date], ['balance', 'fixed', 30000, 'once', '2027-03']);
});

test('nothing withdraws from an asset: a home has no balance or earnings port', () => {
    const { plan, nodes: [home, checking] } = planWith('home', 'checking');
    assert.equal(Plan.canConnect(plan, home.id, checking.id, 'balance').ok, false);
    assert.equal(Plan.canConnect(plan, home.id, checking.id, 'earnings').ok, false);
    assert.equal(Plan.canConnect(plan, checking.id, home.id).ok, true);
});

test('a plan with two links between the same modules on different ports saves', () => {
    const { plan, nodes: [checking, savings] } = planWith('checking', 'savings');
    plan.links.push(Plan.createLink(plan, checking.id, savings.id, 'earnings'));
    plan.links.push(Plan.createLink(plan, checking.id, savings.id, 'inflow'));
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('cloning a plan remaps docks to the new ids', () => {
    const { plan, nodes: [home] } = planWith('home');
    const m = Plan.addLoan(plan, home.id, 'mortgage');
    const copy = Plan.cloneWithNewIds(plan, 'Copy');
    const loan = copy.nodes.find((n) => n.type === 'mortgage');
    assert.ok(copy.nodes.some((n) => n.id === loan.dock));
    assert.notEqual(loan.dock, m.dock);
});
