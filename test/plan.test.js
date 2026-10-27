'use strict';

// The plan document's rules: which links may be drawn, what a new link starts
// as, how a rule is kept inside what its source allows, and the validator that
// guards every save.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Catalog = require('../static/js/sim/catalog.js');
const Plan = require('../static/js/sim/plan.js');

// Choice fields have no empty value, so a module may pick how often it pays.
const FIELD_CADENCE = new Set(['per', 'payMonth']);

const close = (actual, expected, tol = 1e-6) =>
    assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
        `expected ${expected}, got ${actual}`);

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
    assert.ok(Catalog.PRESETS.length >= 15);
});

test('the catalog: the generated icon data holds every icon a module can wear', () => {
    const file = path.join(__dirname, '..', 'static', 'js', 'core', 'icon-data.js');
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
    const drawn = new Set(Object.keys(sandbox.window.CITRINE_ICON_DATA.regular));
    const missing = Catalog.PRESETS.flatMap((p) => Catalog.iconChoices(p)).filter((icon) => !drawn.has(icon));
    assert.deepEqual([...new Set(missing)], [], 'run `npm run icons:ui` after adding a module icon');
});

test('a retired preset folds into one whose category offers its old icon', () => {
    for (const [old, { type, icon }] of Object.entries(Plan.RETIRED_TYPES)) {
        const survivor = Catalog.preset(type);
        assert.ok(survivor, `${old} folds into ${type}`);
        assert.ok(Catalog.iconChoices(survivor).includes(icon), `${old} keeps its ${icon} icon as a ${type}`);
    }
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
    const { nodes } = planWith('term-deposit');
    assert.equal(nodes[0].params.lockUntil, null);
});

test('links: nothing into income, no self links, no duplicates, spending sends nothing, a budget group is a modifier', () => {
    const { plan, nodes: [salary, living, savings, card, rent] } = planWith('salary', 'living', 'bank-account', 'credit-card', 'expense');
    assert.equal(Plan.roleOf(living), 'modifier');
    assert.equal(Plan.canConnect(plan, salary.id, living.id).ok, true);
    assert.equal(Plan.canConnect(plan, living.id, salary.id).reason, 'role');
    assert.equal(Plan.canConnect(plan, salary.id, salary.id).reason, 'self');
    assert.equal(Plan.canConnect(plan, living.id, savings.id).ok, true);
    assert.equal(Plan.canConnect(plan, living.id, rent.id).ok, true);
    assert.equal(Plan.canConnect(plan, card.id, living.id, 'charges').reason, 'basis');
    assert.equal(Plan.canConnect(plan, rent.id, living.id).reason, 'role');
    assert.deepEqual(Plan.basesFor(rent), []);
    plan.links.push(Plan.createLink(plan, salary.id, living.id));
    assert.equal(Plan.canConnect(plan, salary.id, living.id).reason, 'duplicate');
});

test('default rules: links start on %, the first at 100, the next a slice, a priced target asks its price', () => {
    const { plan, nodes: [salary, living, savings, rent] } = planWith('salary', 'living', 'bank-account', 'expense');
    const first = Plan.createLink(plan, salary.id, living.id);
    plan.links.push(first);
    assert.deepEqual([first.mode, first.value], ['percent', 100]);
    const second = Plan.createLink(plan, salary.id, savings.id);
    plan.links.push(second);
    assert.deepEqual([second.mode, second.value], ['percent', 10]);
    const third = Plan.createLink(plan, salary.id, rent.id);
    assert.deepEqual([third.mode, third.value, third.when], ['fixed', 0, 'monthly']);
});

test('default rules: an account sends a fixed amount from its balance', () => {
    const { plan, nodes: [brokerage, savings, rent] } = planWith('investment', 'bank-account', 'expense');
    const toAccount = Plan.createLink(plan, brokerage.id, savings.id);
    assert.deepEqual([toAccount.basis, toAccount.mode, toAccount.value, toAccount.when], ['balance', 'fixed', 500, 'monthly']);
    const toBill = Plan.createLink(plan, savings.id, rent.id);
    assert.deepEqual([toBill.basis, toBill.mode], ['balance', 'fixed']);
});

