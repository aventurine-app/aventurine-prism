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
//   2. Balances move. Accounts earn (or lose) at their rate; assets appreciate
//      (or depreciate), and an asset sold this month is sold; debts accrue
//      interest. Earnings links pay out their share and the rest compounds.
//   3. Income and rent arrive and are split along their links. Money keeps
//      moving through spending, modifiers and account deposit links until it
//      comes to rest.
//   4. Scheduled moves out of account balances run (withdrawals, sweeps,
//      "everything above"), upstream accounts first, so a transfer made early
//      in the pass is seen by the accounts below it in the same month.
//   5. The month's balances are recorded.
//
// Rates. An account's rate is an effective annual rate (APY): a 4% account
// grows by exactly 4% over twelve months. A debt's rate is an APR charged
// monthly at APR/12, which is how cards and loans quote it.
//
// Assets. A home, a car or land is worth its value, not cash: nothing can be
// withdrawn from it and its appreciation is never paid out. Money that reaches
// an asset is spent on it and becomes value (a purchase or an improvement), so
// buying one moves net worth from cash to property and leaves the total alone.
// An asset with a Bought date inside the plan starts at nothing and is worth
// what was paid for it; a loan docked under it and taken out that month funds
// it by default. On its Sold date the value, less selling costs, pays off the
// loans docked under it and the rest leaves through its sale links. A rental
// collects rent while it is owned; rent is income.
//
// Paying debts. A payment never exceeds what is owed: once a debt is paid off,
// the money its links would have sent stays with the payer and falls through
// to the payer's later links (its rest, usually savings). A debt that has its
// own Overflow links is the exception: that is a snowball, and the freed
// payments go on along them instead. A 'due' link pays what the debt asks for
// this month: a loan's scheduled payment (from its years left) or a card's
// whole balance.
//
// Conservation. Money enters only as income (rent included), an employer
// match, cash back, growth or a loan's proceeds, and leaves only as spending,
// a tax or fee (selling costs included), or debt interest. A credit card's annual fee is a fee: it is added to the
// balance owed, so it lowers net worth the month it is charged. Money with nowhere to go lands in the Unassigned pool, which
// counts toward net worth. So the change in net worth always equals
//   income - withholding + match + cash back + growth - interest - spent - taxes/fees
// and the test suite checks that identity on every scenario.

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

    // Evaluation order inside one basis: payments due are paid first, then
    // fixed amounts, then percentages (each of the full amount), then "above",
    // then the rest.
    const MODE_ORDER = { due: 0, fixed: 1, percent: 2, above: 3, rest: 4 };

    const PER_MONTH = { week: 52 / 12, biweek: 26 / 12, month: 1 };

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
                acc: 0,                     // yearly earnings links: owed so far
            };
            from.outs[link.basis].push(L);
            linkStates.push(L);
        }
        for (const s of states) {
            for (const basis of Object.keys(s.outs)) {
                s.outs[basis].sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
            }
        }

        const accounts = states.filter((s) => s.role === 'account');
        const assets = states.filter((s) => s.role === 'asset');
        const debts = states.filter((s) => s.role === 'debt');
        const sources = states.filter((s) => s.role === 'source');
        const cards = states.filter((s) => s.kind === 'card');
        const loansOn = new Map(assets.map((s) => [s.id, debts.filter((d) => d.node.dock === s.id)]));
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
        // A flat queue of [state, amount] arrivals, drained after each phase.
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
            queue.push(L.to, amount);
        }

        /** What a debt asks for this month, less what 'due' links have already
         *  sent. Worked out once a month, after interest and card purchases. */
        function dueLeft(d) {
            if (d.dueMonth !== t) {
                d.dueMonth = t;
                d.dueLeft = d.kind === 'card' ? d.owedBeforePay : Math.min(d.scheduled, d.owedBeforePay);
            }
            return d.dueLeft;
        }

        /** How much more a debt can take this month: what it owes less what is
         *  already on its way to it. Unlimited for a snowball (Overflow links),
         *  whose overpayments move on. */
        function room(d) {
            if (d.outs.inflow.some(activeAt)) return Infinity;
            return Math.max(0, d.bal - d.pending);
        }

        /** A link's wanted amount, held to what its target debt can take. */
        function capToDebt(L, want) {
            return L.to.role === 'debt' ? Math.min(want, room(L.to)) : want;
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
                } else if (L.mode === 'due') {
                    if (L.to.role !== 'debt') continue;
                    want = dueLeft(L.to);
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
                if (L.mode === 'due') L.to.dueLeft -= give;
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

        /** Sell an asset: its value less selling costs pays off the loans docked
         *  under it, and what is left goes out along its sale links. */
        function sell(s) {
            const gross = s.bal;
            const cost = gross * (s.params.sellCost || 0) / 100;
            s.consumed[t] += cost;
            totals.skimmed[t] += cost;
            s.bal = 0;
            s.sold = true;
            s.soldAt = t;
            let net = gross - cost;
            for (const loan of loansOn.get(s.id)) {
                const pay = Math.min(net, loan.bal);
                if (pay > EPS) {
                    net -= pay;
                    s.outflow[t] += pay;
                    loan.inflow[t] += pay;
                    loan.paid[t] += settle(loan, pay);
                    totals.debtPaid[t] += pay;
                }
                if (loan.bal > EPS) s.underwater += loan.bal;
            }
            if (net > EPS) {
                const left = allocate(s, 'sale', net);
                if (left > EPS) park(s, left);
            }
        }

        function receive(s, amount) {
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
                    if (s.outs.inflow.length && !locked(s)) {
                        const kept = allocate(s, 'inflow', accepted);
                        s.bal -= accepted - kept;
                    }
                    return;
                }
                case 'asset': {
                    // Bought or improved: the money becomes value. Nothing can
                    // be put into an asset that has been sold.
                    if (s.sold) { park(s, amount); return; }
                    s.inflow[t] += amount;
                    s.bal += amount;
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
                    if (s.kind === 'match') {
                        const room = s.params.capYearly == null
                            ? Infinity : Math.max(0, s.params.capYearly - s.matchThisYear);
                        const match = Math.min(amount * rate, room);
                        s.matchThisYear += match;
                        s.produced[t] += match;
                        totals.match[t] += match;
                        out = amount + match;
                    } else {
                        const cut = amount * Math.min(1, rate);
                        s.consumed[t] += cut;
                        totals.skimmed[t] += cut;
                        out = amount - cut;
                    }
                    if (out > EPS) {
                        const left = allocate(s, 'inflow', out);
                        if (left > EPS) park(s, left);
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
                head += 2;
                if (++arrivals > MAX_ARRIVALS_PER_MONTH) {
                    runaway = true;
                    park(null, amount);
                    continue;
                }
                receive(s, amount);
            }
            queue.length = 0;
            head = 0;
        }

        /** A card's purchases this month. Each charges link adds its amount to
         *  the balance and sends it to the spending it pays for. Cash back is
         *  split by the card's cash back links; what they leave credits the
         *  balance. */
        function chargeCard(s) {
            for (const L of s.outs.charges) {
                if (!activeAt(L) || !firesNow(L)) continue;
                const amount = fixedValue(L);
                L.givenMonth = t;
                L.given = amount;
                if (amount <= EPS) continue;
                s.bal += amount;
                s.charged[t] += amount;
                const back = amount * (s.params.cashBack || 0) / 100;
                if (back > EPS) {
                    s.cashback[t] += back;
                    totals.cashback[t] += back;
                    const left = allocate(s, 'cashback', back);
                    if (left > EPS) settle(s, left);
                }
                transfer(L, amount);
            }
            s.owedBeforePay = s.bal;
        }

        function payEarnings(s, earned) {
            let remaining = earned;
            for (const L of s.outs.earnings) {
                if (!activeAt(L) || remaining <= EPS) continue;
                const share = L.mode === 'percent'
                    ? Math.min(earned * L.value / 100, remaining)
                    : remaining;
                if (share <= EPS) continue;
                remaining -= share;
                if (L.when === 'yearly') {
                    L.acc += share;
                } else {
                    s.bal -= share;
                    transfer(L, share);
                }
            }
        }

        function payYearlyEarnings(s) {
            for (const L of s.outs.earnings) {
                if (L.when !== 'yearly' || cal !== L.month || L.acc <= EPS || !activeAt(L)) continue;
                const give = Math.min(L.acc, s.bal);
                L.acc = 0;
                if (give > EPS) {
                    s.bal -= give;
                    transfer(L, give);
                }
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
                    case 'due':     want = L.to.role === 'debt' ? dueLeft(L.to) : 0; break;
                    case 'percent': want = base * L.value / 100; break;
                    case 'above':   want = Math.max(0, s.bal - L.value); break;
                    default:        want = s.bal;
                }
                const give = Math.min(capToDebt(L, want), s.bal);
                if (L.mode === 'fixed') L.given = give;
                if (L.mode === 'due') L.to.dueLeft -= give;
                if (give > EPS) {
                    s.bal -= give;
                    transfer(L, give);
                }
            }
        }

        function settleFixedShortfalls() {
            for (const L of linkStates) {
                if (L.mode !== 'fixed' || L.basis === 'earnings' || !activeAt(L) || !firesNow(L)) continue;
                // A payment to a debt that is paid off is not short: nothing is owed.
                if (L.to.role === 'debt' && L.to.bal <= EPS) continue;
                const given = L.givenMonth === t ? L.given : 0;
                const missing = fixedValue(L) - given;
                if (missing > EPS) noteShort(L, missing);
            }
        }

        // ── Opening position ───────────────────────────────────────────────
        for (const s of accounts) s.bal = s.params.balance || 0;
        for (const s of assets) {
            // Sold before the plan starts: never held. Bought inside it: worth
            // nothing until it is paid for.
            if (s.soldIdx != null && s.soldIdx < 0) s.sold = true;
            s.bal = s.sold || s.acquires ? 0 : s.params.value || 0;
        }
        for (const s of debts) s.bal = s.originates ? 0 : (s.params.balance || 0);
        recordBalances(0);

        // ── The months ─────────────────────────────────────────────────────
        for (t = 0; t < months; t++) {
            cal = ((startMonth - 1 + t) % 12) + 1;
            arrivals = 0;
            if (cal === 1) {
                for (const s of accounts) s.depositsThisYear = 0;
                for (const s of states) if (s.role === 'modifier') s.matchThisYear = 0;
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

            // 1. New debts. A loan taken out the month the asset it is docked
            // under is bought pays for it with what its links leave.
            for (const s of debts) {
                if (!s.originates || t !== s.startIdx) continue;
                const principal = s.params.balance || 0;
                s.bal += principal;
                totals.proceeds[t] += principal;
                const left = allocate(s, 'proceeds', principal);
                if (left <= EPS) continue;
                const asset = s.node.dock ? byId.get(s.node.dock) : null;
                if (asset && asset.acquires && asset.boughtIdx === t) receive(asset, left);
                else park(s, left);
            }
            drain();

            // 2. Growth and interest.
            for (const s of accounts) {
                if (s.bal > EPS && s.monthlyRate !== 0) {
                    const earned = s.bal * s.monthlyRate;
                    s.bal += earned;
                    s.earnings[t] = earned;
                    totals.growth[t] += earned;
                    if (earned > EPS && !locked(s)) payEarnings(s, earned);
                }
                if (!locked(s)) payYearlyEarnings(s);
            }
            for (const s of assets) {
                // Value changes from the month after it is bought.
                const held = !s.sold && (s.boughtIdx == null || t > s.boughtIdx);
                if (held && s.bal > EPS && s.monthlyRate !== 0) {
                    const change = s.bal * s.monthlyRate;
                    s.bal += change;
                    s.earnings[t] = change;
                    totals.growth[t] += change;
                }
                if (!s.sold && t === s.soldIdx) sell(s);
            }
            for (const s of debts) {
                if (s.bal > EPS && s.params.rate > 0) {
                    const interest = s.bal * s.params.rate / 1200;
                    s.bal += interest;
                    s.interest[t] = interest;
                    totals.interest[t] += interest;
                }
                s.owedBeforePay = s.bal;
            }
            for (const s of cards) chargeCard(s);
            drain();

            // 3. Income.
            for (const s of sources) {
                const gross = sourceGross(s, t, cal);
                if (gross <= EPS) continue;
                const net = gross * (1 - Math.min(95, s.params.tax || 0) / 100);
                totals.earned[t] += gross;
                totals.withheld[t] += gross - net;
                s.gross[t] = gross;
                s.produced[t] = net;
                const left = allocate(s, 'inflow', net);
                if (left > EPS) park(s, left);
                drain();
            }
            for (const s of assets) {
                const rent = s.params.rent || 0;
                if (rent <= EPS || !s.collectsRent || s.sold) continue;
                if (s.boughtIdx != null && t < s.boughtIdx) continue;
                totals.earned[t] += rent;
                s.produced[t] = rent;
                const left = allocate(s, 'rent', rent);
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
            // Underpaid: a loan paid less than its scheduled payment, a card
            // less than its minimum.
            for (const s of debts) {
                const required = Math.min(s.owedBeforePay,
                    s.kind === 'card' ? s.params.minPayment || 0 : s.scheduled);
                if (required > EPS && s.underpaidFirst < 0 && s.paid[t] + EPS < required) {
                    s.underpaidFirst = t;
                }
            }

            // 5. Record.
            recordBalances(t + 1);
        }

        function recordBalances(k) {
            let worth = unassignedBal;
            for (const s of accounts) { s.balance[k] = s.bal; worth += s.bal; }
            for (const s of assets) { s.balance[k] = s.bal; worth += s.bal; }
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
            outs: role === 'account' ? { inflow: [], earnings: [], balance: [] }
                : role === 'asset' ? { sale: [], rent: [] }
                    : role === 'debt' ? { inflow: [], proceeds: [], ...(preset.kind === 'card' ? { charges: [], cashback: [] } : {}) }
                        : { inflow: [] },
            outflow: series(),
        };
        if (role === 'source') {
            s.gross = series();
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
            s.capped = 0;
            s.cappedFirst = -1;
        }
        if (role === 'asset') {
            s.balance = new Float64Array(months + 1);
            s.inflow = series();
            s.earnings = series();     // appreciation (negative: depreciation)
            s.produced = series();     // rent
            s.consumed = series();     // selling costs
            s.unplaced = series();
            s.monthlyRate = Math.pow(1 + Math.max(-100, params.rate || 0) / 100, 1 / 12) - 1;
            s.boughtIdx = params.bought ? idxOf(params.bought) : null;
            s.soldIdx = params.sold ? idxOf(params.sold) : null;
            s.acquires = s.boughtIdx != null && s.boughtIdx >= 0;
            s.collectsRent = Catalog.fieldsFor(preset).includes('rent');
            s.sold = false;
            s.soldAt = -1;
            s.underwater = 0;
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
            s.underpaidFirst = -1;
            s.owedBeforePay = 0;
            s.scheduled = preset.kind === 'card' ? 0 : Plan.loanPayment(params);
            s.pending = 0;          // payments queued but not yet arrived
            s.dueMonth = -1;
            s.dueLeft = 0;
            if (s.kind === 'card') {
                s.charged = series();
                s.cashback = series();
                s.fees = series();
            }
        }
        if (role === 'modifier') {
            s.inflow = series();
            s.produced = series();
            s.consumed = series();
            s.unplaced = series();
            s.matchThisYear = 0;
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
        return p.amount * (PER_MONTH[p.per] || 1) * g;
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
            for (const key of ['balance', 'inflow', 'earnings', 'gross', 'produced',
                'consumed', 'interest', 'paid', 'unplaced', 'charged', 'cashback', 'fees']) {
                if (s[key]) out[key] = s[key];
            }
            out.totals = {
                in: s.inflow ? sum(s.inflow) : 0,
                out: sum(s.outflow),
                produced: s.produced ? sum(s.produced) : 0,
                consumed: s.consumed ? sum(s.consumed) : 0,
                charged: s.charged ? sum(s.charged) : 0,
                cashback: s.cashback ? sum(s.cashback) : 0,
                fees: s.fees ? sum(s.fees) : 0,
                earnings: s.earnings ? sum(s.earnings) : 0,
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
            if (s.role === 'debt') {
                if (s.paidOffAt >= 0) milestones.push({ code: 'paid-off', nodeId: s.id, month: s.paidOffAt });
                if (s.underpaidFirst >= 0) {
                    warnings.push({ code: 'underpaid', nodeId: s.id, month: s.underpaidFirst });
                }
                const first = s.originates ? s.params.balance || 0 : s.balance[0];
                if (s.balance[months] > first + 0.005) {
                    warnings.push({ code: 'debt-growing', nodeId: s.id, amount: s.balance[months] - first });
                }
            }
            if (s.role === 'account' && s.lockIdx != null && s.lockIdx > 0 && s.lockIdx <= months) {
                milestones.push({ code: 'unlocks', nodeId: s.id, month: s.lockIdx });
            }
            if (s.role === 'asset') {
                if (s.acquires && s.boughtIdx < months) {
                    milestones.push({ code: 'bought', nodeId: s.id, month: s.boughtIdx });
                    // Paid for in full? Everything that reached it by the end
                    // of the month it was bought, against its price.
                    let paid = 0;
                    for (let k = 0; k <= s.boughtIdx; k++) paid += s.inflow[k];
                    const price = s.params.value || 0;
                    if (Math.abs(price - paid) > 0.5) {
                        warnings.push({ code: 'price', nodeId: s.id, amount: price - paid, month: s.boughtIdx });
                    }
                }
                if (s.soldAt >= 0) milestones.push({ code: 'sold', nodeId: s.id, month: s.soldAt });
                if (s.underwater > 0.005) {
                    warnings.push({ code: 'underwater', nodeId: s.id, amount: s.underwater, month: s.soldAt });
                }
            }
            // Percentages that add up past 100% cannot all be paid.
            for (const [basis, list] of Object.entries(s.outs)) {
                const pct = list.filter((L) => L.mode === 'percent').reduce((a, L) => a + L.value, 0);
                if (pct > 100 + 1e-9) warnings.push({ code: 'over-100', nodeId: s.id, basis, amount: pct });
            }
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

    return { simulate, EPS };
}));
