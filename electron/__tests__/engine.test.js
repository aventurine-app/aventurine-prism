'use strict';

// The simulator's rules, one scenario each. Every scenario also passes the
// conservation check: the change in net worth must equal the money that
// entered minus the money that left, so no rule can create or lose money.

const test = require('node:test');
const assert = require('node:assert/strict');

const Catalog = require('../../static/js/sim/catalog.js');
const Plan = require('../../static/js/sim/plan.js');
const { simulate } = require('../../static/js/sim/engine.js');

// ── Builders ─────────────────────────────────────────────────────────────────

function mkPlan(start = '2026-01', years = 1) {
    return {
        id: 'p_test', name: 'Test', version: 1,
        settings: { start, years, inflation: 0 },
        view: { x: 0, y: 0, zoom: 1 },
        nodes: [], links: [],
    };
}

function node(plan, type, params = {}) {
    const p = Catalog.preset(type);
    const n = {
        id: `n_${plan.nodes.length}`, type, name: p.name, x: 0, y: 0,
        params: { ...Catalog.defaultParams(p), ...params },
    };
    plan.nodes.push(n);
    return n;
}

function link(plan, from, to, rule = {}) {
    const l = {
        id: `l_${plan.links.length}`, from: from.id, to: to.id,
        mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1,
        date: null, start: null, end: null, growth: 0, ...rule,
    };
    plan.links.push(l);
    return l;
}

/** Validate (as the backend would), simulate, and check conservation. */
function run(plan) {
    const r = simulate(Plan.validatePlan(plan));
    const T = r.totals;
    const delta = T.endNetWorth - T.startNetWorth;
    const expected = T.earned - T.withheld + T.match + T.cashback + T.growth
        - T.interest - T.spent - T.skimmed;
    assert.ok(Math.abs(delta - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
        `money not conserved: net worth moved ${delta}, flows explain ${expected}`);
    return r;
}

const close = (actual, expected, tol = 1e-6) =>
    assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
        `expected ${expected}, got ${actual}`);

const last = (arr) => arr[arr.length - 1];
const codes = (r) => r.warnings.map((w) => w.code);

// ── Growth ───────────────────────────────────────────────────────────────────

test('an account rate is an APY: 4% grows exactly 4% in twelve months', () => {
    const plan = mkPlan('2026-01', 1);
    const acct = node(plan, 'hysa', { balance: 10000, rate: 4 });
    const r = run(plan);
    close(last(r.nodes[acct.id].balance), 10400);
    close(r.totals.growth, 400);
});

test('a negative rate depreciates: a vehicle loses 15% a year', () => {
    const plan = mkPlan('2026-01', 2);
    const car = node(plan, 'vehicle', { value: 20000, rate: -15 });
    const r = run(plan);
    close(last(r.nodes[car.id].balance), 20000 * 0.85 * 0.85);
});

// ── Assets ───────────────────────────────────────────────────────────────────

/** A docked loan, as Plan.addLoan makes one. */
function loanUnder(plan, asset, type, params) {
    const l = node(plan, type, params);
    l.dock = asset.id;
    return l;
}

test('appreciation stays in the asset: it counts toward net worth and pays nothing out', () => {
    const plan = mkPlan('2026-01', 1);
    const home = node(plan, 'home', { value: 400000, rate: 3 });
    const r = run(plan);
    close(last(r.nodes[home.id].balance), 412000);
    close(r.totals.growth, 12000);
    close(r.totals.unassigned, 0);
    close(r.totals.endNetWorth, 412000);
});

test('buying a home inside the plan: the down payment and the mortgage become its value', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'savings', { balance: 100000 });
    const home = node(plan, 'home', { value: 400000, rate: 0, bought: '2026-04' });
    loanUnder(plan, home, 'mortgage', { balance: 320000, rate: 0, start: '2026-04' });
    link(plan, savings, home, { basis: 'balance', mode: 'fixed', value: 80000, when: 'once', date: '2026-04' });
    const r = run(plan);
    const h = r.nodes[home.id];
    close(h.balance[3], 0);                 // not owned before April
    close(h.balance[4], 400000);
    close(r.netWorth[4], r.netWorth[0]);    // cash became property: no change
    assert.ok(!codes(r).includes('price'));
    assert.ok(!codes(r).includes('unassigned'));
    assert.ok(r.milestones.some((m) => m.code === 'bought' && m.month === 3));
});