test('a debt dated inside the plan offers its proceeds first', () => {
    const { plan, nodes: [mortgage, savings] } = planWith('loan', 'bank-account');
    mortgage.params.start = '2027-06';
    const l = Plan.createLink(plan, mortgage.id, savings.id);
    assert.deepEqual([l.basis, l.mode], ['proceeds', 'percent']);
    mortgage.params.start = null;
    Plan.fitRule(l, mortgage);
    assert.equal(l.basis, 'inflow');
});

test('no rule asks for "the payment due": a saved one becomes the fixed payment it was making', () => {
    const { plan, nodes: [salary, loan, card, shop] } = planWith('salary', 'loan', 'credit-card', 'expense');
    Object.assign(loan.params, { balance: 20000, rate: 7, term: 3 });
    Object.assign(card.params, { balance: 300 });
    for (const node of [salary, loan, card]) {
        for (const basis of Object.keys(Plan.RULES[Plan.roleOf(node)])) {
            assert.ok(!Plan.modesFor(node, basis).includes('due'), `${node.type} ${basis}`);
        }
    }
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        { id: 'l_loan', from: salary.id, to: loan.id, ...rule, basis: 'inflow', mode: 'due' },
        { id: 'l_card', from: salary.id, to: card.id, ...rule, basis: 'inflow', mode: 'due' },
        { id: 'l_buy', from: card.id, to: shop.id, ...rule, basis: 'charges', mode: 'fixed', value: 100 },
    );
    const v = roundTrip(plan);
    const get = (id) => v.links.find((l) => l.id === id);
    assert.deepEqual([get('l_loan').mode, get('l_loan').when], ['fixed', 'monthly']);
    close(get('l_loan').value, Plan.loanPayment(loan.params));
    assert.deepEqual([get('l_card').mode, get('l_card').value], ['fixed', 400], 'the balance plus a month of purchases');
});

test('pre-tax links: income into a 401(k), HSA or Traditional IRA', () => {
    const { plan, nodes: [salary, k, roth, hsa, savings] } = planWith('salary', '401k', 'tax-free-account', 'pretax-account', 'bank-account');
    const into = (a, b) => { const l = Plan.createLink(plan, a.id, b.id); plan.links.push(l); return l; };
    assert.equal(Plan.isPretax(plan, into(salary, k)), true);
    assert.equal(Plan.isPretax(plan, into(salary, hsa)), true);
    assert.equal(Plan.isPretax(plan, into(salary, roth)), false);
    assert.equal(Plan.isPretax(plan, into(savings, k)), false);   // only pay is pre-tax
});

test('a saved Match module folds into the 401(k) it fed', () => {
    const { plan, nodes: [salary, pay, k, roth] } = planWith('salary', 'paycheck', 'pretax-account', 'tax-free-account');
    const rule = { value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.nodes.push(
        { id: 'n_match', type: 'employer-match', name: 'Match', x: 0, y: 0, params: { rate: 50, capYearly: 3000 } },
        { id: 'n_lost', type: 'employer-match', name: 'Roth match', x: 0, y: 0, params: { rate: 100, capYearly: null } });
    plan.links.push(
        { ...rule, id: 'l_k', from: salary.id, to: k.id, mode: 'percent', value: 6 },
        { ...rule, id: 'l_seen', from: salary.id, to: 'n_match', mode: 'percent', value: 6 },
        { ...rule, id: 'l_told', from: pay.id, to: 'n_match', mode: 'fixed', value: 200 },
        { ...rule, id: 'l_in', from: 'n_match', to: k.id, mode: 'rest' },
        { ...rule, id: 'l_roth', from: pay.id, to: 'n_lost', mode: 'fixed', value: 100 },
        { ...rule, id: 'l_out', from: 'n_lost', to: roth.id, mode: 'rest' });
    const before = JSON.stringify(plan);
    const v = Plan.validatePlan(plan);
    assert.equal(JSON.stringify(plan), before, 'the saved plan is not touched');
    const saved = v.nodes.find((n) => n.id === k.id);
    assert.equal(saved.type, '401k');
    assert.deepEqual([saved.params.match, saved.params.matchLimit], [50, 3000]);
    assert.equal(v.nodes.some((n) => n.type === 'employer-match'), false);
    // Pay already going to the 401(k) stays as it was; pay only told to the match now goes there.
    assert.deepEqual(v.links.map((l) => l.id).sort(), ['l_k', 'l_told']);
    assert.equal(v.links.find((l) => l.id === 'l_told').to, k.id);
    // A match that fed no pre-tax account is dropped, and the Roth keeps its own type.
    assert.equal(v.nodes.find((n) => n.id === roth.id).type, 'tax-free-account');
});

test('a loan payment levels out over its years left', () => {
    close(Plan.loanPayment({ balance: 300000, rate: 6, term: 30 }), 1798.65, 1e-5);
    close(Plan.loanPayment({ balance: 12000, rate: 0, term: 1 }), 1000);
    close(Plan.loanPayment({ balance: 5000, rate: 9 }), 0);
});

test('fitRule keeps a rule inside what its source allows', () => {
    const { nodes: [salary] } = planWith('salary');
    const l = { mode: 'above', basis: 'balance', when: 'once', value: 5 };
    Plan.fitRule(l, salary);
    assert.deepEqual([l.basis, l.mode, l.when], ['inflow', 'percent', 'monthly']);
});

test('validatePlan normalizes numbers and rejects structure it cannot trust', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'bank-account');
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
    bad((p) => { Object.assign(p.links[0], { from: p.nodes[1].id, to: p.nodes[0].id, basis: 'balance' }); }, /cannot be linked/);
    bad((p) => { p.nodes[0].params.amount = 'lots'; }, /must be a number/);
    bad((p) => { p.settings.start = 'soon'; }, /month/);
    bad((p) => { p.nodes[0].id = '<script>'; }, /valid id/);
    bad((p) => { p.nodes = new Array(Plan.LIMITS.nodes + 1).fill(p.nodes[0]); }, /at most/);
});

