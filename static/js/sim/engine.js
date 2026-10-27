'use strict';

// ─── engine.js ──────────────────────────────────────────────────────────────
// The simulator. Runs a plan month by month and returns every balance and
// every flow. Pure: the same plan always gives the same numbers. No clock, no
// randomness, no DOM, so it runs live in the renderer on every edit and under
// node --test unchanged.
//
// One month, in order:
//   1. Debts that start this month become owed, and their proceeds are paid
//      out along their proceeds links.
//   2. Balances move. Accounts earn (or lose) at their rate and keep it;
//      debts accrue interest. Cards make their purchases.
//   3. Income arrives and is split along their links. Money keeps
//      moving through spending and modifiers until it comes to rest. An
//      account keeps whatever arrives.
//   4. Scheduled moves out of account balances run (withdrawals, sweeps,
//      "everything above"), upstream accounts first, so a transfer made early
//      in the pass is seen by the accounts below it in the same month.
//   5. The month's balances are recorded.
//
// Rates. An account's rate is an effective annual rate (APY): a 4% account
// grows by exactly 4% over twelve months. A debt's rate is an APR charged
// monthly at APR/12, which is how cards and loans quote it.
//
// Pre-tax contributions. Income sent to a 401(k), an HSA or a Traditional IRA
// is taken from gross pay before withholding, so only what is left is taxed.
// Those links split gross pay; every other link from income splits take-home
// pay.
//
// Employer match. A 401(k)'s Employer match is the share of each contribution
// the employer adds, up to its yearly match limit. Only pay sent straight from
// income is matched (not transfers from other accounts), and the match is new
// money: it does not count toward the account's yearly contribution limit.
//
// Paying debts. A payment never exceeds what is owed: once a debt is paid off,
// the money its links would have sent stays with the payer and falls through
// to the payer's later links (its rest, usually savings). A debt that has its
// own Overpayment links is the exception: that is a snowball, and the freed
// payments go on along them instead. (Only loans have them. A card is paid
// down and no further: what it cannot take stays with the payer.)
//
// Credit limits. A card with a limit never charges past it: purchases are held
// to the credit left (limit less balance owed). On a card, a percent link
// charges that share of the limit each time it fires and a rest link charges
// whatever credit is left after the others. Without a limit neither charges
// anything. A card owing more than 30% of its limit at the month's peak (after
// purchases, before payments) is flagged as `utilization`.
//
// Conservation. Money enters only as income, an employer
// match, cash back, growth or a loan's proceeds, and leaves only as spending,
// a tax or fee, or debt interest. A credit card's annual fee is a fee: it is added to the
// balance owed, so it lowers net worth the month it is charged. Money with nowhere to go lands in the Unassigned pool, which
// counts toward net worth. So the change in net worth always equals
//   income - withholding + match + cash back + growth - interest - spent - taxes/fees
// and the test suite checks that identity on every scenario.
//
// People. A person moves no money and their links carry none. Each person's
// result is a `worth` series: the balances of the accounts their modules'
// money reaches, less the debts it reaches (plan.js, personReach).

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const Catalog = isNode ? require('./catalog.js') : root.CitrineCatalog;
    const Plan = isNode ? require('./plan.js') : root.CitrinePlan;
    const api = factory(Catalog, Plan);
    if (isNode) module.exports = api;
    else root.CitrineEngine = api;
}(typeof self !== 'undefined' ? self : this, function (Catalog, Plan) {

    // Amounts under a millionth of a currency unit are treated as zero, so
    // float dust never shows up as a shortfall or a loop that will not settle.
    const EPS = 1e-6;

    // Money moving between modules in one month is processed as a queue of
    // arrivals. A loop of links that each pass on everything (two "rest" links
    // facing each other) would never settle; past this many arrivals in one
    // month the remainder is parked in Unassigned and the plan is flagged.
    const MAX_ARRIVALS_PER_MONTH = 20000;

    // Evaluation order inside one basis: fixed amounts first, then percentages
    // (each of the full amount), then "above", then the rest.
    const MODE_ORDER = { fixed: 1, percent: 2, above: 3, rest: 4 };

    // Share of a card's limit past which carrying a balance is a red flag.
    // (1% to 10% is the ideal range; only the red flag is reported.)
    const UTILIZATION_FLAG = 30;

    function simulate(plan) {
        const start = plan.settings.start;
        const months = Math.max(1, Math.round(plan.settings.years * 12));
        const startMonth = Plan.ymParse(start).m;
        const idxOf = (ym) => (ym ? Plan.ymDiff(start, ym) : null);
        const series = () => new Float64Array(months);

        // ── State ──────────────────────────────────────────────────────────
        const states = [];
        const byId = new Map();
        plan.nodes.forEach((node, index) => {
            const preset = Catalog.preset(node.type);
            if (!preset) return;
            const s = makeState(node, preset, index, months, idxOf, series);
            states.push(s);
            byId.set(s.id, s);
        });

        const linkStates = [];
        for (const link of plan.links) {
            const from = byId.get(link.from);
            const to = byId.get(link.to);
            if (!from || !to || !from.outs[link.basis]) continue;
            const L = {
                id: link.id, link, from, to,
                mode: link.mode, basis: link.basis, when: link.when,
                value: link.value, month: link.month, growth: link.growth || 0,
                dateIdx: link.date ? idxOf(link.date) : null,
                startIdx: link.start ? idxOf(link.start) : -Infinity,
                endIdx: link.end ? idxOf(link.end) : Infinity,
                flow: series(),
                short: 0, shortFirst: -1,
                givenMonth: -1, given: 0,   // fixed links: paid so far this month
            };
            // A source keeps its pre-tax links apart: they split gross pay.
            const group = link.basis === 'inflow' && from.role === 'source' && Plan.isPretax(plan, link)
                ? 'pretax' : link.basis;
            from.outs[group].push(L);
            linkStates.push(L);
        }
        for (const s of states) {
            for (const basis of Object.keys(s.outs)) {
                s.outs[basis].sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
            }
        }

        const accounts = states.filter((s) => s.role === 'account');
        const debts = states.filter((s) => s.role === 'debt');
        const sources = states.filter((s) => s.role === 'source');
        const cards = states.filter((s) => s.kind === 'card');
        // Where each card's cash back goes: an account, else the card's balance.
        for (const s of cards) {
            const to = s.params.cashBackTo && byId.get(s.params.cashBackTo);
            s.cashBackTo = to && to.role === 'account' ? to : null;
        }
        const flowOrder = topoOrder(states, linkStates).filter((s) => s.role === 'account');

        const totals = {
            earned: series(), withheld: series(), match: series(), cashback: series(),
            growth: series(), interest: series(), spent: series(), skimmed: series(),
            proceeds: series(), debtPaid: series(),
        };
        const unassigned = new Float64Array(months + 1);
        const unassignedIn = series();
        const netWorth = new Float64Array(months + 1);
        let unassignedBal = 0;
        let runaway = false;

        // ── Moving money ───────────────────────────────────────────────────
        // A flat queue of [state, amount, link] arrivals, drained after each
        // phase. The link is the one the money came along (null for cash back).
        const queue = [];
        let head = 0;
        let arrivals = 0;
        let t = 0;
        let cal = startMonth;

        const activeAt = (L) => t >= L.startIdx && t <= L.endIdx;
        const firesNow = (L) => L.when === 'monthly'
            || (L.when === 'yearly' && cal === L.month)
            || (L.when === 'once' && t === L.dateIdx);
        const fixedValue = (L) => {
            const years = Math.floor((t - Math.max(0, L.startIdx)) / 12);
            return L.growth ? L.value * Math.pow(1 + L.growth / 100, years) : L.value;
        };
        const locked = (s) => s.lockIdx != null && t < s.lockIdx;

        function park(s, amount) {
            unassignedBal += amount;
            unassignedIn[t] += amount;
            if (s && s.unplaced) s.unplaced[t] += amount;
        }

        function noteShort(L, amount) {
            L.short += amount;
            if (L.shortFirst < 0) L.shortFirst = t;
        }

        function transfer(L, amount) {
            L.flow[t] += amount;
            L.from.outflow[t] += amount;
            if (L.to.role === 'debt') L.to.pending += amount;
            queue.push(L.to, amount, L);
        }

        /** How much more a debt can take this month: what it owes less what is
         *  already on its way to it. Unlimited for a snowball (Overpayment links),
         *  whose overpayments move on. */
        function room(d) {
            if (d.outs.inflow.some(activeAt)) return Infinity;
            return Math.max(0, d.bal - d.pending);
        }

        /** A link's wanted amount, held to what its target debt can take. */
        function capToDebt(L, want) {
            return L.to.role === 'debt' ? Math.min(want, room(L.to)) : want;
        }

        /** The employer's match on `contribution`, paid into account `s`: its
         *  match rate of it, up to the yearly match limit. */
        function addMatch(s, contribution) {
            const room = s.matchLimit == null ? Infinity : Math.max(0, s.matchLimit - s.matchedThisYear);
            const added = Math.min(contribution * s.matchRate / 100, room);
            if (added <= EPS) return;
            s.matchedThisYear += added;
            s.matched[t] += added;
            s.bal += added;
            totals.match[t] += added;
        }

        /** Split `amount` arriving at `s` across its links on `basis`.
         *  Returns what no link took. */
        function allocate(s, basis, amount) {
            const list = s.outs[basis];
            if (!list.length || amount <= EPS) return amount;
            let remaining = amount;
            for (const L of list) {
                if (!activeAt(L)) continue;
                let want;
                if (L.mode === 'fixed') {
                    if (!firesNow(L)) continue;
                    if (L.givenMonth !== t) { L.givenMonth = t; L.given = 0; }
                    want = fixedValue(L) - L.given;
                } else if (L.mode === 'percent') {
                    want = amount * L.value / 100;
                } else if (L.mode === 'rest') {
                    want = remaining;
                } else {
                    continue;   // 'above' only applies to a balance
                }
                want = capToDebt(L, want);
                if (want <= EPS) continue;
                const give = Math.min(want, remaining);
                if (L.mode === 'fixed') L.given += give;
                // A fixed amount can still be topped up by a later arrival this
                // month, so its shortfall is settled at month end instead.
                if (L.mode === 'percent' && want - give > EPS) noteShort(L, want - give);
                if (give > EPS) {
                    transfer(L, give);
                    remaining -= give;
                }
            }
            return remaining > EPS ? remaining : 0;
        }

        /** Money reaching a debt: the balance falls first, and anything past
         *  zero moves on through the debt's links. Returns what went to the
         *  balance. */
        function settle(s, amount) {
            const pay = Math.min(amount, s.bal);
            s.bal -= pay;
            if (pay > EPS && s.bal <= EPS) {
                s.bal = 0;
                if (s.paidOffAt < 0) s.paidOffAt = t;
            }
            const over = amount - pay;
            if (over > EPS) {
                const left = allocate(s, 'inflow', over);
                if (left > EPS) park(s, left);
            }
            return pay;
        }

        /** Money `amount` reaching `s`, along link `via` (null when it came
         *  some other way). */
        function receive(s, amount, via) {
            switch (s.role) {
                case 'account': {
                    let accepted = amount;
                    if (s.cap != null) {
                        const room = Math.max(0, s.cap - s.depositsThisYear);
                        if (amount > room + EPS) {
                            accepted = room;
                            s.capped += amount - room;
                            if (s.cappedFirst < 0) s.cappedFirst = t;
                            park(s, amount - room);
                        }
                    }
                    if (accepted <= EPS) return;
                    s.depositsThisYear += accepted;
                    s.inflow[t] += accepted;
                    s.bal += accepted;
                    if (s.matchRate > 0 && via && via.from.role === 'source') addMatch(s, accepted);
                    return;
                }
                case 'expense': {
                    s.inflow[t] += amount;
                    const kept = allocate(s, 'inflow', amount);
                    s.consumed[t] += kept;
                    totals.spent[t] += kept;
                    return;
                }
                case 'debt': {
                    s.pending = Math.max(0, s.pending - amount);
                    s.inflow[t] += amount;
                    const pay = settle(s, amount);
                    s.paid[t] += pay;
                    totals.debtPaid[t] += pay;
                    return;
                }
                case 'modifier': {
                    s.inflow[t] += amount;
                    const rate = (s.params.rate || 0) / 100;
                    let out;
                    if (s.kind === 'group') {
                        out = amount;
                    } else {
                        const cut = amount * Math.min(1, rate);
                        s.consumed[t] += cut;
                        totals.skimmed[t] += cut;
                        out = amount - cut;
                    }
                    if (out > EPS) {
                        const left = allocate(s, 'inflow', out);
                        if (left <= EPS) return;
                        if (s.kind === 'group') {
                            // What a budget group does not hand on is spent in the group.
                            s.consumed[t] += left;
                            totals.spent[t] += left;
                        } else {
                            park(s, left);
                        }
                    }
                    return;
                }
                default:
                    // Nothing links into income; validatePlan rejects it.
                    park(s, amount);
            }
        }

        function drain() {
            while (head < queue.length) {
                const s = queue[head];
                const amount = queue[head + 1];
                const via = queue[head + 2];
                head += 3;
                if (++arrivals > MAX_ARRIVALS_PER_MONTH) {
                    runaway = true;
                    park(null, amount);
                    continue;
                }
                receive(s, amount, via);
            }
            queue.length = 0;
            head = 0;
        }

        /** A card's purchases this month. Each charges link adds its amount to
         *  the balance and sends it to the spending it pays for, held to the
         *  credit left under the card's limit (if it has one). A percent link
         *  charges a share of the limit; a rest link charges the credit left.
         *  Cash back is deposited in the card's cash back account, or else
         *  credits the balance. */
        function chargeCard(s) {
            const limit = s.params.limit > 0 ? s.params.limit : null;
            for (const L of s.outs.charges) {
                if (!activeAt(L) || !firesNow(L)) continue;
                const available = limit == null ? Infinity : Math.max(0, limit - s.bal);
                let want;
                if (L.mode === 'fixed') want = fixedValue(L);
                else if (limit == null) want = 0;
                else want = L.mode === 'percent' ? limit * L.value / 100 : available;
                const amount = Math.min(want, available);
                L.givenMonth = t;
                L.given = amount;
                if (L.mode === 'percent' && want - amount > EPS) noteShort(L, want - amount);
                if (amount <= EPS) continue;
                s.bal += amount;
                s.charged[t] += amount;
                const back = amount * (s.params.cashBack || 0) / 100;
                if (back > EPS) {
                    s.cashback[t] += back;
                    totals.cashback[t] += back;
                    if (s.cashBackTo) {
                        s.outflow[t] += back;
                        queue.push(s.cashBackTo, back, null);
                    } else {
                        settle(s, back);
                    }
                }
                transfer(L, amount);
            }
            // Utilization is read at the month's peak, once purchases are on and
            // before payments land, which is when a statement would close.
            if (limit != null) {
                const used = s.bal / limit * 100;
                if (used > s.utilPeak) s.utilPeak = used;
                if (used > UTILIZATION_FLAG && s.utilFirst < 0) s.utilFirst = t;
            }
        }

        function withdraw(s) {
            const base = s.bal;
            for (const L of s.outs.balance) {
                if (!activeAt(L) || !firesNow(L)) continue;
                let want;
                switch (L.mode) {
                    case 'fixed':
                        want = fixedValue(L);
                        L.givenMonth = t;
                        L.given = 0;
                        break;
                    case 'percent': want = base * L.value / 100; break;
                    case 'above':   want = Math.max(0, s.bal - L.value); break;
                    default:        want = s.bal;
                }
                const give = Math.min(capToDebt(L, want), s.bal);
                if (L.mode === 'fixed') L.given = give;
                if (give > EPS) {
                    s.bal -= give;
                    transfer(L, give);
                }
            }
        }

        function settleFixedShortfalls() {
            for (const L of linkStates) {
                if (L.mode !== 'fixed' || !activeAt(L) || !firesNow(L)) continue;
                // A payment to a debt that is paid off is not short: nothing is owed.
                if (L.to.role === 'debt' && L.to.bal <= EPS) continue;
                const given = L.givenMonth === t ? L.given : 0;
                const missing = fixedValue(L) - given;
                if (missing > EPS) noteShort(L, missing);
            }
        }

        // ── Opening position ───────────────────────────────────────────────
        for (const s of accounts) s.bal = s.params.balance || 0;
        for (const s of debts) s.bal = s.originates ? 0 : (s.params.balance || 0);
        recordBalances(0);

        // ── The months ─────────────────────────────────────────────────────
        for (t = 0; t < months; t++) {
            cal = ((startMonth - 1 + t) % 12) + 1;
            arrivals = 0;
            if (cal === 1) {
                for (const s of accounts) { s.depositsThisYear = 0; s.matchedThisYear = 0; }
            }

            // Card annual fees: charged in the plan's first month and every
            // twelfth after, added to what the card owes.
            if (t % 12 === 0) {
                for (const s of cards) {
                    const fee = s.params.annualFee || 0;
                    if (fee <= EPS) continue;
                    s.bal += fee;
                    s.fees[t] += fee;
                    totals.skimmed[t] += fee;
                }
            }

            // 1. New debts.
            for (const s of debts) {
                if (!s.originates || t !== s.startIdx) continue;
                const principal = s.params.balance || 0;
                s.bal += principal;
                totals.proceeds[t] += principal;
                const left = allocate(s, 'proceeds', principal);
                if (left > EPS) park(s, left);
            }
            drain();

            // 2. Growth and interest.
            for (const s of accounts) {
                if (s.bal > EPS && s.monthlyRate !== 0) {
                    const earned = s.bal * s.monthlyRate;
                    s.bal += earned;
                    s.earnings[t] = earned;
                    totals.growth[t] += earned;
                }
            }
            for (const s of debts) {
                if (s.bal > EPS && s.params.rate > 0) {
                    const interest = s.bal * s.params.rate / 1200;
                    s.bal += interest;
                    s.interest[t] = interest;
                    totals.interest[t] += interest;
                }
            }
            for (const s of cards) chargeCard(s);
            drain();

            // 3. Income.
            for (const s of sources) {
                const gross = sourceGross(s, t, cal);
                if (gross <= EPS) continue;
                const pretax = gross - allocate(s, 'pretax', gross);
                const taxable = gross - pretax;
                const net = taxable * (1 - Math.min(95, s.params.tax || 0) / 100);
                totals.earned[t] += gross;
                totals.withheld[t] += taxable - net;
                s.gross[t] = gross;
                s.pretax[t] = pretax;
                s.produced[t] = pretax + net;
                const left = allocate(s, 'inflow', net);
                if (left > EPS) park(s, left);
                drain();
            }
            // 4. Scheduled moves out of balances.
            for (const s of flowOrder) {
                if (!s.outs.balance.length || locked(s)) continue;
                withdraw(s);
                drain();
            }

            settleFixedShortfalls();

            // 5. Record.
            recordBalances(t + 1);
        }

        function recordBalances(k) {
            let worth = unassignedBal;
            for (const s of accounts) { s.balance[k] = s.bal; worth += s.bal; }
            for (const s of debts) { s.balance[k] = s.bal; worth -= s.bal; }
            unassigned[k] = unassignedBal;
            netWorth[k] = worth;
        }

        return buildResults({
            plan, months, start, states, linkStates, totals,
            unassigned, unassignedIn, netWorth, runaway,
        });
    }

    // ── Pieces ─────────────────────────────────────────────────────────────

    function makeState(node, preset, index, months, idxOf, series) {
        const role = preset.role;
        const params = node.params || {};
        const s = {
            id: node.id, node, preset, role, kind: preset.kind || null, params, index,
            bal: 0,
            outs: role === 'account' ? { balance: [] }
                : role === 'debt' ? { inflow: [], proceeds: [], ...(preset.kind === 'card' ? { charges: [] } : {}) }
                    : { inflow: [] },
            outflow: series(),
        };
        if (role === 'source') {
            s.outs.pretax = [];
            s.gross = series();
            s.pretax = series();
            s.produced = series();
            s.unplaced = series();
            s.startIdx = params.start ? idxOf(params.start) : 0;
            s.endIdx = params.end ? idxOf(params.end) : Infinity;
        }
        if (role === 'account') {
            s.balance = new Float64Array(months + 1);
            s.inflow = series();
            s.earnings = series();
            s.unplaced = series();
            s.monthlyRate = Math.pow(1 + Math.max(-100, params.rate || 0) / 100, 1 / 12) - 1;
            s.lockIdx = params.lockUntil ? idxOf(params.lockUntil) : null;
            s.cap = params.capYearly == null ? null : params.capYearly;
            s.depositsThisYear = 0;
            // Only a preset that shows the Employer match setting is matched.
            s.matchRate = preset.employerMatch ? params.match || 0 : 0;
            s.matchLimit = params.matchLimit == null ? null : params.matchLimit;
            s.matched = series();
            s.matchedThisYear = 0;
            s.capped = 0;
            s.cappedFirst = -1;
        }
        if (role === 'expense') {
            s.inflow = series();
            s.consumed = series();
        }
        if (role === 'debt') {
            s.balance = new Float64Array(months + 1);
            s.inflow = series();
            s.interest = series();
            s.paid = series();
            s.unplaced = series();
            s.startIdx = params.start ? idxOf(params.start) : null;
            // A debt dated inside the plan is borrowed then; one dated before
            // it (or undated) is already owed on day one.
            s.originates = s.startIdx != null && s.startIdx >= 0;
            s.paidOffAt = -1;
            s.scheduled = preset.kind === 'card' ? 0 : Plan.loanPayment(params);
            s.pending = 0;          // payments queued but not yet arrived
            if (s.kind === 'card') {
                s.charged = series();
                s.cashback = series();
                s.fees = series();
                s.utilPeak = 0;         // highest share of the limit owed, in percent
                s.utilFirst = -1;       // first month it passed UTILIZATION_FLAG
            }
        }
        if (role === 'modifier') {
            s.inflow = series();
            s.consumed = series();
            s.unplaced = series();
        }
        return s;
    }

    function sourceGross(s, t, cal) {
        const p = s.params;
        if (p.per === 'once') return t === s.startIdx ? p.amount : 0;
        if (t < s.startIdx || t > s.endIdx) return 0;
        const years = Math.floor((t - Math.max(0, s.startIdx)) / 12);
        const g = p.growth ? Math.pow(1 + p.growth / 100, years) : 1;
        if (p.per === 'year') {
            if (p.payMonth) return cal === p.payMonth ? p.amount * g : 0;
            return (p.amount / 12) * g;
        }
        return p.amount * (Catalog.PER_MONTH[p.per] || 1) * g;
    }

    /** Upstream-first order of the modules, so a transfer is seen downstream
     *  in the same month. Kahn's algorithm with ties broken by plan order; a
     *  cycle is opened at its earliest module. */
    function topoOrder(states, linkStates) {
        const indeg = new Map(states.map((s) => [s, 0]));
        const next = new Map(states.map((s) => [s, []]));
        for (const L of linkStates) {
            next.get(L.from).push(L.to);
            indeg.set(L.to, indeg.get(L.to) + 1);
        }
        const order = [];
        const done = new Set();
        let ready = states.filter((s) => indeg.get(s) === 0);
        while (order.length < states.length) {
            if (!ready.length) ready = [states.find((s) => !done.has(s))];
            ready.sort((a, b) => a.index - b.index);
            const s = ready.shift();
            if (done.has(s)) continue;
            done.add(s);
            order.push(s);
            for (const n of next.get(s)) {
                if (done.has(n)) continue;
                const d = indeg.get(n) - 1;
                indeg.set(n, d);
                if (d === 0) ready.push(n);
            }
        }
        return order;
    }

    /** Groups of modules that pass arriving money around in a circle. Such a
     *  loop only settles if each turn passes on less than everything. Tarjan's
     *  strongly connected components over the links that fire on arrival. */
    function findLoops(states, linkStates) {
        const instant = new Map(states.map((s) => [s, []]));
        for (const L of linkStates) {
            if (L.basis === 'inflow' || L.basis === 'proceeds') instant.get(L.from).push(L.to);
        }
        let counter = 0;
        const index = new Map();
        const low = new Map();
        const onStack = new Set();
        const stack = [];
        const loops = [];
        function visit(v) {
            index.set(v, counter);
            low.set(v, counter);
            counter++;
            stack.push(v);
            onStack.add(v);
            for (const w of instant.get(v)) {
                if (!index.has(w)) {
                    visit(w);
                    low.set(v, Math.min(low.get(v), low.get(w)));
                } else if (onStack.has(w)) {
                    low.set(v, Math.min(low.get(v), index.get(w)));
                }
            }
            if (low.get(v) === index.get(v)) {
                const group = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    group.push(w.id);
                } while (w !== v);
                if (group.length > 1) loops.push(group);
            }
        }
        for (const s of states) if (!index.has(s)) visit(s);
        return loops;
    }

    const sum = (arr) => { let x = 0; for (let i = 0; i < arr.length; i++) x += arr[i]; return x; };

    function buildResults(r) {
        const { months, states, linkStates, totals } = r;
        const nodes = Object.create(null);
        const warnings = [];
        const milestones = [];

        for (const s of states) {
            const out = { role: s.role, kind: s.kind, outflow: s.outflow };
            if (s.role === 'debt' && s.scheduled > 0) out.payment = s.scheduled;
            for (const key of ['balance', 'inflow', 'earnings', 'gross', 'pretax', 'produced',
                'consumed', 'interest', 'paid', 'unplaced', 'charged', 'cashback', 'fees', 'matched']) {
                if (s[key]) out[key] = s[key];
            }
            out.totals = {
                in: s.inflow ? sum(s.inflow) : 0,
                out: sum(s.outflow),
                produced: s.produced ? sum(s.produced) : 0,
                pretax: s.role === 'source' ? sum(s.pretax) : 0,
                consumed: s.consumed ? sum(s.consumed) : 0,
                charged: s.charged ? sum(s.charged) : 0,
                cashback: s.cashback ? sum(s.cashback) : 0,
                fees: s.fees ? sum(s.fees) : 0,
                earnings: s.earnings ? sum(s.earnings) : 0,
                matched: s.matched ? sum(s.matched) : 0,
                interest: s.interest ? sum(s.interest) : 0,
                paid: s.paid ? sum(s.paid) : 0,
                unplaced: s.unplaced ? sum(s.unplaced) : 0,
            };
            nodes[s.id] = out;

            if (out.totals.unplaced > 0.005 && s.role !== 'account') {
                warnings.push({ code: 'unassigned', nodeId: s.id, amount: out.totals.unplaced });
            }
            if (s.role === 'account' && s.capped > 0.005) {
                warnings.push({ code: 'cap', nodeId: s.id, amount: s.capped, month: s.cappedFirst });
            }
            if (s.kind === 'card' && !(s.params.limit > 0)
                && s.outs.charges.some((L) => L.mode !== 'fixed')) {
                warnings.push({ code: 'no-limit', nodeId: s.id });
            }
            if (s.kind === 'card' && s.utilFirst >= 0) {
                warnings.push({ code: 'utilization', nodeId: s.id, amount: s.utilPeak, month: s.utilFirst });
            }
            if (s.role === 'debt') {
                if (s.paidOffAt >= 0) milestones.push({ code: 'paid-off', nodeId: s.id, month: s.paidOffAt });
                const first = s.originates ? s.params.balance || 0 : s.balance[0];
                if (s.balance[months] > first + 0.005) {
                    warnings.push({ code: 'debt-growing', nodeId: s.id, amount: s.balance[months] - first });
                }
            }
            if (s.role === 'account' && s.lockIdx != null && s.lockIdx > 0 && s.lockIdx <= months) {
                milestones.push({ code: 'unlocks', nodeId: s.id, month: s.lockIdx });
            }
            // Percentages that add up past 100% cannot all be paid.
            for (const [basis, list] of Object.entries(s.outs)) {
                const pct = list.filter((L) => L.mode === 'percent').reduce((a, L) => a + L.value, 0);
                if (pct > 100 + 1e-9) warnings.push({ code: 'over-100', nodeId: s.id, basis, amount: pct });
            }
        }

        const byId = new Map(states.map((s) => [s.id, s]));
        for (const s of states) {
            if (s.role !== 'person') continue;
            const worth = new Float64Array(months + 1);
            for (const id of Plan.personReach(r.plan, s.id)) {
                const held = byId.get(id);
                if (!held || (held.role !== 'account' && held.role !== 'debt')) continue;
                const sign = held.role === 'debt' ? -1 : 1;
                for (let k = 0; k <= months; k++) worth[k] += sign * held.balance[k];
            }
            nodes[s.id].worth = worth;
        }

        const links = Object.create(null);
        for (const L of linkStates) {
            const total = sum(L.flow);
            links[L.id] = { flow: L.flow, total, avg: total / months, short: L.short };
            if (L.short > 0.005) {
                warnings.push({ code: 'short', linkId: L.id, nodeId: L.from.id, amount: L.short, month: L.shortFirst });
            }
        }

        for (const group of findLoops(states, linkStates)) warnings.push({ code: 'loop', nodeIds: group });
        if (r.runaway) warnings.push({ code: 'runaway' });

        const t = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, sum(v)]));
        t.startNetWorth = r.netWorth[0];
        t.endNetWorth = r.netWorth[months];
        t.unassigned = r.unassigned[months];

        return {
            months, start: r.start,
            netWorth: r.netWorth,
            unassigned: r.unassigned,
            unassignedIn: r.unassignedIn,
            flows: totals,
            totals: t,
            nodes, links, warnings, milestones,
        };
    }

    return { simulate };
}));