test('a purchase paid short of the price says so', () => {
    const plan = mkPlan('2026-01', 1);
    const home = node(plan, 'home', { value: 400000, bought: '2026-04' });
    loanUnder(plan, home, 'mortgage', { balance: 320000, start: '2026-04' });
    const r = run(plan);
    const w = r.warnings.find((x) => x.code === 'price');
    assert.ok(w);
    close(w.amount, 80000);
    close(last(r.nodes[home.id].balance), 320000);
});

test('a home equity loan taken later is cash out, not value', () => {
    const plan = mkPlan('2026-01', 1);
    const home = node(plan, 'home', { value: 400000 });
    loanUnder(plan, home, 'home-equity', { balance: 50000, start: '2026-06' });
    const r = run(plan);
    close(last(r.nodes[home.id].balance), 400000);
    close(r.totals.unassigned, 50000);
});

test('selling pays off the docked loans first and sends the rest on', () => {
    const plan = mkPlan('2026-01', 1);
    const home = node(plan, 'home', { value: 400000, rate: 0, sold: '2026-06', sellCost: 6 });
    const mortgage = loanUnder(plan, home, 'mortgage', { balance: 300000, rate: 0 });
    const savings = node(plan, 'savings');
    link(plan, home, savings, { basis: 'sale', mode: 'rest', when: 'once' });
    const r = run(plan);
    close(r.nodes[home.id].balance[6], 0);
    close(r.nodes[mortgage.id].balance[6], 0);
    close(last(r.nodes[savings.id].balance), 400000 * 0.94 - 300000);
    close(r.totals.skimmed, 24000);
    assert.ok(r.milestones.some((m) => m.code === 'sold' && m.month === 5));
    assert.ok(r.milestones.some((m) => m.code === 'paid-off' && m.nodeId === mortgage.id));
});

test('a sale that cannot cover the loans leaves the rest owed and says so', () => {
    const plan = mkPlan('2026-01', 1);
    const car = node(plan, 'vehicle', { value: 10000, sold: '2026-03' });
    const loan = loanUnder(plan, car, 'car-loan', { balance: 14000 });
    const r = run(plan);
    close(last(r.nodes[loan.id].balance), 4000);
    const w = r.warnings.find((x) => x.code === 'underwater');
    assert.ok(w);
    close(w.amount, 4000);
});

test('money sent to a sold asset lands in Unassigned', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 1000, per: 'month' });
    const car = node(plan, 'vehicle', { value: 10000, sold: '2026-02' });
    const savings = node(plan, 'savings');
    link(plan, salary, car, { mode: 'fixed', value: 100 });
    link(plan, car, savings, { basis: 'sale', mode: 'rest', when: 'once' });
    const r = run(plan);
    close(last(r.nodes[car.id].balance), 0);
    close(last(r.nodes[savings.id].balance), 10100);   // January's 100 was sold with it
    close(r.nodes[car.id].totals.unplaced, 1100);      // February to December
});

test('a rental collects rent while owned, and rent is income', () => {
    const plan = mkPlan('2026-01', 1);
    const rental = node(plan, 'rental-property', { value: 300000, rent: 2000, bought: '2026-07' });
    const checking = node(plan, 'checking');
    const savings = node(plan, 'savings', { balance: 300000 });
    link(plan, savings, rental, { basis: 'balance', mode: 'fixed', value: 300000, when: 'once', date: '2026-07' });
    link(plan, rental, checking, { basis: 'rent', mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[checking.id].balance), 6 * 2000);
    close(r.totals.earned, 12000);
});

test('a home has no rent even if a value is stored for it', () => {
    const plan = mkPlan('2026-01', 1);
    node(plan, 'home', { value: 300000, rent: 2000 });
    const r = run(plan);
    close(r.totals.earned, 0);
});

test('an asset sold before the plan starts is not held', () => {
    const plan = mkPlan('2026-01', 1);
    const car = node(plan, 'vehicle', { value: 10000, sold: '2025-06' });
    const r = run(plan);
    close(r.nodes[car.id].balance[0], 0);
});

test('a debt APR is charged monthly at APR/12, and an unpaid debt is flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const debt = node(plan, 'credit-card', { balance: 1000, rate: 12, minPayment: null, cashBack: 0 });
    const r = run(plan);
    close(r.nodes[debt.id].balance[1], 1010);
    close(last(r.nodes[debt.id].balance), 1000 * Math.pow(1.01, 12));
    assert.ok(codes(r).includes('debt-growing'));
});