test('two rest links on one basis cannot both stand', () => {
    const { plan, nodes: [salary, a, b] } = planWith('salary', 'living', 'bank-account');
    plan.links.push({ ...Plan.createLink(plan, salary.id, a.id), mode: 'rest' });
    plan.links.push({ ...Plan.createLink(plan, salary.id, b.id), mode: 'rest' });
    const v = Plan.validatePlan(plan);
    assert.deepEqual(v.links.map((l) => l.mode), ['rest', 'percent']);
});

test('cloneWithNewIds gives a plan that shares no id with the original', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'bank-account');
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    const copy = Plan.cloneWithNewIds(plan, 'Copy');
    const ids = (p) => [p.id, ...p.nodes.map((n) => n.id), ...p.links.map((l) => l.id)];
    assert.equal(ids(copy).filter((id) => ids(plan).includes(id)).length, 0);
    assert.equal(copy.links[0].from, copy.nodes[0].id);
    assert.doesNotThrow(() => Plan.validatePlan(copy));
});

test('default rules: a debt is paid what it asks for, a 401(k) a slice of pay', () => {
    const { plan, nodes: [salary, loan, k, savings] } = planWith('salary', 'loan', '401k', 'bank-account');
    Object.assign(loan.params, { balance: 12000, rate: 0, term: 1 });
    const pay = Plan.createLink(plan, salary.id, loan.id);
    assert.deepEqual([pay.mode, pay.value, pay.when], ['fixed', 1000, 'monthly']);
    const fromSavings = Plan.createLink(plan, savings.id, loan.id);
    assert.deepEqual([fromSavings.basis, fromSavings.mode, fromSavings.value], ['balance', 'fixed', 1000]);
    const contribute = Plan.createLink(plan, salary.id, k.id);
    assert.deepEqual([contribute.mode, contribute.value], ['percent', 6]);
});

// ── People ───────────────────────────────────────────────────────────────────

test('a person links to any module, income included, and nothing links into a person', () => {
    const { plan, nodes: [me, salary, savings] } = planWith('person', 'salary', 'bank-account');
    assert.equal(Plan.canConnect(plan, me.id, salary.id).ok, true);
    assert.equal(Plan.canConnect(plan, salary.id, me.id).ok, false);
    assert.equal(Plan.canConnect(plan, savings.id, salary.id).ok, false, 'only a person reaches income');
    const l = Plan.createLink(plan, me.id, salary.id);
    assert.deepEqual([l.basis, l.mode, l.when], ['person', 'rest', 'monthly']);
    plan.links.push(l);
    assert.equal(Plan.validatePlan(plan).links[0].basis, 'person');
});

