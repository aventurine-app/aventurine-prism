'use strict';

// ─── plan.js ────────────────────────────────────────────────────────────────
// The plan document: its shape, how modules and links are created, which
// links are allowed, and the validator that every save passes through.
//
// A plan is plain JSON:
//
//   { id, name, version, createdAt, updatedAt,
//     settings: { start: 'YYYY-MM', years, inflation },
//     view:     { x, y, zoom },            canvas camera, restored on open
//     nodes:    [{ id, type, name, x, y, params, icon? }],
//     links:    [{ id, from, to, mode, value, basis, when, month, date,
//                  start, end, growth }] }
//
// `type` is a preset id from catalog.js, which fixes the node's role.
//
// GOALS are shared by all of a user's plans, not part of any one: a list kept
// beside the plans (validateGoals). Each goal is one rule, a sentence of four
// parts (GOAL_METRICS and the rest below):
//
//   { id, name,
//     metric,          what is measured: 'net-worth' | 'savings' | 'debt' |
//                      'expenses' | 'income'
//     op,              'gte' (is at least) | 'lte' (is at most)
//     unit, value, of, the target: 'amount' (value dollars), 'times' (value
//                      times the `of` measure) or 'percent' (value percent of it)
//     due, by, age,    the deadline: 'date' (the month `by`) or 'age' (the
//                      month the plan's person turns `age`). Every goal has one;
//                      a goal saved with none ('none') is read as due ten years
//                      from now
//     color }          the card's colour (GOAL_COLORS), only for show
//
// e.g. "Net worth is at least 25 times yearly expenses by age 65". Every plan
// is measured against every goal (sim/goals.js works out when each is met).
// Goals move no money and are not drawn on the canvas. Goals of the kinds
// that came before rules (net worth, savings, debt-free, FI, retiring) are
// read as the rules they meant. Plans saved before goals were shared held
// their own; those are read out of the old plan (legacyGoals) and merged into
// the shared list, and a plan no longer keeps any.
//
// LINK RULES. Every link answers one question: how much of the money at its
// source moves to its target. The answer is a mode and a basis:
//
//   mode   percent  value% of the basis
//          fixed    value (a currency amount) each time the link fires
//          rest     whatever is left of the basis after the other links
//          above    accounts only: the part of the balance over `value`
//
//   basis  inflow    money arriving at the source. For income that is the
//                    paycheck; for spending, the spending; for a debt, what is
//                    paid beyond the payoff (loans only; a card sends nothing
//                    on).
//          balance   accounts only, and their only basis: everything an account
//                    sends comes out of its balance
//          proceeds  debts with a start date only: the amount borrowed
//          charges   credit cards only: a purchase the card pays for, charged
//                    to its balance and sent to spending. Percent is a share
//                    of the card's limit, rest is the credit left under it
//
// A card's cash back is not a link. It is the card's `cashBackTo` setting:
// empty credits the card's balance, an account's id deposits it there.
//
// A module has one output port. The basis is the link's own setting, chosen
// when it is edited ("From": a card's purchases or a loan's proceeds, say), and two modules
// may be linked once per basis.
//
// Timing (`when`) is monthly, yearly (in `month`) or once (on `date`), with an
// optional window (`start` / `end`). Money that arrives is split as it
// arrives, so percent and rest links on an inflow are always monthly.
//
// Dual-environment: window.CitrinePlan in the renderer, CommonJS for the
// backend (which validates every save with validatePlan) and the tests.