// ── Income ───────────────────────────────────────────────────────────────────

test('income schedules: weekly, biweekly, yearly spread, yearly lump, once', () => {
    const plan = mkPlan('2026-01', 1);
    const sink = node(plan, 'living');
    const cases = [
        [{ amount: 100, per: 'week' }, 100 * 52],
        [{ amount: 100, per: 'biweek' }, 100 * 26],
        [{ amount: 1200, per: 'year' }, 1200],
        [{ amount: 1200, per: 'year', payMonth: 6 }, 1200],
        [{ amount: 500, per: 'once', start: '2026-03' }, 500],
    ];
    const ids = cases.map(([params]) => {
        const s = node(plan, 'other-income', params);
        link(plan, s, sink);
        return s.id;
    });
    const r = run(plan);
    cases.forEach(([, expected], i) => close(r.nodes[ids[i]].totals.produced, expected));
    // The lump lands in its month only.
    const lump = r.nodes[ids[3]].produced;
    assert.equal(lump[5], 1200);
    assert.equal(lump[4], 0);
});

test('withholding, raises and an income window', () => {
    const plan = mkPlan('2026-01', 3);
    const sink = node(plan, 'living');
    const salary = node(plan, 'salary', {
        amount: 1000, per: 'month', growth: 10, tax: 20, start: '2026-04', end: '2027-06',
    });
    link(plan, salary, sink);
    const r = run(plan);
    const net = r.nodes[salary.id].produced;
    assert.equal(net[2], 0);
    close(net[3], 800);       // first month of the window: 1000 less 20%
    close(net[14], 800);      // still the first year of this income
    close(net[15], 880);      // a year after it started: the 10% raise
    close(net[17], 880);      // the window's last month is paid
    assert.equal(net[18], 0); // window over
    close(r.totals.withheld, r.totals.earned * 0.2);
});

// ── Splitting ────────────────────────────────────────────────────────────────

test('fixed amounts are paid first, percentages are of the full amount, rest takes what is left', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 5000, per: 'month' });
    const rent = node(plan, 'rent');
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    const fun = node(plan, 'entertainment');
    // Declared rest-first on purpose: evaluation order is by mode, not by list.
    const lRest = link(plan, pay, fun, { mode: 'rest' });
    const lPct = link(plan, pay, savings, { mode: 'percent', value: 20 });
    const lFix = link(plan, pay, rent, { mode: 'fixed', value: 1500 });
    const r = run(plan);
    close(r.links[lFix.id].flow[0], 1500);
    close(r.links[lPct.id].flow[0], 1000);
    close(r.links[lRest.id].flow[0], 2500);
    close(last(r.nodes[savings.id].balance), 12000);
});

test('over-allocation shortchanges the later links and says so', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const a = node(plan, 'rent');
    const b = node(plan, 'groceries');
    link(plan, pay, a, { mode: 'fixed', value: 800 });
    const lb = link(plan, pay, b, { mode: 'percent', value: 50 });
    const r = run(plan);
    close(r.links[lb.id].flow[0], 200);
    const short = r.warnings.find((w) => w.code === 'short');
    assert.equal(short.linkId, lb.id);
    close(short.amount, 300 * 12);
});

test('percentages over 100% are flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    link(plan, pay, node(plan, 'rent'), { mode: 'percent', value: 70 });
    link(plan, pay, node(plan, 'groceries'), { mode: 'percent', value: 50 });
    const r = run(plan);
    assert.ok(codes(r).includes('over-100'));
});

test('money with no link lands in Unassigned and still counts toward net worth', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    link(plan, pay, node(plan, 'living'), { mode: 'percent', value: 30 });
    const r = run(plan);
    close(last(r.unassigned), 700 * 12);
    close(r.totals.endNetWorth, 700 * 12);
    assert.ok(codes(r).includes('unassigned'));
});

test('a fixed amount from income that ends is reported short, not silently dropped', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 3000, per: 'month', end: '2026-06' });
    const rent = node(plan, 'rent');
    const l = link(plan, pay, rent, { mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(r.links[l.id].total, 6000);
    const short = r.warnings.find((w) => w.code === 'short' && w.linkId === l.id);
    close(short.amount, 6000);
    assert.equal(short.month, 6);
});

