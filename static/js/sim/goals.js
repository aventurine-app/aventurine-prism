'use strict';

// ─── goals.js ───────────────────────────────────────────────────────────────
// When a plan meets the user's goals. A goal is one rule (plan.js has its
// shape): a measure, compared with a target, maybe by a deadline:
//
//   "Net worth is at least 25 times yearly expenses by age 65"
//
// Goals are shared by all plans, so each function takes the plan to measure
// and the goals to measure it by. Pure, like the engine: no DOM, no clock, no
// randomness.
//
//   evaluate(plan, results, goals, { real })   one status per goal, read off a run
//   PRESETS                                    rules to start a goal from
//
// The measures, at each balance point k (0..months, the moment month k-1 ends,
// where the net worth series is recorded):
//
//   net-worth   net worth
//   savings     every account's balance plus Unassigned ("account balance")
//   debt        everything owed
//   expenses    a year of spending and loan payments: the twelve months before
//               the point, or the plan's first twelve for points inside them
//               (a shorter plan's months scaled up to a year). Card payments
//               are left out: what a card buys is spending already.
//   income      a year of take-home pay (earned less withholding), the same way
//
// A goal is met at the first point its rule holds. With a deadline it is on
// time when that point is at or before the deadline's. A rule that reads a
// year of income or expenses in a plan that has none is `blocked` (there is
// nothing to compare), as is an age deadline in a plan without a person whose
// age is set.
//
// With `real`, money is measured in the plan's first month's money (deflated
// at the plan's inflation); an amount in a rule is then taken in today's
// money too. The page measures as of each month (real off).
//
// Dual-environment: window.CitrineGoals in the page, CommonJS for the tests.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const Plan = isNode ? require('./plan.js') : root.CitrinePlan;
    const api = factory(Plan);
    if (isNode) module.exports = api;
    else root.CitrineGoals = api;
}(typeof self !== 'undefined' ? self : this, function (Plan) {

    // Within half a cent counts as met.
    const EPS = 0.005;

    // Rules to start a goal from, in the order offered. `label` is what the
    // offer is called; the rest are the new goal's fields (the offer shows
    // the rule they make).
    const PRESETS = [
        { id: 'net-worth', label: 'Reach a net worth',
            name: 'First million', metric: 'net-worth', op: 'gte', unit: 'amount', value: 1000000 },
        { id: 'emergency-fund', label: 'Emergency fund',
            name: 'Emergency fund', metric: 'savings', op: 'gte', unit: 'amount', value: 20000 },
        { id: 'fi', label: 'Financial independence',
            name: 'Financial independence', metric: 'net-worth', op: 'gte', unit: 'times', value: 25, of: 'expenses' },
        { id: 'retire', label: 'Retire by an age',
            name: 'Retirement', metric: 'net-worth', op: 'gte', unit: 'times', value: 25, of: 'expenses', due: 'age', age: 65 },
        { id: 'debt-free', label: 'Be debt-free',
            name: 'Debt-free', metric: 'debt', op: 'lte', unit: 'amount', value: 0 },
        { id: 'spending', label: 'Spend within your means',
            name: 'Spending in check', metric: 'expenses', op: 'lte', unit: 'percent', value: 40, of: 'income' },
    ];

    // The measures that are a year's flow rather than a balance.
    const YEARLY = new Set(['expenses', 'income']);

    /** Deflators at the plan's inflation by balance point k (all 1 unless
     *  `real`). A month's flow lands at the end of the month: point m + 1. */
    function deflator(plan, count, real) {
        const d = new Float64Array(count + 1);
        const i = real ? (plan.settings.inflation || 0) / 100 : 0;
        for (let k = 0; k <= count; k++) d[k] = i ? Math.pow(1 + i, -k / 12) : 1;
        return d;
    }

    // The page re-simulates a frame after each edit, so for that frame the plan
    // may hold a module the results do not. Such a module is left out of the
    // measures until the next run, rather than read as missing data.
    const ofRole = (plan, role, res) => plan.nodes.filter((n) => Plan.roleOf(n) === role && res.nodes[n.id]);

    /** Sum of the balance series of `nodes`, plus `base` if given. */
    function sumBalances(res, nodes, base = null) {
        const out = base ? Float64Array.from(base) : new Float64Array(res.months + 1);
        for (const n of nodes) {
            const b = res.nodes[n.id].balance;
            for (let k = 0; k < out.length; k++) out[k] += b[k];
        }
        return out;
    }

    /** A monthly flow as a year's worth at each point (see the header). */
    function yearly(n, monthly, def) {
        const year = Math.min(12, n);
        const sums = new Float64Array(n + 1);   // running total of the months
        for (let m = 0; m < n; m++) sums[m + 1] = sums[m] + monthly(m) * def[m + 1];
        const out = new Float64Array(n + 1);
        for (let k = 0; k <= n; k++) {
            const end = Math.max(k, year);
            out[k] = (sums[end] - sums[end - year]) * 12 / year;
        }
        return out;
    }

    /** One measure's series over the run, in the run's money (or today's, by `def`). */
    function measure(plan, res, def, metric) {
        const n = res.months;
        const at = (values) => Float64Array.from(values, (v, k) => v * def[k]);
        switch (metric) {
            case 'net-worth': return at(res.netWorth);
            case 'savings': return at(sumBalances(res, ofRole(plan, 'account', res), res.unassigned));
            case 'debt': return at(sumBalances(res, ofRole(plan, 'debt', res)));
            case 'expenses': {
                const loans = ofRole(plan, 'debt', res).filter((d) => res.nodes[d.id].kind !== 'card');
                return yearly(n, (m) => {
                    let cost = res.flows.spent[m];
                    for (const d of loans) cost += res.nodes[d.id].paid[m];
                    return cost;
                }, def);
            }
            case 'income': return yearly(n, (m) => res.flows.earned[m] - res.flows.withheld[m], def);
            default: throw new Error(`unknown measure ${metric}`);
        }
    }

    /** What a goal's rule compares, at each point: the measure, and its target. */
    function sides(plan, res, def, goal) {
        const value = measure(plan, res, def, goal.metric);
        if (goal.unit === 'amount') return { value, target: new Float64Array(value.length).fill(goal.value), of: null };
        const of = measure(plan, res, def, goal.of);
        const scale = goal.unit === 'percent' ? goal.value / 100 : goal.value;
        return { value, target: Float64Array.from(of, (v) => v * scale), of };
    }

    /** Why a goal cannot be measured in this plan, or null. */
    function blockedBy(plan, goal, s) {
        if (goal.due === 'age' && !Plan.goalDate(plan, goal)) return Plan.goalPerson(plan) ? 'no-age' : 'no-person';
        for (const [metric, series] of [[goal.metric, s.value], [goal.unit === 'amount' ? null : goal.of, s.of]]) {
            if (YEARLY.has(metric) && !series.some((v) => Math.abs(v) > EPS)) return `no-${metric}`;
        }
        return null;
    }

    /** One goal's status from a run.
     *    month     the point its rule first holds, or null
     *    byIdx     the point its deadline falls on, or null without one
     *    status    'reached' (on time, or with no deadline), 'late' (met after
     *              its deadline), 'behind' (not met, its deadline inside the
     *              plan) or 'open' (not met, no deadline or one past the plan)
     *    at        the point the figures are read at: when met, else the end
     *    value, target  the two sides of the rule at `at`
     *    blocked   'no-person' | 'no-age' | 'no-income' | 'no-expenses', or null */
    function evaluateOne(plan, res, def, goal) {
        const s = sides(plan, res, def, goal);
        const n = res.months;
        const holds = goal.op === 'lte'
            ? (k) => s.value[k] <= s.target[k] + EPS
            : (k) => s.value[k] >= s.target[k] - EPS;
        const blocked = blockedBy(plan, goal, s);
        let month = null;
        if (!blocked) for (let k = 0; k <= n; k++) if (holds(k)) { month = k; break; }
        const due = Plan.goalDate(plan, goal);
        const byIdx = due ? Plan.ymDiff(plan.settings.start, due) : null;
        let status;
        if (month != null) status = byIdx == null || month <= Math.max(0, byIdx) ? 'reached' : 'late';
        else status = byIdx != null && byIdx <= n ? 'behind' : 'open';
        const at = month != null ? month : n;
        return { id: goal.id, month, byIdx, status, at, value: s.value[at], target: s.target[at], blocked };
    }

    function evaluate(plan, res, goals, { real = false } = {}) {
        const def = deflator(plan, res.months, real);
        return goals.map((goal) => evaluateOne(plan, res, def, goal));
    }

    return { PRESETS, deflator, evaluate };
}));
