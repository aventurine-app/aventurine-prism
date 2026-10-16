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
//     nodes:    [{ id, type, name, x, y, params, dock? }],
//     links:    [{ id, from, to, mode, value, basis, when, month, date,
//                  start, end, growth }] }
//
// `type` is a preset id from catalog.js, which fixes the node's role.
//
// DOCKS. A loan secured by something (a mortgage on a home, a car loan on a
// vehicle) is a debt node with `dock` set to that asset's id. It is drawn
// snapped under the asset, shares its outline, and moves with it: its own x
// and y are derived from the asset by relayout(), never set by hand. Nothing
// else about it changes: it is still a debt, payments still reach it by links,
// and the asset's equity is its value minus what its docked loans owe. When
// the asset is sold, its docked loans are paid off first from the sale.
//
// LINK RULES. Every link answers one question: how much of the money at its
// source moves to its target. The answer is a mode and a basis:
//
//   mode   percent  value% of the basis
//          fixed    value (a currency amount) each time the link fires
//          rest     whatever is left of the basis after the other links
//          above    accounts only: the part of the balance over `value`
//          due      into a debt only: the payment it asks for this month. A
//                   loan's scheduled payment (from its term), or a card's
//                   whole balance (paid in full)
//
//   basis  inflow    money arriving at the source. For income that is the
//                    paycheck; for spending, the spending; for a debt, what is
//                    paid beyond the payoff; for an account, its deposits.
//          earnings  accounts only: this month's interest or returns
//          balance   accounts only: the balance itself (withdrawals)
//          proceeds  debts with a start date only: the amount borrowed
//          sale      assets with a sold date only: what the sale leaves after
//                    selling costs and the loans docked under it
//          rent      rental assets only: the month's rent
//          charges   credit cards only: a purchase the card pays for, charged
//                    to its balance (fixed amounts, sent to spending)
//          cashback  credit cards only: the cash back earned on purchases
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
    // Types folded into another preset; saved plans that hold one open as its successor.
    // 'new-car' was spending; a bought car is now a Vehicle asset with a Bought
    // date, but an old plan keeps its links valid as a one-off purchase.
    const RETIRED_TYPES = { 'side-hustle': 'freelance', 'new-car': 'big-purchase' };

    // Bounds. A plan larger than these is not a plan anyone draws by hand; the
    // limits exist so a corrupt or hostile document cannot make the backend
    // write, or the engine walk, something unbounded.
    // Card geometry shared with canvas.js and canvas.css (change all together).
    const GEOM = { NODE_W: 208, NODE_H: 112, DOCK_H: 72, DOCK_GAP: 0 };
    const MAX_DOCKS = 3;

    const LIMITS = {
        nodes:    400,
        links:    1200,
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
        source:   { inflow: ['due', 'percent', 'fixed', 'rest'] },
        expense:  { inflow: ['percent', 'fixed', 'rest'] },
        modifier: { inflow: ['due', 'percent', 'fixed', 'rest'] },
        debt:     {
            inflow:   ['percent', 'fixed', 'rest'],
            proceeds: ['percent', 'rest'],
            charges:  ['fixed'],
            cashback: ['percent', 'rest'],
        },
        account:  {
            inflow:   ['percent', 'fixed', 'rest'],
            earnings: ['percent', 'rest'],
            balance:  ['due', 'percent', 'fixed', 'rest', 'above'],
        },
        asset:    {
            sale:     ['percent', 'rest'],
            rent:     ['percent', 'fixed', 'rest'],
        },
    };

    /** The `when` values a rule offers. The first is the default. */
    function timingsFor(basis, mode) {
        if (basis === 'proceeds' || basis === 'sale') return ['once'];
        if (basis === 'rent' || mode === 'due') return ['monthly'];
        if (basis === 'cashback') return ['monthly'];
        if (basis === 'charges') return ['monthly', 'yearly', 'once'];
        if (basis === 'inflow') return mode === 'fixed' ? ['monthly', 'yearly', 'once'] : ['monthly'];
        if (basis === 'earnings') return ['monthly', 'yearly'];
        if (mode === 'above') return ['monthly', 'yearly'];
        return ['monthly', 'yearly', 'once'];
    }

    /** Bases a node offers to its outgoing links. A debt only borrows (and so
     *  only has proceeds to send) when it starts inside the plan, and only a
     *  credit card has purchases and cash back. An asset sends nothing until it
     *  has a sold date, and only a rental collects rent. */
    function basesFor(node) {
        const p = Catalog.preset(node.type);
        if (!p) return [];
        const bases = Object.keys(RULES[p.role]);
        if (p.role === 'asset') {
            return bases.filter((b) => (b !== 'sale' || node.params.sold)
                && (b !== 'rent' || Catalog.fieldsFor(p).includes('rent')));
        }
        if (p.role !== 'debt') return bases;
        return bases.filter((b) => (b !== 'proceeds' || node.params.start)
            && ((b !== 'charges' && b !== 'cashback') || p.kind === 'card'));
    }

    /** The modes a link on `basis` offers. 'due' only reaches a debt, so a
     *  known target that is not one drops it. */
    function modesFor(node, basis, to = null) {
        const p = Catalog.preset(node.type);
        const modes = (p && RULES[p.role][basis]) || [];
        return !to || roleOf(to) === 'debt' ? modes : modes.filter((m) => m !== 'due');
    }

    /** Whether income sent along `link` is a pre-tax contribution: it leaves
     *  an income module for a pre-tax account (401(k), HSA, Traditional IRA),
     *  or for an employer match that feeds one. */
    function isPretax(plan, link) {
        const from = nodeById(plan, link.from);
        const to = nodeById(plan, link.to);
        if (roleOf(from) !== 'source' || !to) return false;
        const tp = Catalog.preset(to.type);
        if (tp.pretax) return true;
        if (tp.kind !== 'match') return false;
        return plan.links.some((l) => l.from === to.id
            && (Catalog.preset((nodeById(plan, l.to) || {}).type) || {}).pretax);
    }

    /** A loan's monthly payment: the level payment that clears `balance` over
     *  its years left at its APR. Without a term it is the minimum payment the
     *  plan was saved with, or nothing. A card has no schedule (see 'due'). */
    function loanPayment(params) {
        const principal = params.balance || 0;
        const n = params.term ? Math.max(1, Math.round(params.term * 12)) : 0;
        if (!n) return params.minPayment || 0;
        const r = (params.rate || 0) / 1200;
        return r > 0 ? principal * r / (1 - Math.pow(1 + r, -n)) : principal / n;
    }

    function roleOf(node) {
        const p = node && Catalog.preset(node.type);
        return p ? p.role : null;
    }

    /** The roles a link on `basis` may run into. A card's purchases pay for
     *  spending and its cash back lands in an account or against a debt; every
     *  other basis goes wherever the source's role may link. */
    function portTargets(node, basis) {
        if (basis === 'charges') return ['expense'];
        if (basis === 'cashback') return ['account', 'debt'];
        return Catalog.LINK_TARGETS[roleOf(node)] || [];
    }

    // ── Docks ──────────────────────────────────────────────────────────────

    const nodeById = (plan, id) => plan.nodes.find((n) => n.id === id);

    /** The loans docked under an asset, top to bottom. */
    function docksOf(plan, assetId) {
        return plan.nodes.filter((n) => n.dock === assetId);
    }

    /** The debt presets an asset can hold as a secured loan (none for most). */
    function loanOptions(node) {
        const p = node && Catalog.preset(node.type);
        return (p && p.loans) || [];
    }

    /** Whether `debt` may be docked under `asset`, and why not. */
    function canDock(plan, debtId, assetId) {
        const debt = nodeById(plan, debtId);
        const asset = nodeById(plan, assetId);
        if (!debt || !asset || debtId === assetId) return { ok: false, reason: 'missing' };
        if (!loanOptions(asset).length || asset.dock) return { ok: false, reason: 'asset' };
        if (!loanOptions(asset).includes(debt.type)) return { ok: false, reason: 'kind' };
        if (debt.dock === assetId) return { ok: false, reason: 'docked' };
        if (docksOf(plan, assetId).length >= MAX_DOCKS) return { ok: false, reason: 'full' };
        return { ok: true };
    }

    /** Put every docked loan directly under its asset, in plan order. Run after
     *  any change, so a loan's own x and y can never drift from its asset's. */
    function relayout(plan) {
        const slot = new Map();
        for (const n of plan.nodes) {
            if (!n.dock) continue;
            const asset = nodeById(plan, n.dock);
            if (!asset) { delete n.dock; continue; }
            const i = slot.get(asset.id) || 0;
            slot.set(asset.id, i + 1);
            n.x = asset.x;
            n.y = asset.y + GEOM.NODE_H + i * GEOM.DOCK_H;
        }
        return plan;
    }

    /** A new loan, docked under `assetId`. Returns the node, or null. Under an
     *  asset bought inside the plan it is taken out the month of the purchase,
     *  so its proceeds fund it (see engine.js, buying an asset). */
    function addLoan(plan, assetId, presetId) {
        const asset = nodeById(plan, assetId);
        if (!asset || !loanOptions(asset).includes(presetId)) return null;
        if (docksOf(plan, assetId).length >= MAX_DOCKS) return null;
        const node = createNode(plan, presetId, asset.x, asset.y);
        if (asset.params.bought) node.params.start = asset.params.bought;
        node.dock = assetId;
        plan.nodes.push(node);
        relayout(plan);
        return node;
    }

    /** Dock an existing loan under an asset. */
    function dockLoan(plan, debtId, assetId) {
        if (!canDock(plan, debtId, assetId).ok) return false;
        nodeById(plan, debtId).dock = assetId;
        relayout(plan);
        return true;
    }

    /** Pop a loan out of its dock, to stand beside the asset it secured. */
    function undockLoan(plan, debtId) {
        const node = nodeById(plan, debtId);
        const asset = node && node.dock ? nodeById(plan, node.dock) : null;
        if (!node) return;
        delete node.dock;
        if (asset) placeBeside(node, asset);
        relayout(plan);
    }

    /** Stand a loan to the right of the asset it was docked under. */
    function placeBeside(node, asset) {
        node.x = asset.x + GEOM.NODE_W + 56;
        node.y = asset.y;
    }

    /** What an asset is worth net of the loans docked under it. */
    function equityOf(valueAt, loanBalancesAt) {
        return valueAt - loanBalancesAt.reduce((a, b) => a + b, 0);
    }

    /** A module's output ports, in display order: one per thing it can send. */
    function portsFor(node) {
        return basesFor(node).map((basis) => ({ basis, targets: portTargets(node, basis) }));
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

    function createNode(plan, presetId, x, y) {
        const p = Catalog.preset(presetId);
        if (!p) throw new Error(`unknown module type: ${presetId}`);
        return { id: newId('n'), type: p.id, name: p.name, x: Math.round(x), y: Math.round(y), params: Catalog.defaultParams(p) };
    }

    /** Whether a link from `fromId` to `toId` may be drawn, and why not.
     *  `basis` is the output port it leaves from; without one the link takes
     *  the basis a new link would start on. Two modules may be linked once
     *  per basis. */
    function canConnect(plan, fromId, toId, basis = null) {
        if (fromId === toId) return { ok: false, reason: 'self' };
        const from = plan.nodes.find((n) => n.id === fromId);
        const to = plan.nodes.find((n) => n.id === toId);
        if (!from || !to) return { ok: false, reason: 'missing' };
        const fr = roleOf(from);
        const tr = roleOf(to);
        if (!Catalog.LINK_TARGETS[fr].includes(tr)) return { ok: false, reason: 'role' };
        const onBasis = basis || defaultRule(plan, from, to).basis;
        if (!basesFor(from).includes(onBasis) || !portTargets(from, onBasis).includes(tr)) {
            return { ok: false, reason: 'basis' };
        }
        if (plan.links.some((l) => l.from === fromId && l.to === toId && l.basis === onBasis)) {
            return { ok: false, reason: 'duplicate' };
        }
        return { ok: true };
    }

    function blankRule() {
        return { mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null,
            start: null, end: null, growth: 0 };
    }

    /** The rule a freshly drawn link starts with. Picked so the first link
     *  usually does what was meant without opening the editor: income's first
     *  link takes the rest, later ones take a slice of it, an account feeding
     *  another account sends part of its earnings, and a target with a natural
     *  price (Rent, a wedding) asks for that price. */
    function defaultRule(plan, from, to, basis = null) {
        const rule = startingRule(plan, from, to);
        return !basis || rule.basis === basis ? rule : ruleOnBasis(plan, from, to, basis);
    }

    /** The rule for a link drawn from a specific output port. */
    function ruleOnBasis(plan, from, to, basis) {
        const rule = Object.assign(blankRule(), { basis });
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id && l.basis === basis);
        switch (basis) {
            case 'earnings':
                return Object.assign(rule, { mode: 'percent', value: 50 });
            case 'balance': {
                if (tp.role === 'asset') return Object.assign(rule, purchaseRule(plan, to));
                if (tp.role === 'debt') return Object.assign(rule, { mode: 'due' });
                if (tp.inLink) return Object.assign(rule, priceRule(plan, tp.inLink));
                return Object.assign(rule, { mode: 'fixed', value: 500 });
            }
            case 'proceeds':
            case 'sale':
                return Object.assign(rule, { mode: 'rest', when: 'once' });
            case 'cashback':
                return rule;
            default:
                if (tp.inLink && modesFor(from, basis, to).includes('fixed')) {
                    return Object.assign(rule, priceRule(plan, tp.inLink));
                }
                return existing.some((l) => l.mode === 'rest') ? Object.assign(rule, { mode: 'percent', value: 25 }) : rule;
        }
    }

    /** Paying a target with a usual price (a preset's `inLink`): that amount,
     *  on its timing. */
    function priceRule(plan, buy) {
        return { mode: 'fixed', value: buy.value, when: buy.when, month: buy.month || 1,
            date: buy.relDate != null ? ymAdd(plan.settings.start, buy.relDate) : null };
    }

    /** Paying for an asset: its price, once, the month it is bought (or the
     *  plan's first month when it has no date). */
    function purchaseRule(plan, asset) {
        return { mode: 'fixed', value: Number(asset.params.value) || 0, when: 'once',
            date: asset.params.bought || plan.settings.start };
    }

    function startingRule(plan, from, to) {
        const rule = blankRule();
        const fp = Catalog.preset(from.type);
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id);
        const hasRest = (basis) => existing.some((l) => l.basis === basis && l.mode === 'rest');

        // A card pays for spending (a purchase, at that spending's usual
        // price) and sends its cash back elsewhere.
        if (fp.kind === 'card') {
            if (tp.role === 'expense') {
                const buy = tp.inLink || { when: 'monthly', value: 100 };
                Object.assign(rule, { basis: 'charges', mode: 'fixed', value: buy.value, when: buy.when });
                if (buy.month) rule.month = buy.month;
                if (buy.relDate != null) rule.date = ymAdd(plan.settings.start, buy.relDate);
                return rule;
            }
            return Object.assign(rule, { basis: 'cashback', mode: 'rest' });
        }

        if (tp.inLink) {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            if (RULES[fp.role][basis] && RULES[fp.role][basis].includes('fixed')) {
                return Object.assign(rule, { basis }, priceRule(plan, tp.inLink));
            }
        }

        // An asset sends its sale proceeds once sold, else its rent.
        if (fp.role === 'asset') {
            const bases = basesFor(from);
            if (bases.includes('sale') && !existing.some((l) => l.basis === 'sale')) {
                return Object.assign(rule, { basis: 'sale', mode: 'rest', when: 'once' });
            }
            return Object.assign(rule, { basis: bases.includes('rent') ? 'rent' : bases[0] || 'sale',
                mode: hasRest('rent') ? 'percent' : 'rest', value: hasRest('rent') ? 25 : 0 });
        }

        // Buying an asset: income or an account pays its price on the day.
        // A loan's proceeds take the debt branch below.
        if (tp.role === 'asset' && fp.role !== 'debt') {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            if (RULES[fp.role][basis] && RULES[fp.role][basis].includes('fixed')) {
                return Object.assign(rule, { basis }, purchaseRule(plan, to));
            }
        }

        // Paying a debt pays what it asks for: a loan's scheduled payment, a
        // card's balance in full. Either can be changed to a fixed amount.
        if (tp.role === 'debt') {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            if (RULES[fp.role][basis] && RULES[fp.role][basis].includes('due')) {
                return Object.assign(rule, { basis, mode: 'due' });
            }
        }
        // A workplace contribution is usually a slice of pay.
        if (tp.kind === 'match' && fp.role === 'source') {
            return Object.assign(rule, { mode: 'percent', value: 6 });
        }

        switch (fp.role) {
            case 'account': {
                const rate = Number(from.params.rate) || 0;
                if (tp.role === 'account' && rate > 0) {
                    return Object.assign(rule, { basis: 'earnings', mode: 'percent', value: 50 });
                }
                if (tp.role === 'expense' || tp.role === 'debt') {
                    return Object.assign(rule, { basis: 'balance', mode: 'fixed', value: 500 });
                }
                if (!hasRest('inflow') && existing.length === 0) {
                    return Object.assign(rule, { basis: 'inflow', mode: 'rest' });
                }
                return Object.assign(rule, { basis: 'inflow', mode: 'percent', value: 25 });
            }
            case 'debt':
                if (from.params.start && !existing.some((l) => l.basis === 'proceeds')) {
                    return Object.assign(rule, { basis: 'proceeds', mode: 'rest', when: 'once' });
                }
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 50 })
                    : rule;
            case 'expense':
                // Routing spending onward is usually partial: "pay some of
                // this with the card".
                return hasRest('inflow') ? Object.assign(rule, { mode: 'percent', value: 25 })
                    : Object.assign(rule, { mode: 'percent', value: 50 });
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
    function fitRule(link, from, to = null) {
        const bases = basesFor(from);
        if (!bases.includes(link.basis)) link.basis = bases[0] || 'inflow';
        const modes = modesFor(from, link.basis, to);
        if (!modes.includes(link.mode)) link.mode = modes.includes('percent') ? 'percent' : modes[0];
        const timings = timingsFor(link.basis, link.mode);
        if (!timings.includes(link.when)) link.when = timings[0];
        return link;
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
        let src = isObj(raw) ? raw : {};
        // Property was once an account, its value stored as `balance`.
        if (p.role === 'asset' && src.value == null && typeof src.balance === 'number') {
            src = { ...src, value: src.balance };
        }
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
                default:
                    fail(`unknown field type for ${key}`);
            }
        }
        return out;
    }

    const MODES = ['percent', 'fixed', 'rest', 'above', 'due'];
    const BASES = ['inflow', 'earnings', 'balance', 'proceeds', 'charges', 'cashback', 'sale', 'rent'];
    const WHENS = ['monthly', 'yearly', 'once'];

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
        const from = nodesById.get(link.from);
        const to = nodesById.get(link.to);
        if (!from || !to) fail(`link ${i} points at a module that does not exist`);
        if (link.from === link.to) fail(`link ${i} links a module to itself`);
        if (!Catalog.LINK_TARGETS[roleOf(from)].includes(roleOf(to))) {
            fail(`link ${i} joins modules that cannot be linked`);
        }
        fitRule(link, from, to);
        if (!portTargets(from, link.basis).includes(roleOf(to))) {
            fail(`link ${i} sends ${link.basis} to a module that cannot take it`);
        }
        if (link.mode === 'percent') link.value = Math.min(link.value, 100);
        // Proceeds and a sale happen on the module's own date, not the link's.
        if (link.when === 'once' && link.basis !== 'proceeds' && link.basis !== 'sale' && !link.date) {
            fail(`link ${i} needs a date`);
        }
        return link;
    }

    function validatePlan(raw) {
        if (!isObj(raw)) fail('plan is malformed');
        const settings = isObj(raw.settings) ? raw.settings : fail('plan settings are missing');
        const view = isObj(raw.view) ? raw.view : { x: 0, y: 0, zoom: 1 };
        if (!Array.isArray(raw.nodes)) fail('plan modules are missing');
        if (!Array.isArray(raw.links)) fail('plan links are missing');
        if (raw.nodes.length > LIMITS.nodes) fail(`a plan holds at most ${LIMITS.nodes} modules`);
        if (raw.links.length > LIMITS.links) fail(`a plan holds at most ${LIMITS.links} links`);

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
        raw.nodes.forEach((n, i) => {
            if (!isObj(n)) fail(`module ${i} is malformed`);
            const p = Catalog.preset(RETIRED_TYPES[n.type] || n.type);
            if (!p) fail(`module ${i} has an unknown type`);
            const node = {
                id: cleanId(n.id, `module ${i}`),
                type: p.id,
                name: cleanString(n.name ?? p.name, LIMITS.name, `module ${i} name`) || p.name,
                x: Math.round(cleanNumber(n.x, -1e6, 1e6, `module ${i} x`)),
                y: Math.round(cleanNumber(n.y, -1e6, 1e6, `module ${i} y`)),
                params: cleanParams(p, n.params),
            };
            if (nodesById.has(node.id)) fail(`module id ${node.id} is used twice`);
            nodesById.set(node.id, node);
            plan.nodes.push(node);
        });

        // Docks: a loan secured by an asset, snapped under it.
        raw.nodes.forEach((n, i) => {
            if (n.dock == null) return;
            const node = plan.nodes[i];
            const asset = nodesById.get(n.dock);
            const dp = Catalog.preset(node.type);
            if (!asset || asset.dock || !loanOptions(asset).length || dp.role !== 'debt' || dp.kind === 'card') {
                fail(`module ${i} is docked under something that cannot hold it`);
            }
            // A loan the asset no longer takes (an unsecured personal loan once
            // could dock) stands on its own instead of failing the whole plan.
            if (!loanOptions(asset).includes(node.type)) {
                placeBeside(node, asset);
                return;
            }
            node.dock = asset.id;
            if (docksOf(plan, asset.id).length > MAX_DOCKS) fail(`module ${asset.id} holds too many loans`);
        });
        relayout(plan);

        const seenLinks = new Set();
        const seenPairs = new Set();
        raw.links.forEach((l, i) => {
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
        for (const n of copy.nodes) if (n.dock) n.dock = map.get(n.dock);
        for (const l of copy.links) {
            l.id = newId('l');
            l.from = map.get(l.from);
            l.to = map.get(l.to);
        }
        return copy;
    }

    return {
        PLAN_VERSION, LIMITS, GEOM, MAX_DOCKS, MONTHS, RULES, PlanError,
        ymParse, ymFormat, ymNow, ymAdd, ymDiff, ymLabel,
        newId, roleOf, basesFor, modesFor, timingsFor, portsFor, portTargets, loanPayment, isPretax,
        createPlan, createNode, canConnect, createLink, defaultRule, fitRule,
        docksOf, loanOptions, canDock, relayout, addLoan, dockLoan, undockLoan, equityOf,
        validatePlan, cloneWithNewIds,
    };
}));