test('a fixed link fed by two arrivals in one month is topped up, not double paid', () => {
    const plan = mkPlan('2026-01', 1);
    const a = node(plan, 'other-income', { amount: 300, per: 'month' });
    const b = node(plan, 'freelance', { amount: 300, per: 'month', tax: 0 });
    const living = node(plan, 'living');
    const rent = node(plan, 'rent');
    link(plan, a, living);
    link(plan, b, living);
    const toCard = link(plan, living, rent, { mode: 'fixed', value: 500 });
    const r = run(plan);
    close(r.links[toCard.id].flow[0], 500);
    assert.ok(!r.warnings.some((w) => w.code === 'short'));
});

// ── Accounts ─────────────────────────────────────────────────────────────────

test('deposit links pass arriving money straight through a checking account', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 4000, per: 'month' });
    const checking = node(plan, 'checking', { balance: 0, rate: 0 });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, pay, checking);
    link(plan, checking, savings, { basis: 'inflow', mode: 'percent', value: 25 });
    const r = run(plan);
    close(last(r.nodes[savings.id].balance), 12000);
    close(last(r.nodes[checking.id].balance), 36000);
});

test('earnings links send a share of growth and compound the rest', () => {
    const plan = mkPlan('2026-01', 1);
    const brokerage = node(plan, 'brokerage', { balance: 100000, rate: 12 });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    const l = link(plan, brokerage, savings, { basis: 'earnings', mode: 'percent', value: 50 });
    const r = run(plan);
    const monthly = Math.pow(1.12, 1 / 12) - 1;
    close(r.links[l.id].flow[0], 100000 * monthly / 2);
    close(r.links[l.id].total, r.nodes[brokerage.id].totals.earnings / 2);
    close(last(r.nodes[savings.id].balance), r.links[l.id].total);
});

test('yearly earnings links hold their share and pay it out in their month', () => {
    const plan = mkPlan('2026-01', 1);
    const brokerage = node(plan, 'brokerage', { balance: 100000, rate: 12 });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    const l = link(plan, brokerage, savings, {
        basis: 'earnings', mode: 'percent', value: 50, when: 'yearly', month: 12,
    });
    const r = run(plan);
    const flow = r.links[l.id].flow;
    assert.equal(flow.slice(0, 11).reduce((a, b) => a + b, 0), 0);
    close(flow[11], r.nodes[brokerage.id].totals.earnings / 2);
});

test('a percent of balance every year: the 4% rule', () => {
    const plan = mkPlan('2026-01', 2);
    const nest = node(plan, 'brokerage', { balance: 1000000, rate: 0 });
    const living = node(plan, 'living');
    const l = link(plan, nest, living, { basis: 'balance', mode: 'percent', value: 4, when: 'yearly', month: 1 });
    const r = run(plan);
    close(r.links[l.id].flow[0], 40000);
    close(r.links[l.id].flow[12], 38400);
});

test('"above" sweeps the part of a balance over the threshold', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    const brokerage = node(plan, 'brokerage', { balance: 0, rate: 0 });
    link(plan, pay, savings);
    link(plan, savings, brokerage, { basis: 'balance', mode: 'above', value: 5000 });
    const r = run(plan);
    close(last(r.nodes[savings.id].balance), 5000);
    close(last(r.nodes[brokerage.id].balance), 7000);
});

test('a locked account moves nothing until it unlocks', () => {
    const plan = mkPlan('2026-01', 2);
    const cd = node(plan, 'cd', { balance: 10000, rate: 0, lockUntil: '2027-01' });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    const l = link(plan, cd, savings, { basis: 'balance', mode: 'rest' });
    const r = run(plan);
    assert.equal(r.links[l.id].flow.slice(0, 12).reduce((a, b) => a + b, 0), 0);
    close(r.links[l.id].flow[12], 10000);
    assert.ok(r.milestones.some((m) => m.code === 'unlocks' && m.month === 12));
});