test('a new person starts with the plan, and the plan starts with its earliest person', () => {
    const { plan, nodes: [a] } = planWith('person');
    assert.equal(a.params.planStart, '2026-01');
    const b = Plan.createNode(plan, 'person', 0, 0);
    plan.nodes.push(b);
    b.params.planStart = '2025-06';
    assert.equal(Plan.syncStart(plan), true);
    assert.equal(plan.settings.start, '2025-06');
    a.params.planStart = '2027-03';
    assert.equal(Plan.syncStart(plan), false, 'the earlier person still starts it');
    b.params.planStart = '2028-01';
    Plan.syncStart(plan);
    assert.equal(plan.settings.start, '2027-03');
    // A saved plan opens at its earliest person's start.
    const saved = JSON.parse(JSON.stringify(plan));
    saved.settings.start = '2020-01';
    assert.equal(Plan.validatePlan(saved).settings.start, '2027-03');
});

test('a plan with no person keeps its start', () => {
    const { plan } = planWith('salary');
    assert.equal(Plan.syncStart(plan), false);
    assert.equal(plan.settings.start, '2026-01');
});

test('a person reaches what their modules\' money reaches, and their age counts from their start', () => {
    const { plan, nodes: [me, salary, savings, card, shop, other] } = planWith('person', 'salary', 'bank-account', 'credit-card', 'expense', 'investment');
    const into = (a, b) => plan.links.push(Plan.createLink(plan, a.id, b.id));
    into(me, salary);
    into(salary, savings);
    into(salary, card);
    into(card, shop);
    assert.deepEqual([...Plan.personReach(plan, me.id)].sort(), [salary.id, savings.id, card.id, shop.id].sort());
    assert.equal(Plan.personReach(plan, me.id).has(other.id), false);
    Object.assign(me.params, { age: 34, planStart: '2026-10' });
    assert.equal(Plan.ageAt(me, '2026-10'), 34);
    assert.equal(Plan.ageAt(me, '2027-09'), 34);
    assert.equal(Plan.ageAt(me, '2027-10'), 35);
    me.params.age = null;
    assert.equal(Plan.ageAt(me, '2030-01'), null);
});

// ── What a link carries ──────────────────────────────────────────────────────

test('each module can send one thing per basis', () => {
    const { nodes: [salary, checking, groceries, living, mortgage, card] } = planWith('salary', 'bank-account', 'expense', 'living', 'loan', 'credit-card');
    const bases = (n) => Plan.basesFor(n);
    assert.deepEqual(bases(salary), ['inflow']);
    assert.deepEqual(bases(checking), ['balance'], 'an account sends only from its balance');
    assert.deepEqual(bases(groceries), []);
    assert.deepEqual(bases(living), ['inflow']);
    assert.deepEqual(bases(mortgage), ['inflow']);
    assert.deepEqual(bases(card), ['charges'], 'a card is paid, and pays only for purchases');
    mortgage.params.start = '2026-06';
    assert.deepEqual(bases(mortgage), ['inflow', 'proceeds']);
});

test('a basis reaches only the roles it can send to', () => {
    const { plan, nodes: [checking, card, groceries, savings, mortgage] } = planWith('bank-account', 'credit-card', 'expense', 'bank-account', 'loan');
    assert.deepEqual(Plan.portTargets(card, 'charges'), ['expense']);
    assert.equal(Plan.canConnect(plan, card.id, groceries.id, 'charges').ok, true);
    assert.equal(Plan.canConnect(plan, card.id, savings.id, 'charges').reason, 'basis');
    assert.equal(Plan.canConnect(plan, card.id, savings.id).reason, 'basis', 'cash back is a setting, not a link');
    assert.equal(Plan.canConnect(plan, card.id, mortgage.id).reason, 'basis');
    assert.equal(Plan.canConnect(plan, mortgage.id, savings.id, 'inflow').ok, true, 'a loan still passes overpayment on');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'balance').ok, true);
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'inflow').reason, 'basis', 'no deposits port on an account');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'earnings').reason, 'basis');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'charges').reason, 'basis');
});

test('two modules link once per basis, not once in all', () => {
    const { plan, nodes: [loan, savings] } = planWith('loan', 'bank-account');
    loan.params.start = '2027-01';
    const a = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    assert.equal(a.basis, 'proceeds');
    plan.links.push(a);
    assert.equal(Plan.canConnect(plan, loan.id, savings.id, 'proceeds').reason, 'duplicate');
    assert.equal(Plan.canConnect(plan, loan.id, savings.id, 'inflow').ok, true);
});