(function (root, factory) {
    const Catalog = (typeof module === 'object' && module.exports)
        ? require('./catalog.js')
        : root.CitrineCatalog;
    const api = factory(Catalog);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CitrinePlan = api;
}(typeof self !== 'undefined' ? self : this, function (Catalog) {

    const PLAN_VERSION = 1;
    // Presets folded into another. A saved plan that holds one opens as its
    // survivor, wearing the icon the old preset had and keeping the name it
    // was given. A preset that was only a name and icon on another's behaviour
    // (Freelance on Paycheck, Checking on Bank account) is retired this way.
    const retireInto = (type, icons) => Object.fromEntries(
        Object.entries(icons).map(([old, icon]) => [old, { type, icon }]));

    // Presets removed outright. A saved plan that holds one opens without it:
    // the module and its links are dropped, and a loan that was docked under it
    // stands on its own.
    const REMOVED_TYPES = new Set(['real-estate', 'rental-property', 'vehicle', 'home', 'land']);

    const RETIRED_TYPES = {
        ...retireInto('paycheck', { 'side-hustle': 'laptop', 'freelance': 'laptop', 'other-income': 'coins' }),
        ...retireInto('bank-account', {
            'checking': 'wallet', 'savings': 'piggy-bank', 'hysa': 'vault', 'money-market': 'coin-vertical',
            'emergency-fund': 'lifebuoy', 'cash': 'money-wavy' }),
        ...retireInto('term-deposit', { 'cd': 'certificate', 'i-bonds': 'seal-check' }),
        ...retireInto('investment', {
            'brokerage': 'chart-line-up', 'index-fund': 'chart-pie-slice', 'stocks': 'trend-up',
            'bonds': 'seal-percent', 'treasuries': 'bank', 'crypto': 'currency-btc', 'reit': 'building-office',
            'gold': 'diamond' }),
        ...retireInto('pretax-account', { 'trad-ira': 'tree', 'hsa': 'heartbeat' }),
        ...retireInto('tax-free-account', { 'roth-ira': 'tree-evergreen', '529': 'graduation-cap' }),
        ...retireInto('expense', {
            'rent': 'house', 'groceries': 'basket', 'dining': 'fork-knife', 'utilities': 'lightning',
            'transport': 'bus', 'insurance': 'shield-check', 'healthcare': 'first-aid', 'subscriptions': 'repeat',
            'entertainment': 'popcorn', 'shopping': 'handbag', 'travel': 'airplane-tilt', 'childcare': 'baby',
            'education': 'book-open', 'pets': 'paw-print', 'gifts': 'gift', 'charity': 'hand-heart',
            'taxes': 'receipt', 'home-upkeep': 'hammer' }),
        ...retireInto('loan', {
            'student-loan': 'student', 'car-loan': 'car-profile', 'mortgage': 'house-simple', 'home-equity': 'key',
            'personal-loan': 'handshake', 'medical-debt': 'first-aid-kit', 'bnpl': 'shopping-cart-simple' }),
        ...retireInto('tax-or-fee', { 'tax': 'percent', 'fee': 'scissors' }),
        ...retireInto('one-time-income', { 'windfall': 'sparkle', 'inheritance': 'scroll' }),
        ...retireInto('expense', {
            'one-time-expense': 'package', 'big-purchase': 'package', 'new-car': 'package', 'wedding': 'heart',
            'dream-trip': 'island', 'emergency': 'siren' }),
    };

    // Card geometry shared with canvas.js and canvas.css (change all together).
    const GEOM = { NODE_W: 220, NODE_H: 140 };

    // Bounds. A plan larger than these is not a plan anyone draws by hand; the
    // limits exist so a corrupt or hostile document cannot make the backend
    // write, or the engine walk, something unbounded.
    const LIMITS = {
        nodes:    400,
        links:    1200,
        goals:    24,
        name:     60,
        years:    60,
        idLength: 40,
        money:    1e11,
    };

    // ── Year-months ────────────────────────────────────────────────────────
    // Dates in a plan are calendar months, written 'YYYY-MM'. They are kept as
    // strings (not month offsets) so moving the plan's start leaves a dated
    // event on its date.
    const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function ymParse(ym) {
        const m = typeof ym === 'string' ? YM_RE.exec(ym) : null;
        if (!m) return null;
        const y = Number(m[1]);
        if (y < 1900 || y > 2300) return null;
        return { y, m: Number(m[2]) };
    }

    function ymFormat(y, m) {
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    }

    function ymNow() {
        const d = new Date();
        return ymFormat(d.getFullYear(), d.getMonth() + 1);
    }

    /** ym shifted by `months` (may be negative). */
    function ymAdd(ym, months) {
        const p = ymParse(ym);
        if (!p) return null;
        const total = p.y * 12 + (p.m - 1) + months;
        return ymFormat(Math.floor(total / 12), (total % 12) + 1);
    }

    /** Whole months from `a` to `b` (b - a). */
    function ymDiff(a, b) {
        const pa = ymParse(a);
        const pb = ymParse(b);
        if (!pa || !pb) return null;
        return (pb.y - pa.y) * 12 + (pb.m - pa.m);
    }

    /** 'Oct 2026'. */
    function ymLabel(ym) {
        const p = ymParse(ym);
        return p ? `${MONTHS[p.m - 1]} ${p.y}` : '';
    }

    // ── Ids ────────────────────────────────────────────────────────────────
    const ID_RE = /^[a-z0-9_-]{1,40}$/;

    function newId(prefix) {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        let s = '';
        for (const b of bytes) s += (b % 36).toString(36);
        return `${prefix}_${s}`;
    }

    // ── Link rule space ────────────────────────────────────────────────────
    // Which modes each basis offers, per source role. Order is display order.
    const RULES = {
        // A person's links move no money: they name what is theirs.
        person:   { person: ['rest'] },
        source:   { inflow: ['percent', 'fixed', 'rest'] },
        expense:  { inflow: ['percent', 'fixed', 'rest'] },
        modifier: { inflow: ['percent', 'fixed', 'rest'] },
        debt:     {
            inflow:   ['percent', 'fixed', 'rest'],
            proceeds: ['percent', 'rest'],
            charges:  ['fixed', 'percent', 'rest'],
        },
        account:  { balance: ['percent', 'fixed', 'rest', 'above'] },
    };

    /** The `when` values a rule offers. The first is the default. */
    function timingsFor(basis, mode) {
        if (basis === 'proceeds') return ['once'];
        if (basis === 'person') return ['monthly'];
        if (basis === 'charges') return ['monthly', 'yearly', 'once'];
        if (basis === 'inflow') return mode === 'fixed' ? ['monthly', 'yearly', 'once'] : ['monthly'];
        if (mode === 'above') return ['monthly', 'yearly'];
        return ['monthly', 'yearly', 'once'];
    }

    /** Bases a node offers to its outgoing links. A debt only borrows (and so
     *  only has proceeds to send) when it starts inside the plan. A credit card
     *  only has purchases: it is paid, never paid onward. */
    function basesFor(node) {
        const p = Catalog.preset(node.type);
        if (!p) return [];
        const bases = Object.keys(RULES[p.role]);
        // Spending consumes what it receives; it sends nothing on.
        if (p.role === 'expense') return [];
        if (p.role !== 'debt') return bases;
        if (p.kind === 'card') return ['charges'];
        return bases.filter((b) => b !== 'charges' && (b !== 'proceeds' || node.params.start));
    }

    /** The modes a link on `basis` offers. */
    function modesFor(node, basis) {
        const p = Catalog.preset(node.type);
        return (p && RULES[p.role][basis]) || [];
    }

    /** Whether income sent along `link` is a pre-tax contribution: it leaves
     *  an income module for a pre-tax account (401(k), HSA, Traditional IRA). */
    function isPretax(plan, link) {
        const from = nodeById(plan, link.from);
        const to = nodeById(plan, link.to);
        return roleOf(from) === 'source' && !!to && !!Catalog.preset(to.type).pretax;
    }

    /** A loan's monthly payment: the level payment that clears `balance` over
     *  its years left at its APR. Without a term there is no schedule, so
     *  nothing. A card has no schedule either. */
    function loanPayment(params) {
        const principal = params.balance || 0;
        const n = params.term ? Math.max(1, Math.round(params.term * 12)) : 0;
        if (!n) return 0;
        const r = (params.rate || 0) / 1200;
        return r > 0 ? principal * r / (1 - Math.pow(1 + r, -n)) : principal / n;
    }

    function roleOf(node) {
        const p = node && Catalog.preset(node.type);
        return p ? p.role : null;
    }

    /** The roles a link on `basis` may run into. A card's purchases pay for
     *  spending; every other basis goes wherever the source's role may link. */
    function portTargets(node, basis) {
        if (basis === 'charges') return ['expense'];
        return Catalog.LINK_TARGETS[roleOf(node)] || [];
    }

    const nodeById = (plan, id) => plan.nodes.find((n) => n.id === id);

    /** The roles a module may send to on any of its bases. */
    function targetRoles(node) {
        const roles = new Set();
        for (const basis of basesFor(node)) for (const r of portTargets(node, basis)) roles.add(r);
        return [...roles];
    }

    /** The bases a link from `from` to `to` could be on: the ones that reach
     *  the target's role and that no other link between the pair already uses.
     *  `exceptLinkId` is a link being edited, which does not block itself. */
    function basesBetween(plan, from, to, exceptLinkId = null) {
        const role = roleOf(to);
        return basesFor(from).filter((basis) => portTargets(from, basis).includes(role)
            && !plan.links.some((l) => l.id !== exceptLinkId && l.from === from.id && l.to === to.id && l.basis === basis));
    }

    // ── Goals ──────────────────────────────────────────────────────────────
    // The parts a goal's rule is built from (see the header). A goal is shared
    // by every plan, so it names no module of any one: its measures cover them
    // all. What each measure counts is sim/goals.js's.

    const GOAL_METRICS = ['net-worth', 'savings', 'debt', 'expenses', 'income'];
    const GOAL_OPS = ['gte', 'lte'];
    const GOAL_UNITS = ['amount', 'times', 'percent'];
    const GOAL_DUES = ['date', 'age'];
    // A goal with no deadline given is due this far from now.
    const GOAL_DUE_MONTHS = 120;
    const defaultBy = () => ymAdd(ymNow(), GOAL_DUE_MONTHS);
    // How large a target may be, by unit.
    const GOAL_VALUE = { amount: 1e11, times: 1000, percent: 1000 };
    const GOAL_AGE = { min: 1, max: 120 };
    // The colours a goal's card can be, in the order offered: Aventurine
    // Manage's Gemstone palette, in its order.
    const GOAL_COLORS = ['lapis', 'tourmaline', 'tigers-eye', 'garnet', 'tanzanite', 'amber', 'rhodolite', 'emerald'];
    // Colours offered before the Gemstone palette, read as the stone nearest them.
    const OLD_GOAL_COLORS = {
        teal: 'tourmaline', blue: 'lapis', violet: 'tanzanite', rose: 'garnet',
        orange: 'amber', green: 'emerald', slate: 'lapis', gold: 'tigers-eye',
    };

    /** A new goal: "Net worth is at least $100,000 by" ten years from now, with
     *  any of `fields` over it. */
    function createGoal(fields = {}) {
        const goal = {
            id: newId('g'), name: 'New goal',
            metric: 'net-worth', op: 'gte', unit: 'amount', value: 100000, of: 'expenses',
            due: 'date', by: defaultBy(), age: null, color: GOAL_COLORS[0],
        };
        for (const key of Object.keys(goal)) {
            if (key !== 'id' && fields[key] !== undefined) goal[key] = fields[key];
        }
        return goal;
    }

    /** Who a goal's age deadline is for in `plan`: its first person. Null when it has none. */
    function goalPerson(plan) {
        return plan.nodes.find((n) => roleOf(n) === 'person') || null;
    }

    /** The month a goal is due in `plan` ('YYYY-MM'), or null when it has no
     *  deadline there. An age deadline is the month the plan's person turns
     *  that age, so it has none in a plan without a person whose age is set. */
    function goalDate(plan, goal) {
        if (goal.due === 'date') return goal.by || null;
        if (goal.due !== 'age') return null;
        const person = goalPerson(plan);
        if (!person || person.params.age == null || !person.params.planStart) return null;
        return ymAdd(person.params.planStart, Math.round((goal.age - person.params.age) * 12));
    }

    // ── Construction ───────────────────────────────────────────────────────

    function createPlan({ name = 'Untitled plan', start = ymNow(), years = 5 } = {}) {
        const now = new Date().toISOString();
        return {
            id: newId('p'),
            name,
            version: PLAN_VERSION,
            createdAt: now,
            updatedAt: now,
            settings: { start, years, inflation: 2.5 },
            view: { x: 0, y: 0, zoom: 1 },
            nodes: [],
            links: [],
        };
    }

    /** The icon a module wears: the one the user chose, else its preset's. */
    function iconOf(node) {
        return node.icon || Catalog.preset(node.type).icon;
    }

    function createNode(plan, presetId, x, y) {
        const p = Catalog.preset(presetId);
        if (!p) throw new Error(`unknown module type: ${presetId}`);
        const params = Catalog.defaultParams(p);
        // A new person starts with the plan, so placing one moves nothing.
        if (p.role === 'person') params.planStart = plan.settings.start;
        return { id: newId('n'), type: p.id, name: p.name, x: Math.round(x), y: Math.round(y), params };
    }

    // ── People ─────────────────────────────────────────────────────────────

    /** The plan starts when its earliest person's plan does. A plan with no
     *  person keeps the start it has. Call after any edit; returns true when
     *  the start moved. */
    function syncStart(plan) {
        let start = null;
        for (const n of plan.nodes) {
            const s = roleOf(n) === 'person' && n.params.planStart;
            if (s && (!start || ymDiff(s, start) > 0)) start = s;
        }
        if (!start || start === plan.settings.start) return false;
        plan.settings.start = start;
        return true;
    }

    /** The modules a person counts: the ones their links point at, and every
     *  module the money from those reaches along money links. */
    function personReach(plan, personId) {
        const next = new Map();
        for (const l of plan.links) {
            const list = next.get(l.from);
            if (list) list.push(l.to); else next.set(l.from, [l.to]);
        }
        const seen = new Set();
        const stack = [...(next.get(personId) || [])];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            for (const to of next.get(id) || []) if (!seen.has(to)) stack.push(to);
        }
        return seen;
    }

    /** A person's age in month `ym`, in whole years, from their age when
     *  their plan starts. Null when no age is set. */
    function ageAt(person, ym) {
        const { age, planStart } = person.params;
        if (age == null || !planStart) return null;
        return Math.floor(age + ymDiff(planStart, ym) / 12);
    }

    /** Whether a link from `fromId` to `toId` may be drawn, and why not. Two
     *  modules may be linked once per basis (a card's purchases, a loan's proceeds...),
     *  so a pair is full only when every basis that reaches the target is
     *  taken. With a `basis`, only that one is checked. */
    function canConnect(plan, fromId, toId, basis = null) {
        if (fromId === toId) return { ok: false, reason: 'self' };
        const from = plan.nodes.find((n) => n.id === fromId);
        const to = plan.nodes.find((n) => n.id === toId);
        if (!from || !to) return { ok: false, reason: 'missing' };
        const tr = roleOf(to);
        const bases = basesFor(from);
        if (!Catalog.LINK_TARGETS[roleOf(from)].includes(tr) || !bases.length) return { ok: false, reason: 'role' };
        const reaches = bases.filter((b) => portTargets(from, b).includes(tr));
        if (basis ? !reaches.includes(basis) : !reaches.length) return { ok: false, reason: 'basis' };
        // The bases this pair has free are always among the ones that reach.
        const free = basesBetween(plan, from, to);
        if (basis ? !free.includes(basis) : !free.length) return { ok: false, reason: 'duplicate' };
        return { ok: true };
    }

    function blankRule() {
        return { mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null,
            start: null, end: null, growth: 0 };
    }

    /** The rule a freshly drawn link starts with. Picked so the first link
     *  usually does what was meant without opening the editor: income's first
     *  link takes the rest, later ones take a slice of it, an account sends a
     *  fixed amount from its balance, a debt is paid what it asks, and a target
     *  with a natural price (Rent, a wedding) asks for that price. */
    function defaultRule(plan, from, to, basis = null) {
        const rule = startingRule(plan, from, to);
        if (basis) return rule.basis === basis ? preferPercent(rule, from) : ruleOnBasis(plan, from, to, basis);
        // The usual basis may already link this pair: take the next free one.
        const free = basesBetween(plan, from, to);
        return free.length && !free.includes(rule.basis) ? ruleOnBasis(plan, from, to, free[0]) : preferPercent(rule, from);
    }

    /** Whether a link claims all that is left: a rest link, or the 100% that
     *  a new link starts with in its place. */
    const takesRest = (l) => l.mode === 'rest' || (l.mode === 'percent' && Number(l.value) >= 100);

    /** A new link starts on % wherever that is on offer. A rule that would
     *  take the rest takes all (100%) instead, so the first link still gets
     *  everything and later ones carve their share out of it. */
    function preferPercent(rule, from) {
        if (rule.mode === 'rest' && modesFor(from, rule.basis).includes('percent')) {
            Object.assign(rule, { mode: 'percent', value: 100 });
        }
        return rule;
    }

    /** The rule for a link on a given basis. Only one link per source and
     *  basis may take the rest, so a later one takes a share instead. */
    function ruleOnBasis(plan, from, to, basis) {
        const rule = rawRuleOnBasis(plan, from, to, basis);
        const modes = modesFor(from, basis);
        const taken = plan.links.some((l) => l.from === from.id && l.basis === basis && takesRest(l));
        if (rule.mode === 'rest' && taken && modes.includes('percent')) Object.assign(rule, { mode: 'percent', value: 50 });
        return preferPercent(rule, from);
    }

    function rawRuleOnBasis(plan, from, to, basis) {
        const rule = Object.assign(blankRule(), { basis });
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id && l.basis === basis);
        switch (basis) {
            case 'charges':
                return Object.assign(rule, priceRule(plan, tp.inLink || { when: 'monthly', value: 100 }));
            case 'balance': {
                if (tp.role === 'debt') return Object.assign(rule, paymentRule(to));
                if (tp.inLink) return Object.assign(rule, priceRule(plan, tp.inLink));
                return Object.assign(rule, { mode: 'fixed', value: 500 });
            }
            case 'proceeds':
                return Object.assign(rule, { mode: 'rest', when: 'once' });
            default:
                if (tp.inLink && modesFor(from, basis).includes('fixed')) {
                    return Object.assign(rule, priceRule(plan, tp.inLink));
                }
                return existing.some(takesRest) ? Object.assign(rule, { mode: 'percent', value: 25 }) : rule;
        }
    }

    /** Paying a target with a usual price (a preset's `inLink`): that amount,
     *  on its timing. */
    function priceRule(plan, buy) {
        return { mode: 'fixed', value: buy.value, when: buy.when, month: buy.month || 1,
            date: buy.relDate != null ? ymAdd(plan.settings.start, buy.relDate) : null };
    }

    /** Paying a debt starts at what it asks each month: a loan's scheduled
     *  payment, else a round figure to edit. */
    function paymentRule(debt) {
        const ask = Math.ceil(loanPayment(debt.params) * 100) / 100;
        return { mode: 'fixed', value: ask > 0 ? ask : 500, when: 'monthly' };
    }

    function startingRule(plan, from, to) {
        const rule = blankRule();
        const fp = Catalog.preset(from.type);
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id);
        const hasRest = (basis) => existing.some((l) => l.basis === basis && takesRest(l));

        if (fp.role === 'person') return Object.assign(rule, { basis: 'person' });

        // A card pays for spending: a purchase, at that spending's usual price.
        if (fp.kind === 'card') {
            return Object.assign(rule, { basis: 'charges' }, priceRule(plan, tp.inLink || { when: 'monthly', value: 100 }));
        }

        if (tp.inLink) {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            if (RULES[fp.role][basis] && RULES[fp.role][basis].includes('fixed')) {
                return Object.assign(rule, { basis }, priceRule(plan, tp.inLink));
            }
        }

        // Paying a debt starts at what it asks each month.
        if (tp.role === 'debt' && fp.role !== 'debt') {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            return Object.assign(rule, { basis }, paymentRule(to));
        }
        // Pay into a 401(k) is usually a slice of it.
        if (tp.employerMatch && fp.role === 'source') {
            return Object.assign(rule, { mode: 'percent', value: 6 });
        }

        switch (fp.role) {
            case 'account':
                return Object.assign(rule, { basis: 'balance', mode: 'fixed', value: 500 });
            case 'debt':
                if (from.params.start && !existing.some((l) => l.basis === 'proceeds')) {
                    return Object.assign(rule, { basis: 'proceeds', mode: 'rest', when: 'once' });
                }
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 50 })
                    : rule;
            case 'modifier':
                // A budget group splits its money among its categories.
                if (fp.kind === 'group') {
                    return Object.assign(rule, { mode: 'percent', value: hasRest('inflow') ? 25 : 50 });
                }
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 10 })
                    : rule;
            default:
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 10 })
                    : rule;
        }
    }

    function createLink(plan, fromId, toId, basis = null) {
        const from = plan.nodes.find((n) => n.id === fromId);
        const to = plan.nodes.find((n) => n.id === toId);
        return { id: newId('l'), from: fromId, to: toId, ...defaultRule(plan, from, to, basis) };
    }

    /** Bring a link's rule back inside the space its source and target allow,
     *  after either or the rule changed. Keeps every field it can. */
    function fitRule(link, from) {
        const bases = basesFor(from);
        if (!bases.includes(link.basis)) link.basis = bases[0] || 'inflow';
        const modes = modesFor(from, link.basis);
        if (!modes.includes(link.mode)) link.mode = modes.includes('percent') ? 'percent' : modes[0];
        const timings = timingsFor(link.basis, link.mode);
        if (!timings.includes(link.when)) link.when = timings[0];
        return link;
    }

    /** Move a link onto another basis (money from the balance rather than
     *  from the earnings, say). The rule starts afresh for that basis, since
     *  its amounts mean something else there; the link's window and raise
     *  stay. Returns false when the basis is not open to this pair. */
    function changeBasis(plan, link, basis) {
        const from = nodeById(plan, link.from);
        const to = nodeById(plan, link.to);
        if (!from || !to || link.basis === basis || !basesBetween(plan, from, to, link.id).includes(basis)) return false;
        const { start, end, growth } = link;
        Object.assign(link, ruleOnBasis(plan, from, to, basis), { start, end, growth });
        fitRule(link, from);
        return true;
    }

    /** Move a link's receiving end: onto another module, or just to another dot
     *  of the one it already reaches. The rule stays where the new target takes
     *  it; otherwise the link moves to a basis that does. Returns { ok } or
     *  { ok: false, reason } with canConnect's reasons. */
    function reconnect(plan, link, toId, toSide = null) {
        if (toId !== link.to) {
            const check = canConnect(plan, link.from, toId);
            if (!check.ok) return check;
            const from = nodeById(plan, link.from);
            const to = nodeById(plan, toId);
            const keeps = canConnect(plan, link.from, toId, link.basis).ok;
            link.to = toId;
            if (!keeps) changeBasis(plan, link, basesBetween(plan, from, to)[0]);
            fitRule(link, from);
        }
        if (toSide) link.toSide = toSide; else delete link.toSide;
        return { ok: true };
    }

    // ── Validation ─────────────────────────────────────────────────────────
    // validatePlan is the gate in front of the file: the backend runs it on
    // every save and import, so nothing malformed is ever written. It rejects
    // structural problems (wrong types, unknown modules, dangling links) and
    // clamps numbers into their ranges, which is a fix rather than an error.
    // Returns a fresh, normalized copy; never mutates its input.

    class PlanError extends Error {}

    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = (msg) => { throw new PlanError(msg); };

    function cleanString(v, max, what) {
        if (typeof v !== 'string') fail(`${what} must be text`);
        // Control characters have no business in a name; strip rather than reject.
        // eslint-disable-next-line no-control-regex
        const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        return s.slice(0, max);
    }

    function cleanNumber(v, min, max, what) {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a number`);
        return Math.min(max, Math.max(min, v));
    }

    function cleanYm(v, what, optional) {
        if (v == null || v === '') {
            if (optional) return null;
            fail(`${what} is required`);
        }
        if (!ymParse(v)) fail(`${what} must be a month (YYYY-MM)`);
        return v;
    }

    function cleanId(v, what) {
        if (typeof v !== 'string' || !ID_RE.test(v)) fail(`${what} is not a valid id`);
        return v;
    }

    function cleanParams(p, raw) {
        const out = {};
        const fields = Catalog.ROLE_FIELDS[p.role];
        const base = Catalog.defaultParams(p);
        const src = isObj(raw) ? raw : {};
        for (const key of fields) {
            const spec = Catalog.FIELDS[key];
            const v = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : base[key];
            if (p.fixed && Object.prototype.hasOwnProperty.call(p.fixed, key)) {
                out[key] = p.fixed[key];
                continue;
            }
            switch (spec.type) {
                case 'money':
                case 'percent':
                case 'number':
                    if ((v == null || v === '') && spec.optional) { out[key] = null; break; }
                    out[key] = cleanNumber(v, spec.min, spec.max, key);
                    break;
                case 'choice':
                    if (!spec.options.some(([val]) => val === v)) fail(`${key} has an unknown value`);
                    out[key] = v;
                    break;
                case 'month':
                    out[key] = Math.round(cleanNumber(v == null ? 0 : v, 0, 12, key));
                    break;
                case 'yearmonth':
                    out[key] = cleanYm(v, key, true);
                    break;
                case 'account':
                    out[key] = v == null || v === '' ? null : cleanId(v, key);
                    break;
                default:
                    fail(`unknown field type for ${key}`);
            }
        }
        return out;
    }

    const MODES = ['percent', 'fixed', 'rest', 'above'];
    const BASES = ['inflow', 'balance', 'proceeds', 'charges', 'person'];
    const WHENS = ['monthly', 'yearly', 'once'];
    const SIDES = ['t', 'r', 'b', 'l'];

    function cleanLink(raw, nodesById, i) {
        if (!isObj(raw)) fail(`link ${i} is malformed`);
        const link = {
            id:     cleanId(raw.id, `link ${i}`),
            from:   cleanId(raw.from, `link ${i} source`),
            to:     cleanId(raw.to, `link ${i} target`),
            mode:   MODES.includes(raw.mode) ? raw.mode : fail(`link ${i} has an unknown mode`),
            value:  cleanNumber(raw.value ?? 0, 0, LIMITS.money, `link ${i} value`),
            basis:  BASES.includes(raw.basis) ? raw.basis : fail(`link ${i} has an unknown basis`),
            when:   WHENS.includes(raw.when) ? raw.when : fail(`link ${i} has an unknown timing`),
            month:  Math.round(cleanNumber(raw.month ?? 1, 1, 12, `link ${i} month`)),
            date:   cleanYm(raw.date, `link ${i} date`, true),
            start:  cleanYm(raw.start, `link ${i} start`, true),
            end:    cleanYm(raw.end, `link ${i} end`, true),
            growth: cleanNumber(raw.growth ?? 0, -100, 100, `link ${i} growth`),
        };
        // Which dot of each card the link is drawn from and to (top, right, bottom, left).
        // Optional: a link without them is drawn between the sides that face each other.
        if (SIDES.includes(raw.fromSide)) link.fromSide = raw.fromSide;
        if (SIDES.includes(raw.toSide)) link.toSide = raw.toSide;
        const from = nodesById.get(link.from);
        const to = nodesById.get(link.to);
        if (!from || !to) fail(`link ${i} points at a module that does not exist`);
        if (link.from === link.to) fail(`link ${i} links a module to itself`);
        if (!Catalog.LINK_TARGETS[roleOf(from)].includes(roleOf(to))) {
            fail(`link ${i} joins modules that cannot be linked`);
        }
        fitRule(link, from);
        if (!portTargets(from, link.basis).includes(roleOf(to))) {
            fail(`link ${i} sends ${link.basis} to a module that cannot take it`);
        }
        if (link.mode === 'percent') link.value = Math.min(link.value, 100);
        // Proceeds happen on the module's own date, not the link's.
        if (link.when === 'once' && link.basis !== 'proceeds' && !link.date) {
            fail(`link ${i} needs a date`);
        }
        return link;
    }

    /** A goal of a kind from before goals were rules, as the rule it meant.
     *  An FI or retirement goal compared all savings with a year of spending
     *  and loan payments over its withdrawal rate (4% is 25 times). */
    function ruleOfKind(raw, i) {
        const by = raw.by ?? null;
        const dated = { due: 'date', by };
        const fi = { metric: 'savings', op: 'gte', unit: 'times', value: 100 / (Number(raw.rate) || 4), of: 'expenses' };
        switch (raw.kind) {
            case 'net-worth': return { metric: 'net-worth', op: 'gte', unit: 'amount', value: raw.target ?? 1000000, ...dated };
            case 'savings':   return { metric: 'savings', op: 'gte', unit: 'amount', value: raw.target ?? 10000, ...dated };
            case 'debt-free': return { metric: 'debt', op: 'lte', unit: 'amount', value: 0, ...dated };
            case 'fi':        return { ...fi, ...dated };
            case 'retire':    return { ...fi, due: 'age', by: null, age: raw.age ?? 65 };
            default: return fail(`goal ${i} has an unknown kind`);
        }
    }

    const oneOf = (list, v, what) => (list.includes(v) ? v : fail(`${what} has an unknown value`));

    /** A goal, normalized. A goal it cannot read (an unknown measure, saved by
     *  a newer build) is rejected rather than dropped: dropping it would lose
     *  it on the next save. Fields a rule does not have (a module a goal once
     *  named, when goals belonged to one plan) are left behind. */
    function cleanGoal(raw, i) {
        if (!isObj(raw)) fail(`goal ${i} is malformed`);
        const src = raw.metric === undefined && raw.kind !== undefined ? { ...raw, ...ruleOfKind(raw, i) } : raw;
        const what = `goal ${i}`;
        const unit = oneOf(GOAL_UNITS, src.unit ?? 'amount', `${what} target`);
        // A goal saved with no deadline (from when one could have none) is given one.
        const due = src.due == null || src.due === 'none' ? 'date' : oneOf(GOAL_DUES, src.due, `${what} deadline`);
        const goal = {
            id: cleanId(raw.id, what),
            name: cleanString(raw.name ?? '', LIMITS.name, `${what} name`) || 'Goal',
            metric: oneOf(GOAL_METRICS, src.metric, `${what} measure`),
            op: oneOf(GOAL_OPS, src.op ?? 'gte', `${what} comparison`),
            unit,
            value: cleanNumber(src.value ?? 0, 0, GOAL_VALUE[unit], `${what} target`),
            of: oneOf(GOAL_METRICS, src.of ?? 'expenses', `${what} measure`),
            due,
            by: cleanYm(src.by, `${what} date`, true),
            age: src.age == null ? null : cleanNumber(src.age, GOAL_AGE.min, GOAL_AGE.max, `${what} age`),
            // Only for show, so a colour this build does not know is not worth refusing the goal over.
            color: GOAL_COLORS.includes(src.color) ? src.color : OLD_GOAL_COLORS[src.color] || GOAL_COLORS[0],
        };
        if (due === 'date' && !goal.by) goal.by = defaultBy();
        if (due === 'age' && goal.age == null) goal.age = 65;
        return goal;
    }

    /** The shared goal list, normalized. Returns a fresh copy; throws a
     *  PlanError on one it cannot trust (see cleanGoal). */
    function validateGoals(raw) {
        if (raw == null) return [];
        if (!Array.isArray(raw)) fail('goals are malformed');
        if (raw.length > LIMITS.goals) fail(`at most ${LIMITS.goals} goals`);
        const seen = new Set();
        return raw.map((g, i) => {
            const goal = cleanGoal(g, i);
            if (seen.has(goal.id)) fail(`goal id ${goal.id} is used twice`);
            seen.add(goal.id);
            return goal;
        });
    }

    /** The goals a plan saved before goals were shared held, normalized; none
     *  for a plan without. Read from the plan as saved, before validatePlan
     *  (which keeps none). */
    function legacyGoals(rawPlan) {
        return isObj(rawPlan) && Array.isArray(rawPlan.goals) ? validateGoals(rawPlan.goals.slice(0, LIMITS.goals)) : [];
    }

    /** `goals` with every goal of `incoming` that it does not already hold
     *  (the same kind, name and figures) added, up to the limit. A newcomer
     *  whose id is taken gets a new one. Returns a new list. */
    function mergeGoals(goals, incoming) {
        const sameAs = (g) => JSON.stringify({ ...g, id: null });
        const held = new Set(goals.map(sameAs));
        const ids = new Set(goals.map((g) => g.id));
        const out = goals.slice();
        for (const g of incoming) {
            if (out.length >= LIMITS.goals) break;
            if (held.has(sameAs(g))) continue;
            const goal = ids.has(g.id) ? { ...g, id: newId('g') } : { ...g };
            held.add(sameAs(goal));
            ids.add(goal.id);
            out.push(goal);
        }
        return out;
    }

    /** The Match module is gone: a 401(k) has an Employer match setting now.
     *  A saved Match folds into the pre-tax account it fed, which becomes a
     *  401(k) with the Match's rate and yearly limit. The pay the Match was
     *  told about becomes pay into that 401(k), unless the pay already goes
     *  there. A Match that fed no pre-tax account is dropped. Returns new
     *  node and link lists; `raw` is left as it was. */
    function foldMatches(raw) {
        const isMatch = (n) => isObj(n) && n.type === 'employer-match';
        if (!raw.nodes.some(isMatch)) return { nodes: raw.nodes, links: raw.links };
        const byId = new Map(raw.nodes.filter(isObj).map((n) => [n.id, n]));
        // Saved types may be retired ones, so read them as their survivors.
        const presetOf = (n) => (n && Catalog.preset((RETIRED_TYPES[n.type] || n).type)) || {};
        const takesPretax = (n) => !!presetOf(n).pretax;
        const links = raw.links.filter(isObj);
        const intoK = new Map();   // a 401(k) id -> the node it is saved as
        const moved = new Map();   // a pay link -> the 401(k) id it now feeds
        const dropped = new Set();
        for (const m of raw.nodes.filter(isMatch)) {
            const out = links.find((l) => l.from === m.id && takesPretax(byId.get(l.to)));
            const k = out && byId.get(out.to);
            if (k && !intoK.has(k.id)) {
                const params = isObj(m.params) ? m.params : {};
                intoK.set(k.id, { ...k, type: '401k',
                    params: { ...(isObj(k.params) ? k.params : {}), match: params.rate ?? 0, matchLimit: params.capYearly ?? null } });
                for (const pay of links.filter((l) => l.to === m.id && presetOf(byId.get(l.from)).role === 'source')) {
                    const paid = links.some((l) => l.from === pay.from && l.to === k.id && l.basis === pay.basis);
                    if (!paid) moved.set(pay, k.id);
                }
            }
            dropped.add(m.id);
        }
        return {
            nodes: raw.nodes.filter((n) => !isMatch(n)).map((n) => (isObj(n) && intoK.get(n.id)) || n),
            links: raw.links.flatMap((l) => {
                if (moved.has(l)) return [{ ...l, to: moved.get(l) }];
                return isObj(l) && (dropped.has(l.from) || dropped.has(l.to)) ? [] : [l];
            }),
        };
    }

    function validatePlan(input) {
        if (!isObj(input)) fail('plan is malformed');
        if (!Array.isArray(input.nodes)) fail('plan modules are missing');
        if (!Array.isArray(input.links)) fail('plan links are missing');
        if (input.nodes.length > LIMITS.nodes) fail(`a plan holds at most ${LIMITS.nodes} modules`);
        if (input.links.length > LIMITS.links) fail(`a plan holds at most ${LIMITS.links} links`);
        const raw = { ...input, ...foldMatches(input) };
        const settings = isObj(raw.settings) ? raw.settings : fail('plan settings are missing');
        const view = isObj(raw.view) ? raw.view : { x: 0, y: 0, zoom: 1 };
        // Goals are shared now, not kept in a plan: the ones an older plan held
        // are read out of it (legacyGoals) before this drops them.

        const plan = {
            id: cleanId(raw.id, 'plan'),
            name: cleanString(raw.name ?? '', LIMITS.name, 'plan name') || 'Untitled plan',
            version: PLAN_VERSION,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : new Date().toISOString(),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : new Date().toISOString(),
            settings: {
                start: cleanYm(settings.start, 'plan start', false),
                years: Math.round(cleanNumber(settings.years, 1, LIMITS.years, 'plan length')),
                inflation: cleanNumber(settings.inflation ?? 0, -20, 50, 'inflation'),
            },
            view: {
                x: cleanNumber(Number(view.x) || 0, -1e6, 1e6, 'view x'),
                y: cleanNumber(Number(view.y) || 0, -1e6, 1e6, 'view y'),
                zoom: cleanNumber(Number(view.zoom) || 1, 0.2, 3, 'view zoom'),
            },
            nodes: [],
            links: [],
        };

        const nodesById = new Map();
        const removedIds = new Set();
        raw.nodes.forEach((n, i) => {
            if (!isObj(n)) fail(`module ${i} is malformed`);
            if (REMOVED_TYPES.has(n.type)) { removedIds.add(n.id); return; }
            const retired = RETIRED_TYPES[n.type];
            const p = Catalog.preset(retired ? retired.type : n.type);
            if (!p) fail(`module ${i} has an unknown type`);
            const node = {
                id: cleanId(n.id, `module ${i}`),
                type: p.id,
                name: cleanString(n.name ?? p.name, LIMITS.name, `module ${i} name`) || p.name,
                x: Math.round(cleanNumber(n.x, -1e6, 1e6, `module ${i} x`)),
                y: Math.round(cleanNumber(n.y, -1e6, 1e6, `module ${i} y`)),
                params: cleanParams(p, n.params),
            };
            // An icon the category does not offer is dropped, not rejected: the
            // module wears its preset's icon instead.
            const icon = n.icon ?? (retired && retired.icon);
            if (typeof icon === 'string' && icon !== p.icon && Catalog.iconChoices(p).includes(icon)) node.icon = icon;
            if (nodesById.has(node.id)) fail(`module id ${node.id} is used twice`);
            nodesById.set(node.id, node);
            plan.nodes.push(node);
        });
        syncStart(plan);

        // Cash back lands in an account that exists, else it credits the card.
        for (const n of plan.nodes) {
            const to = n.params.cashBackTo && nodesById.get(n.params.cashBackTo);
            if (n.params.cashBackTo && !(to && roleOf(to) === 'account')) n.params.cashBackTo = null;
        }

        // Cash back once travelled along links from the card, and a card could
        // send what it overpaid onward. Both are gone: a card's cash back is a
        // setting now (the account the old links favoured, if any), and the
        // overpayment stays with whoever paid.
        const isCard = (id) => {
            const n = nodesById.get(id);
            return !!n && Catalog.preset(n.type).kind === 'card';
        };
        const retiredCardLink = (l) => isObj(l) && (l.basis === 'cashback' || (l.basis === 'inflow' && isCard(l.from)));
        const backLinks = raw.links.filter((l) => isObj(l) && l.basis === 'cashback' && isCard(l.from));
        for (const card of plan.nodes.filter((n) => n.params.cashBackTo == null && isCard(n.id))) {
            const mine = backLinks.filter((l) => l.from === card.id);
            const shared = mine.filter((l) => l.mode === 'percent').reduce((sum, l) => sum + (Number(l.value) || 0), 0);
            let best = null;
            let bestShare = 0;
            for (const l of mine) {
                const share = l.mode === 'rest' ? Math.max(0, 100 - shared) : l.mode === 'percent' ? Number(l.value) || 0 : 0;
                if (share > bestShare) { best = l; bestShare = share; }
            }
            const to = best && nodesById.get(best.to);
            if (to && roleOf(to) === 'account') card.params.cashBackTo = to.id;
        }

        // Spending once routed onward from any module (a budget group, now a
        // modifier, was the exception), and a card could charge a budget group:
        // older plans lose those links and the money stays where it was.
        const sinkLink = (l) => {
            const from = isObj(l) && nodesById.get(l.from);
            const to = isObj(l) && nodesById.get(l.to);
            if (!from || !to) return false;
            if (roleOf(from) === 'expense') return true;
            return l.basis === 'charges' && Catalog.preset(to.type).kind === 'group';
        };
        const touchesRemoved = (l) => isObj(l) && (removedIds.has(l.from) || removedIds.has(l.to));

        // An account sends only from its balance, and a rule no longer asks for
        // "the payment due". A saved fixed deposit link becomes the same fixed
        // amount from the balance (unless the pair has one already); other
        // deposit and earnings links have no equivalent and are dropped. A due
        // link becomes the fixed payment it was making: a loan's scheduled
        // payment, or a card's balance plus its monthly purchases.
        const settleRule = (l) => {
            const from = nodesById.get(l.from);
            const to = nodesById.get(l.to);
            if (!from || !to) return l;
            let out = l;
            if (roleOf(from) === 'account' && l.basis !== 'balance') {
                const twin = raw.links.some((o) => isObj(o) && o !== l && o.from === l.from && o.to === l.to && o.basis === 'balance');
                if (l.basis !== 'inflow' || l.mode !== 'fixed' || twin) return null;
                out = { ...l, basis: 'balance' };
            }
            if (out.mode === 'due') {
                const payment = Catalog.preset(to.type).kind === 'card'
                    ? (to.params.balance || 0) + raw.links
                        .filter((o) => isObj(o) && o.from === to.id && o.basis === 'charges' && o.mode === 'fixed' && o.when === 'monthly')
                        .reduce((sum, o) => sum + (Number(o.value) || 0), 0)
                    : loanPayment(to.params);
                out = { ...out, mode: 'fixed', value: payment, when: 'monthly' };
            }
            return out;
        };
        const seenLinks = new Set();
        const seenPairs = new Set();
        raw.links.filter((l) => !sinkLink(l) && !retiredCardLink(l) && !touchesRemoved(l))
            .map((l) => (isObj(l) ? settleRule(l) : l)).filter(Boolean).forEach((l, i) => {
            const link = cleanLink(l, nodesById, i);
            if (seenLinks.has(link.id)) fail(`link id ${link.id} is used twice`);
            const pair = `${link.from}>${link.to}>${link.basis}`;
            if (seenPairs.has(pair)) fail(`link ${i} duplicates another link`);
            seenLinks.add(link.id);
            seenPairs.add(pair);
            plan.links.push(link);
        });

        // At most one rest link per source and basis: two "rests" cannot both
        // take everything that is left.
        const rests = new Set();
        for (const l of plan.links) {
            if (l.mode !== 'rest') continue;
            const key = `${l.from}:${l.basis}`;
            if (rests.has(key)) l.mode = 'percent';
            rests.add(key);
        }
        return plan;
    }

    /** A deep copy with fresh ids throughout: for imports and duplicates, so a
     *  copy can never collide with the plan it came from. */
    function cloneWithNewIds(plan, name) {
        const copy = JSON.parse(JSON.stringify(plan));
        const map = new Map();
        copy.id = newId('p');
        if (name) copy.name = name;
        copy.createdAt = copy.updatedAt = new Date().toISOString();
        for (const n of copy.nodes) {
            const id = newId('n');
            map.set(n.id, id);
            n.id = id;
        }
        for (const n of copy.nodes) {
            if (n.params && n.params.cashBackTo) n.params.cashBackTo = map.get(n.params.cashBackTo) || null;
        }
        for (const l of copy.links) {
            l.id = newId('l');
            l.from = map.get(l.from);
            l.to = map.get(l.to);
        }
        delete copy.goals;
        return copy;
    }

    return {
        PLAN_VERSION, LIMITS, GEOM, MONTHS, RULES, PlanError, REMOVED_TYPES, reconnect,
        ymParse, ymFormat, ymNow, ymAdd, ymDiff, ymLabel,
        newId, roleOf, basesFor, modesFor, timingsFor, portTargets, targetRoles, basesBetween, changeBasis, loanPayment, isPretax,
        createPlan, createNode, iconOf, syncStart, personReach, ageAt, RETIRED_TYPES, canConnect, createLink, fitRule,
        GOAL_METRICS, GOAL_OPS, GOAL_UNITS, GOAL_DUES, GOAL_VALUE, GOAL_AGE, GOAL_COLORS, createGoal, goalPerson, goalDate,
        validateGoals, legacyGoals, mergeGoals, validatePlan, cloneWithNewIds,
    };
}));