test('a yearly deposit limit parks the excess in Unassigned', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const ira = node(plan, 'roth-ira', { balance: 0, rate: 0, capYearly: 7000 });
    link(plan, pay, ira, { mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(last(r.nodes[ira.id].balance), 7000);
    close(last(r.unassigned), 5000);
    assert.ok(codes(r).includes('cap'));
});

// ── Debts ────────────────────────────────────────────────────────────────────

test('a paid-off debt passes later payments on: the snowball', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 500, per: 'month' });
    const small = node(plan, 'medical-debt', { balance: 1000, rate: 0 });
    const big = node(plan, 'personal-loan', { balance: 5000, rate: 0, minPayment: null });
    link(plan, pay, small, { mode: 'fixed', value: 500 });
    link(plan, small, big, { mode: 'rest' });
    const r = run(plan);
    assert.equal(r.nodes[small.id].balance[2], 0);
    close(r.nodes[big.id].balance[3], 4500);
    close(last(r.nodes[big.id].balance), 0);
    const paidOff = r.milestones.filter((m) => m.code === 'paid-off').map((m) => [m.nodeId, m.month]);
    assert.deepEqual(paidOff, [[small.id, 1], [big.id, 11]]);
});

test('a loan with a term is paid its scheduled payment and clears on time', () => {
    const plan = mkPlan('2026-01', 3);
    const pay = node(plan, 'other-income', { amount: 2000, per: 'month' });
    const loan = node(plan, 'car-loan', { balance: 20000, rate: 7, term: 3 });
    const savings = node(plan, 'savings');
    link(plan, pay, loan, { mode: 'due' });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    const due = Plan.loanPayment({ balance: 20000, rate: 7, term: 3 });
    close(r.links.l_0.flow[0], due);
    close(r.nodes[loan.id].payment, due);
    assert.ok(Math.abs(last(r.nodes[loan.id].balance)) < 1e-4);
    assert.ok(!codes(r).includes('underpaid'));
    assert.ok(!codes(r).includes('short'));
});

test('payments stop at payoff and the freed money falls to the payer\'s rest', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const loan = node(plan, 'personal-loan', { balance: 1000, rate: 0 });
    const savings = node(plan, 'savings');
    link(plan, pay, loan, { mode: 'fixed', value: 400 });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.nodes[loan.id].totals.paid, 1000);           // 400 + 400 + 200
    close(last(r.nodes[savings.id].balance), 12000 - 1000);
    close(r.totals.unassigned, 0);
    assert.ok(!codes(r).includes('short'));
});

test('withdrawals from a balance stop at payoff too', () => {
    const plan = mkPlan('2026-01', 1);
    const checking = node(plan, 'checking', { balance: 5000 });
    const loan = node(plan, 'student-loan', { balance: 900, rate: 0 });
    link(plan, checking, loan, { basis: 'balance', mode: 'fixed', value: 500 });
    const r = run(plan);
    close(last(r.nodes[checking.id].balance), 4100);
    close(r.totals.unassigned, 0);
});

test('"due" pays a card in full: no interest is ever charged', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 3000, per: 'month' });
    const card = node(plan, 'credit-card', { balance: 0, rate: 24 });
    const dining = node(plan, 'dining');
    const savings = node(plan, 'savings');
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 800 });
    link(plan, pay, card, { mode: 'due' });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.interest, 0);
    close(last(r.nodes[card.id].balance), 0);
    close(last(r.nodes[savings.id].balance), 12 * 2200);
});

test('two payers on "due" split one payment, they do not each pay it', () => {
    const plan = mkPlan('2026-01', 1);
    const a = node(plan, 'other-income', { amount: 300, per: 'month' });
    const b = node(plan, 'freelance', { amount: 1000, per: 'month' });
    const loan = node(plan, 'car-loan', { balance: 24000, rate: 0, term: 2 });
    link(plan, a, loan, { mode: 'due' });
    link(plan, b, loan, { mode: 'due' });
    const r = run(plan);
    close(r.nodes[loan.id].paid[0], 1000);
    close(r.links.l_0.flow[0], 300);
    close(r.links.l_1.flow[0], 700);
});

test('payments under the minimum are flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const loan = node(plan, 'car-loan', { balance: 10000, rate: 6, minPayment: 400 });
    link(plan, pay, loan, { mode: 'fixed', value: 200 });
    link(plan, pay, node(plan, 'living'));
    const r = run(plan);
    const w = r.warnings.find((x) => x.code === 'underpaid');
    assert.equal(w.nodeId, loan.id);
    assert.equal(w.month, 0);
});