test('a link asked to start on a basis starts there with a sensible rule', () => {
    const { plan, nodes: [loan, savings, checking, card] } = planWith('loan', 'bank-account', 'bank-account', 'credit-card');
    loan.params.start = '2027-01';
    const proceeds = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    assert.deepEqual([proceeds.basis, proceeds.mode, proceeds.when], ['proceeds', 'percent', 'once']);
    const bal = Plan.createLink(plan, checking.id, card.id, 'balance');
    assert.deepEqual([bal.basis, bal.mode], ['balance', 'fixed']);
});

test('a balance link into Rent can send a fixed amount, and starts as one', () => {
    const { plan, nodes: [checking, rent] } = planWith('bank-account', 'expense');
    assert.deepEqual(Plan.modesFor(checking, 'balance'), ['percent', 'fixed', 'rest', 'above']);
    const l = Plan.createLink(plan, checking.id, rent.id, 'balance');
    assert.deepEqual([l.basis, l.mode, l.when], ['balance', 'fixed', 'monthly']);
});

test('validatePlan rejects a link on a basis that cannot reach the target', () => {
    const { plan, nodes: [card, shop, savings] } = planWith('credit-card', 'expense', 'bank-account');
    const l = Plan.createLink(plan, card.id, shop.id, 'charges');
    plan.links.push(l);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
    l.to = savings.id;
    assert.throws(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))), /cannot take it/);
});

test('a plan with two links between the same modules on different bases saves', () => {
    const { plan, nodes: [loan, savings] } = planWith('loan', 'bank-account');
    loan.params.start = '2027-01';
    plan.links.push(Plan.createLink(plan, loan.id, savings.id, 'proceeds'));
    plan.links.push(Plan.createLink(plan, loan.id, savings.id, 'inflow'));
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

// ── Removed presets ──────────────────────────────────────────────────────────

test('a saved plan that holds a removed module opens without it and its links', () => {
    const { plan, nodes: [salary, savings, loan] } = planWith('salary', 'bank-account', 'loan');
    const raw = JSON.parse(JSON.stringify(plan));
    const gone = { id: 'n_home', type: 'real-estate', name: 'Home', x: 40, y: 40, dock: loan.id, params: { value: 300000, rate: 3 } };
    loan.dock = gone.id;
    raw.nodes = JSON.parse(JSON.stringify(plan.nodes));
    raw.nodes.push(gone);
    raw.links = [
        { id: 'l_keep', from: salary.id, to: savings.id, mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 },
        { id: 'l_gone', from: savings.id, to: gone.id, mode: 'fixed', value: 500, basis: 'balance', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 },
    ];
    const v = Plan.validatePlan(raw);
    assert.deepEqual(v.nodes.map((n) => n.id), [salary.id, savings.id, loan.id]);
    assert.deepEqual(v.links.map((l) => l.id), ['l_keep']);
    assert.equal(v.nodes.find((n) => n.id === loan.id).dock, undefined);
    for (const type of ['real-estate', 'rental-property', 'vehicle', 'home', 'land']) {
        assert.ok(Plan.REMOVED_TYPES.has(type), type);
        assert.equal(Catalog.preset(type), null, type);
    }
});

test('older plans lose spending links that are no longer allowed', () => {
    const { plan, nodes: [living, rent, groceries] } = planWith('living', 'expense', 'expense');
    const keep = Plan.createLink(plan, living.id, rent.id);
    const drop = Plan.createLink(plan, rent.id, groceries.id);
    plan.links.push(keep, drop);
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.links.map((l) => l.id), [keep.id]);
});

test('older plans lose a card charge into a budget group', () => {
    const { plan, nodes: [card, living, rent] } = planWith('credit-card', 'living', 'expense');
    const charge = Plan.createLink(plan, card.id, rent.id, 'charges');
    const toGroup = { ...charge, id: 'l-old', to: living.id };
    plan.links.push(charge, toGroup);
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.links.map((l) => l.id), [charge.id]);
});

