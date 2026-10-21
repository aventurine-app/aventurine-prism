'use strict';

// ─── example.js ─────────────────────────────────────────────────────────────
// The example plan: a salary split into spending, savings and investing, with
// card rewards flowing back into savings. It is what "Load example" draws on
// an empty plan's card.
//
// Laid out left to right in five columns so every link runs forward into the
// savings account at the end.

(function () {
    const P = window.CitrinePlan;

    const COL = 280;
    const ROW = 150;

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
        const dining = at(3, 0, 'expense');
        dining.name = 'Dining out';
        const brokerage = at(1, ROW * 2, 'investment', { balance: 10000, rate: 7 });
        brokerage.name = 'Brokerage';
        const card = at(2, 0, 'credit-card', { cashBack: 2, limit: 5000 });
        const savings = at(4, ROW, 'bank-account', { balance: 5000, rate: 4 });
        savings.name = 'Savings';
        card.params.cashBackTo = savings.id;

        link(salary, living, { mode: 'percent', value: 45, basis: 'inflow' });
        link(salary, card, { mode: 'fixed', value: 450, basis: 'inflow' });
        link(salary, savings, { mode: 'percent', value: 15, basis: 'inflow' });
        link(salary, brokerage, { mode: 'rest', basis: 'inflow' });
        link(card, dining, { mode: 'fixed', value: 450, basis: 'charges' });

        return plan;
    }

    window.CitrineExample = { fill };
}());