test('a loan dated inside the plan pays out its proceeds: buying a home leaves net worth unchanged', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'savings', { balance: 60000, rate: 0 });
    const home = node(plan, 'home', { balance: 0, rate: 0 });
    const mortgage = node(plan, 'mortgage', { balance: 240000, rate: 0, minPayment: null, start: '2026-03' });
    link(plan, mortgage, home, { basis: 'proceeds', mode: 'rest', when: 'once' });
    link(plan, savings, home, { basis: 'balance', mode: 'fixed', value: 60000, when: 'once', date: '2026-03' });
    const r = run(plan);
    close(r.nodes[home.id].balance[3], 300000);
    close(r.nodes[mortgage.id].balance[3], 240000);
    assert.equal(r.nodes[mortgage.id].balance[2], 0);
    close(r.netWorth[3], 60000);
});

// ── Modifiers ────────────────────────────────────────────────────────────────

test('a credit card pays for spending: purchases raise the balance, cash back lowers it', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 2 });
    const groceries = node(plan, 'groceries');
    link(plan, card, groceries, { basis: 'charges', mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(r.nodes[card.id].totals.charged, 12000);
    close(r.nodes[card.id].totals.cashback, 240);
    close(last(r.nodes[card.id].balance), 11760);
    close(r.totals.spent, 12000);
    close(r.totals.cashback, 240);
    assert.ok(!r.warnings.some((w) => w.code === 'short'));
});

test('cash back links send it elsewhere instead of crediting the balance', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 2 });
    const groceries = node(plan, 'groceries');
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, card, groceries, { basis: 'charges', mode: 'fixed', value: 1000 });
    link(plan, card, savings, { basis: 'cashback', mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[card.id].balance), 12000);
    close(last(r.nodes[savings.id].balance), 240);
});

test('a payment from income pays a card off, and overpaying passes the rest on', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const card = node(plan, 'credit-card', { balance: 3000, rate: 0, cashBack: 0 });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, pay, card);
    link(plan, card, savings, { basis: 'inflow', mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.paid, 3000);
    close(last(r.nodes[card.id].balance), 0);
    close(last(r.nodes[savings.id].balance), 9000);
});

test('a 401(k) contribution comes out of gross pay, before withholding', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 22 });
    const k = node(plan, '401k');
    const savings = node(plan, 'savings');
    link(plan, salary, k, { mode: 'percent', value: 6 });
    link(plan, salary, savings, { mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 6000);
    close(r.totals.withheld, 94000 * 0.22);
    close(last(r.nodes[savings.id].balance), 94000 * 0.78);
    close(r.nodes[salary.id].totals.pretax, 6000);
});

test('contributions through an employer match are pre-tax too', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 20 });
    const match = node(plan, 'employer-match', { rate: 50 });
    const k = node(plan, '401k');
    link(plan, salary, match, { mode: 'percent', value: 6 });
    link(plan, match, k, { mode: 'rest' });
    link(plan, salary, node(plan, 'living'), { mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 9000);
    close(r.totals.withheld, 94000 * 0.2);
});

test('a Roth IRA is paid from take-home pay', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 22 });
    const roth = node(plan, 'roth-ira');
    link(plan, salary, roth, { mode: 'percent', value: 6 });
    link(plan, salary, node(plan, 'living'), { mode: 'rest' });
    const r = run(plan);
    close(r.totals.withheld, 22000);
    close(last(r.nodes[roth.id].balance), 78000 * 0.06);
});

test('an employer match stops at its yearly limit and restarts in January', () => {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'other-income', { amount: 10000, per: 'month' });
    const match = node(plan, 'employer-match', { rate: 50, capYearly: 3000 });
    const k401 = node(plan, '401k', { balance: 0, rate: 0 });
    link(plan, pay, match, { mode: 'fixed', value: 1000 });
    link(plan, pay, node(plan, 'living'));
    link(plan, match, k401);
    const r = run(plan);
    const added = r.nodes[match.id].produced;
    close(added[0], 500);
    close(added[5], 500);
    assert.equal(added[6], 0);
    close(added[12], 500);
    close(r.totals.match, 6000);
    close(r.nodes[k401.id].balance[12], 15000);
});

test('a tax modifier takes its cut and passes the rest on', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const tax = node(plan, 'tax', { rate: 20 });
    const savings = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, pay, tax);
    link(plan, tax, savings);
    const r = run(plan);
    close(last(r.nodes[savings.id].balance), 9600);
    close(r.totals.skimmed, 2400);
});

// ── Links over time ──────────────────────────────────────────────────────────