test('retired banking types open as a Bank account or Term deposit wearing their old icon', () => {
    const old = ['checking', 'savings', 'hysa', 'money-market', 'emergency-fund', 'cash', 'cd'];
    const { plan } = planWith(...old.map(() => 'bank-account'));
    plan.nodes.forEach((n, i) => { n.type = old[i]; });
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.nodes.map((n) => [n.type, Plan.iconOf(n)]), [
        ['bank-account', 'wallet'], ['bank-account', 'piggy-bank'], ['bank-account', 'vault'],
        ['bank-account', 'coin-vertical'], ['bank-account', 'lifebuoy'], ['bank-account', 'money-wavy'],
        ['term-deposit', 'certificate']]);
});

test('connecting a pair again takes the next free basis, until none is left', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const seen = [];
    for (let i = 0; i < 2; i++) {
        assert.equal(Plan.canConnect(plan, a.id, b.id).ok, true);
        const l = Plan.createLink(plan, a.id, b.id);
        seen.push(l.basis);
        plan.links.push(l);
    }
    assert.deepEqual(seen.sort(), ['inflow', 'proceeds']);
    assert.equal(Plan.canConnect(plan, a.id, b.id).reason, 'duplicate');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('a link may move to any basis the pair has free, and to no other', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const l = Plan.createLink(plan, a.id, b.id, 'proceeds');
    plan.links.push(l);
    assert.deepEqual(Plan.basesBetween(plan, a, b, l.id), ['inflow', 'proceeds']);
    assert.deepEqual(Plan.basesBetween(plan, a, b), ['inflow']);
    const other = Plan.createLink(plan, a.id, b.id, 'inflow');
    plan.links.push(other);
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), false, 'taken by another link');
    assert.equal(l.basis, 'proceeds');
    plan.links.pop();
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), true);
    assert.equal(l.basis, 'inflow');
});

test('moving a link to another basis restarts its amount, and keeps its window', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const l = Plan.createLink(plan, a.id, b.id, 'inflow');
    Object.assign(l, { mode: 'fixed', value: 500, start: '2027-01', end: '2028-01' });
    plan.links.push(l);
    assert.equal(Plan.changeBasis(plan, l, 'proceeds'), true);
    assert.deepEqual([l.basis, l.mode, l.value, l.start, l.end], ['proceeds', 'percent', 100, '2027-01', '2028-01']);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('moving a link to a basis where another already takes the rest shares instead', () => {
    const { plan, nodes: [loan, savings, checking] } = planWith('loan', 'bank-account', 'bank-account');
    loan.params.start = '2028-01';
    const first = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    const second = Plan.createLink(plan, loan.id, checking.id, 'inflow');
    first.mode = 'rest';
    plan.links.push(first, second);
    assert.equal(Plan.changeBasis(plan, second, 'proceeds'), true);
    assert.equal(second.mode, 'percent');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('a card link is always a purchase, with a valid rule', () => {
    const { plan, nodes: [card, shop] } = planWith('credit-card', 'expense');
    const l = Plan.createLink(plan, card.id, shop.id);
    plan.links.push(l);
    assert.equal(l.basis, 'charges');
    assert.deepEqual([l.mode, l.when], ['fixed', 'monthly']);
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), false, 'a card sends nothing on');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

// ── A card's cash back setting ──────────────────────────────────────────────

const roundTrip = (plan) => Plan.validatePlan(JSON.parse(JSON.stringify(plan)));

test('a card keeps the account its cash back goes to, and loses one that is gone', () => {
    const { plan, nodes: [card, savings, shop] } = planWith('credit-card', 'bank-account', 'expense');
    assert.equal(card.params.cashBackTo, null);
    card.params.cashBackTo = savings.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, savings.id);
    card.params.cashBackTo = shop.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, null, 'only an account can take cash back');
    card.params.cashBackTo = 'n_gone';
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, null);
});

test('a copy of a plan sends cash back to the copy of the account', () => {
    const { plan, nodes: [card, savings] } = planWith('credit-card', 'bank-account');
    card.params.cashBackTo = savings.id;
    const copy = Plan.cloneWithNewIds(plan);
    assert.notEqual(copy.nodes[1].id, savings.id);
    assert.equal(copy.nodes[0].params.cashBackTo, copy.nodes[1].id);
});

