'use strict';

// ─── example.js ─────────────────────────────────────────────────────────────
// The starter plan: a salary split into spending, savings and investing, with
// investment earnings and card rewards flowing back into savings. It is the
// first plan on a fresh install and what "Load example" draws on an empty one.
//
// Laid out left to right in five columns so every link runs forward into the
// savings account at the end.

(function () {
    const P = window.CitrinePlan;

    const COL = 280;
    const ROW = 150;

    function build({ name = 'Five-year outlook', start = P.ymNow(), years = 5 } = {}) {
        const plan = P.createPlan({ name, start, years });
        return fill(plan);
    }

    /** Add the example's modules and links to `plan` (which may be empty). */
    function fill(plan, origin = { x: 0, y: 0 }) {
        const at = (col, y, type, params = {}) => {
            const n = P.createNode(plan, type, origin.x + col * COL, origin.y + y);
            Object.assign(n.params, params);
            plan.nodes.push(n);
            return n;
        };
        const link = (from, to, rule) => {
            const l = P.createLink(plan, from.id, to.id);
            Object.assign(l, rule);
            plan.links.push(l);
            return l;
        };

        const salary = at(0, ROW, 'salary', { amount: 85000, per: 'year', growth: 3, tax: 22 });
        const living = at(1, 0, 'living');
        const dining = at(3, 0, 'dining');
        const brokerage = at(1, ROW * 2, 'brokerage', { balance: 10000, rate: 7 });
        const card = at(2, 0, 'credit-card', { cashBack: 2 });
        const savings = at(4, ROW, 'hysa', { balance: 5000, rate: 4 });

        link(salary, living, { mode: 'percent', value: 45, basis: 'inflow' });
        link(salary, card, { mode: 'fixed', value: 450, basis: 'inflow' });
        link(salary, savings, { mode: 'percent', value: 15, basis: 'inflow' });
        link(salary, brokerage, { mode: 'rest', basis: 'inflow' });
        link(brokerage, savings, { mode: 'percent', value: 50, basis: 'earnings', when: 'yearly', month: 12 });
        link(card, dining, { mode: 'fixed', value: 450, basis: 'charges' });
        link(card, savings, { mode: 'rest', basis: 'cashback' });

        return plan;
    }

    window.CitrineExample = { build, fill };
}());