test('link windows and growing fixed amounts', () => {
    const plan = mkPlan('2026-01', 3);
    const pay = node(plan, 'other-income', { amount: 5000, per: 'month' });
    const rent = node(plan, 'rent');
    const l = link(plan, pay, rent, {
        mode: 'fixed', value: 1000, growth: 10, start: '2026-07', end: '2027-12',
    });
    link(plan, pay, node(plan, 'living'));
    const r = run(plan);
    const f = r.links[l.id].flow;
    assert.equal(f[5], 0);
    close(f[6], 1000);
    close(f[18], 1100);
    assert.equal(f[24], 0);
});

test('a once link moves its amount on its date only', () => {
    const plan = mkPlan('2026-01', 2);
    const savings = node(plan, 'savings', { balance: 50000, rate: 0 });
    const wedding = node(plan, 'wedding');
    const l = link(plan, savings, wedding, {
        basis: 'balance', mode: 'fixed', value: 30000, when: 'once', date: '2026-09',
    });
    const r = run(plan);
    close(r.links[l.id].total, 30000);
    close(r.links[l.id].flow[8], 30000);
});

// ── Safety ───────────────────────────────────────────────────────────────────

test('a loop that passes everything around settles, flags itself and conserves money', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const a = node(plan, 'checking', { balance: 0, rate: 0 });
    const b = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, pay, a);
    link(plan, a, b, { basis: 'inflow', mode: 'rest' });
    link(plan, b, a, { basis: 'inflow', mode: 'rest' });
    const r = run(plan);
    assert.ok(codes(r).includes('loop'));
    assert.ok(codes(r).includes('runaway'));
});

test('a loop that passes on part of the money converges without hitting the guard', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'other-income', { amount: 1000, per: 'month' });
    const a = node(plan, 'checking', { balance: 0, rate: 0 });
    const b = node(plan, 'savings', { balance: 0, rate: 0 });
    link(plan, pay, a);
    link(plan, a, b, { basis: 'inflow', mode: 'percent', value: 50 });
    link(plan, b, a, { basis: 'inflow', mode: 'percent', value: 50 });
    const r = run(plan);
    assert.ok(codes(r).includes('loop'));
    assert.ok(!codes(r).includes('runaway'));
    close(r.totals.endNetWorth, 12000);
});

test('the outlook example: salary, spending, savings, brokerage, card, five years', () => {
    const plan = mkPlan('2026-10', 5);
    const salary = node(plan, 'salary', { amount: 85000, per: 'year', growth: 3, tax: 22 });
    const living = node(plan, 'living');
    const savings = node(plan, 'hysa', { balance: 5000, rate: 4 });
    const brokerage = node(plan, 'brokerage', { balance: 0, rate: 7 });
    const card = node(plan, 'credit-card', { cashBack: 2 });
    const dining = node(plan, 'dining');
    link(plan, salary, living, { mode: 'percent', value: 60 });
    link(plan, salary, savings, { mode: 'percent', value: 15 });
    link(plan, salary, brokerage, { mode: 'rest' });
    link(plan, brokerage, savings, { basis: 'earnings', mode: 'percent', value: 50, when: 'yearly', month: 12 });
    link(plan, salary, card, { mode: 'fixed', value: 450 });
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 450 });
    link(plan, card, savings, { basis: 'cashback', mode: 'rest' });
    const r = run(plan);
    assert.equal(r.months, 60);
    assert.ok(r.totals.endNetWorth > 100000);
    assert.ok(last(r.nodes[savings.id].balance) > 0);
    assert.ok(r.totals.cashback > 0);
    assert.deepEqual(codes(r), []);
});

// ── Credit card ──────────────────────────────────────────────────────────────

test('the annual fee is added to the balance in month one and every twelfth after', () => {
    const plan = mkPlan('2026-01', 2);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 0, annualFee: 95 });
    const r = run(plan);
    const n = r.nodes[card.id];
    close(n.fees[0], 95);
    close(n.fees[12], 95);
    close(n.totals.fees, 190);
    close(last(n.balance), 190);
    close(r.totals.skimmed, 190);
    close(r.totals.endNetWorth, -190);
});

test('an unpaid annual fee accrues interest like the rest of the balance', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 12, cashBack: 0, annualFee: 100 });
    const r = run(plan);
    close(last(r.nodes[card.id].balance), 100 * Math.pow(1.01, 12));
});

test('a card with no annual fee charges nothing', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { cashBack: 2 });
    const r = run(plan);
    close(r.nodes[card.id].totals.fees, 0);
});