test('an older plan\'s cash back links become the card\'s setting, and its overflow links go', () => {
    const { plan, nodes: [card, checking, savings, mortgage, shop] } = planWith('credit-card', 'bank-account', 'bank-account', 'loan', 'expense');
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        { id: 'l_charge', from: card.id, to: shop.id, ...rule, basis: 'charges', mode: 'fixed', value: 100 },
        { id: 'l_back1', from: card.id, to: checking.id, ...rule, basis: 'cashback', mode: 'percent', value: 30 },
        { id: 'l_back2', from: card.id, to: savings.id, ...rule, basis: 'cashback', mode: 'rest' },
        { id: 'l_over', from: card.id, to: mortgage.id, ...rule, basis: 'inflow', mode: 'rest' },
    );
    const out = roundTrip(plan);
    assert.equal(out.nodes[0].params.cashBackTo, savings.id, 'the account that got most of it');
    assert.deepEqual(out.links.map((l) => l.id), ['l_charge']);
    // A card that already has a setting keeps it.
    card.params.cashBackTo = checking.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, checking.id);
    // Cash back that went against a debt just credits the card again.
    card.params.cashBackTo = null;
    plan.links = plan.links.filter((l) => l.id === 'l_charge');
    plan.links.push({ id: 'l_debt', from: card.id, to: mortgage.id, ...rule, basis: 'cashback', mode: 'rest' });
    const debtOnly = roundTrip(plan);
    assert.equal(debtOnly.nodes[0].params.cashBackTo, null);
    assert.deepEqual(debtOnly.links.map((l) => l.id), ['l_charge']);
});

test('a loan can still pass overpayment on', () => {
    const { plan, nodes: [mortgage, savings] } = planWith('loan', 'bank-account');
    const l = Plan.createLink(plan, mortgage.id, savings.id, 'inflow');
    plan.links.push(l);
    assert.doesNotThrow(() => roundTrip(plan));
    assert.equal(roundTrip(plan).links.length, 1);
});

// ── Account outflows and card limits ─────────────────────────────────────────

test('saved deposit and earnings links out of an account follow the balance rule', () => {
    const { plan, nodes: [checking, savings, brokerage, rent] } = planWith('bank-account', 'bank-account', 'investment', 'expense');
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        // A fixed deposit link becomes the same amount from the balance.
        { id: 'l_fixed', from: checking.id, to: rent.id, ...rule, basis: 'inflow', mode: 'fixed', value: 1500 },
        // A share of deposits or earnings has no equivalent and is dropped.
        { id: 'l_share', from: checking.id, to: savings.id, ...rule, basis: 'inflow', mode: 'percent', value: 25 },
        { id: 'l_earn', from: brokerage.id, to: savings.id, ...rule, basis: 'earnings', mode: 'percent', value: 50 },
        // A fixed deposit link beside a balance link on the same pair cannot also stand.
        { id: 'l_twin_a', from: savings.id, to: rent.id, ...rule, basis: 'inflow', mode: 'fixed', value: 100 },
        { id: 'l_twin_b', from: savings.id, to: rent.id, ...rule, basis: 'balance', mode: 'fixed', value: 200 },
    );
    const v = roundTrip(plan);
    assert.deepEqual(v.links.map((l) => [l.id, l.basis, l.value]), [
        ['l_fixed', 'balance', 1500], ['l_twin_b', 'balance', 200]]);
});

test('a card has a credit limit setting, and its purchases can be a share of it or the credit left', () => {
    const { plan, nodes: [card, shop] } = planWith('credit-card', 'expense');
    assert.equal(card.params.limit, null);
    assert.ok(Catalog.fieldsFor(Catalog.preset('credit-card')).includes('limit'));
    assert.ok(!Catalog.fieldsFor(Catalog.preset('loan')).includes('limit'), 'only a card has a limit');
    assert.deepEqual(Plan.modesFor(card, 'charges'), ['fixed', 'percent', 'rest']);
    card.params.limit = 8000;
    for (const mode of ['percent', 'rest']) {
        const l = { ...Plan.createLink(plan, card.id, shop.id, 'charges'), mode, value: 10 };
        plan.links = [l];
        const v = roundTrip(plan);
        assert.equal(v.nodes[0].params.limit, 8000);
        assert.equal(v.links[0].mode, mode);
    }
    card.params.limit = -5;
    assert.equal(roundTrip(plan).nodes[0].params.limit, 0, 'a limit is clamped into range');
    card.params.limit = null;
    assert.equal(roundTrip(plan).nodes[0].params.limit, null);
});

