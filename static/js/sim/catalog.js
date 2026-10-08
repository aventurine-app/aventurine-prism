'use strict';

// ─── catalog.js ─────────────────────────────────────────────────────────────
// The module library: every module a plan can hold, and the five behaviours
// ("roles") they are all built from.
//
// THE STANDARD. A module's role decides what it does to money, and nothing else
// does. There are six:
//
//   source    Income     Makes money on a schedule. Output only.
//   account   Account    Holds a balance that grows at a rate. Counts toward
//                        net worth.
//   asset     Asset      Something owned that is not cash: a home, a car,
//                        land. Its value changes at a rate and counts toward
//                        net worth, but it pays nothing out until it is sold.
//                        Money that arrives is spent on it and becomes value.
//   expense   Spending   Money that arrives here leaves the plan.
//   debt      Debt       Holds what is owed. Interest adds to it; money that
//                        arrives pays it down.
//   modifier  Modifier   Money passes through and changes on the way: cash back,
//                        an employer match, a tax or a fee.
//
// Every preset below (sixty-odd of them) is one of those six roles with a
// name, an icon, the fields it shows and starting values. Learning the five
// roles is learning the whole library: a Roth IRA and a CD behave alike because
// both are accounts, and the canvas paints them alike for the same reason.
//
// Amounts are set by sources. Links split money between modules (see plan.js
// for link rules). Accounts keep what reaches them, spending consumes it, and
// money that has nowhere to go lands in the plan's Unassigned pool, so nothing
// ever vanishes from the totals.
//
// Dual-environment: a classic <script> in the renderer (window.CitrineCatalog)
// and a CommonJS module for the backend validator and the test suite.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CitrineCatalog = api;
}(typeof self !== 'undefined' ? self : this, function () {

    // ── Roles ──────────────────────────────────────────────────────────────
    // hasIn / hasOut decide which ports a module draws. `holds` marks the two
    // roles that carry a balance from month to month.
    const ROLES = {
        source:   { id: 'source',   label: 'Income',   hasIn: false, hasOut: true, holds: false },
        account:  { id: 'account',  label: 'Account',  hasIn: true,  hasOut: true, holds: true },
        asset:    { id: 'asset',    label: 'Asset',    hasIn: true,  hasOut: true, holds: true },
        expense:  { id: 'expense',  label: 'Spending', hasIn: true,  hasOut: true, holds: false },
        debt:     { id: 'debt',     label: 'Debt',     hasIn: true,  hasOut: true, holds: true },
        modifier: { id: 'modifier', label: 'Modifier', hasIn: true,  hasOut: true, holds: false },
    };
    const ROLE_ORDER = ['source', 'account', 'asset', 'expense', 'debt', 'modifier'];

    // Which roles a link may run into, by the role it leaves. Nothing links
    // into a source (income has no input). Spending only routes onward to
    // other spending or to a modifier. A credit card pays for spending: its
    // links out to spending are purchases charged to the card. An asset is
    // bought or improved with money from income, accounts and loans, and only
    // sends money on once it is sold (or, for a rental, as rent).
    const LINK_TARGETS = {
        source:   ['account', 'asset', 'expense', 'debt', 'modifier'],
        account:  ['account', 'asset', 'expense', 'debt', 'modifier'],
        asset:    ['account', 'expense', 'debt', 'modifier'],
        expense:  ['expense', 'modifier'],
        debt:     ['account', 'asset', 'expense', 'debt', 'modifier'],
        modifier: ['account', 'asset', 'expense', 'debt', 'modifier'],
    };

    // ── Fields ─────────────────────────────────────────────────────────────
    // Every parameter any module can have. A role lists the ones it uses
    // (ROLE_FIELDS); a preset may show fewer and relabel them.
    //
    //   money      a currency amount
    //   percent    a percentage, entered as 22 for 22%
    //   choice     one of `options` ([value, label] pairs)
    //   month      a calendar month, 1-12 (0 = no specific month)
    //   yearmonth  'YYYY-MM', or null when optional and left blank
    const FIELDS = {
        amount:     { type: 'money',     label: 'Amount',           min: 0,    max: 1e10 },
        per:        { type: 'choice',    label: 'Every',
                      options: [['week', 'Week'], ['biweek', '2 weeks'], ['month', 'Month'],
                                ['year', 'Year'], ['once', 'Once']] },
        payMonth:   { type: 'month',     label: 'Paid in' },
        growth:     { type: 'percent',   label: 'Raise',            min: -100, max: 100, suffix: '/yr' },
        tax:        { type: 'percent',   label: 'Withholding',      min: 0,    max: 95 },
        start:      { type: 'yearmonth', label: 'Starts',           optional: true },
        end:        { type: 'yearmonth', label: 'Ends',             optional: true },
        balance:    { type: 'money',     label: 'Starting balance', min: 0,    max: 1e11 },
        rate:       { type: 'percent',   label: 'Interest',         min: -100, max: 1000, suffix: '/yr' },
        lockUntil:  { type: 'yearmonth', label: 'Locked until',     optional: true },
        capYearly:  { type: 'money',     label: 'Yearly limit',     min: 0,    max: 1e10, optional: true },
        minPayment: { type: 'money',     label: 'Minimum payment',  min: 0,    max: 1e10, optional: true },
        cashBack:   { type: 'percent',   label: 'Cash back',        min: 0,    max: 100 },
        annualFee:  { type: 'money',     label: 'Annual fee',       min: 0,    max: 1e10, optional: true },
        value:      { type: 'money',     label: 'Value',            min: 0,    max: 1e11 },
        bought:     { type: 'yearmonth', label: 'Bought',           optional: true },
        sold:       { type: 'yearmonth', label: 'Sold',             optional: true },
        sellCost:   { type: 'percent',   label: 'Selling cost',     min: 0,    max: 50 },
        rent:       { type: 'money',     label: 'Rent',             min: 0,    max: 1e10, suffix: '/mo' },
    };

    const ROLE_FIELDS = {
        source:   ['amount', 'per', 'payMonth', 'growth', 'tax', 'start', 'end'],
        account:  ['balance', 'rate', 'lockUntil', 'capYearly'],
        asset:    ['value', 'rate', 'rent', 'bought', 'sold', 'sellCost'],
        expense:  [],
        debt:     ['balance', 'rate', 'minPayment', 'start', 'cashBack', 'annualFee'],
        modifier: ['rate', 'capYearly'],
    };

    const ROLE_DEFAULTS = {
        source:   { amount: 0, per: 'month', payMonth: 0, growth: 0, tax: 0, start: null, end: null },
        account:  { balance: 0, rate: 0, lockUntil: null, capYearly: null },
        asset:    { value: 0, rate: 0, rent: 0, bought: null, sold: null, sellCost: 0 },
        expense:  {},
        debt:     { balance: 0, rate: 0, minPayment: null, start: null, cashBack: 0, annualFee: null },
        modifier: { rate: 0, capYearly: null },
    };

    // ── Categories ─────────────────────────────────────────────────────────
    // How the library is shelved. A category is for finding a module, the
    // role is what it does; most categories hold one role, Events holds two.
    const CATEGORIES = [
        { id: 'income',     name: 'Income',     icon: 'briefcase' },
        { id: 'cash',       name: 'Cash',       icon: 'bank' },
        { id: 'investing',  name: 'Investing',  icon: 'chart-line-up' },
        { id: 'retirement', name: 'Retirement', icon: 'plant' },
        { id: 'property',   name: 'Property',   icon: 'house-line' },
        { id: 'spending',   name: 'Spending',   icon: 'shopping-cart' },
        { id: 'debt',       name: 'Debt',       icon: 'cardholder' },
        { id: 'modifiers',  name: 'Modifiers',  icon: 'sliders-horizontal' },
        { id: 'events',     name: 'Events',     icon: 'calendar-star' },
    ];

    // ── Presets ────────────────────────────────────────────────────────────
    // id          stable key, stored in plans as the node's `type`
    // fields      which of the role's fields to show (default: all of them)
    // labels      per-field label overrides
    // defaults    starting values merged over ROLE_DEFAULTS. Amounts, rates and
    //             dates always start empty; only a cadence (Every, Paid in) is set
    // fixed       values the preset pins and hides (a windfall is always 'once')
    // kind        modifiers: 'match' | 'skim'. Debts: 'card' (a credit card).
    // loans       assets: the debt presets that can be attached below the module
    //             as a loan secured by it (see plan.js, docks)
    // inLink      the rule a new link INTO this module starts with
    // keywords    extra search terms
    const DEBT_FIELDS = ['balance', 'rate', 'minPayment', 'start'];
    const ASSET_FIELDS = ['value', 'rate', 'bought', 'sold', 'sellCost'];
    const P = (cat, role, id, name, icon, extra = {}) => ({ cat, role, id, name, icon, ...extra });

    // A new link into a spending module starts at 0 with this timing. A one-off
    // needs a date to be valid, so it keeps one, `inMonths` after the plan start.
    const monthly = () => ({ mode: 'fixed', value: 0, when: 'monthly' });
    const yearly = (month) => ({ mode: 'fixed', value: 0, when: 'yearly', month });
    const once = (inMonths) => ({ mode: 'fixed', value: 0, when: 'once', relDate: inMonths });

    const PRESETS = [
        // Income
        P('income', 'source', 'salary', 'Salary', 'briefcase', {
            defaults: { per: 'year' },
            keywords: 'job wage pay employment' }),
        P('income', 'source', 'paycheck', 'Paycheck', 'money', {
            defaults: { per: 'biweek' },
            labels: { amount: 'Take-home' },
            keywords: 'net pay biweekly job' }),
        P('income', 'source', 'freelance', 'Freelance', 'laptop', {
            keywords: 'contract consulting gig self-employed side hustle extra' }),
        P('income', 'source', 'tax-refund', 'Tax refund', 'arrow-u-up-left', {
            defaults: { per: 'year', payMonth: 4 },
            fields: ['amount', 'per', 'payMonth', 'start', 'end'],
            keywords: 'irs return' }),
        P('income', 'source', 'other-income', 'Other income', 'coins', {
            keywords: 'misc allowance support alimony royalties' }),

        // Cash
        P('cash', 'account', 'checking', 'Checking', 'wallet', {
            fields: ['balance', 'rate'],
            keywords: 'bank debit everyday' }),
        P('cash', 'account', 'savings', 'Savings', 'piggy-bank', {
            fields: ['balance', 'rate'],
            labels: { rate: 'APY' },
            keywords: 'bank save' }),
        P('cash', 'account', 'hysa', 'High-yield savings', 'vault', {
            fields: ['balance', 'rate'],
            labels: { rate: 'APY' },
            keywords: 'hysa online bank save interest' }),
        P('cash', 'account', 'money-market', 'Money market', 'coin-vertical', {
            fields: ['balance', 'rate'],
            labels: { rate: 'APY' },
            keywords: 'mmf mma fund' }),
        P('cash', 'account', 'emergency-fund', 'Emergency fund', 'lifebuoy', {
            fields: ['balance', 'rate'],
            labels: { rate: 'APY' },
            keywords: 'rainy day safety' }),
        P('cash', 'account', 'cd', 'Certificate of deposit', 'certificate', {
            fields: ['balance', 'rate', 'lockUntil'],
            labels: { rate: 'APY', lockUntil: 'Matures' },
            keywords: 'cd term deposit' }),
        P('cash', 'account', 'cash', 'Cash on hand', 'money-wavy', {
            fields: ['balance'],
            keywords: 'wallet physical' }),

        // Investing
        P('investing', 'account', 'brokerage', 'Brokerage', 'chart-line-up', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'stocks etf invest taxable' }),
        P('investing', 'account', 'index-fund', 'Index fund', 'chart-pie-slice', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'etf s&p 500 total market' }),
        P('investing', 'account', 'stocks', 'Stocks', 'trend-up', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'shares equities' }),
        P('investing', 'account', 'bonds', 'Bonds', 'seal-percent', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Yield' },
            keywords: 'fixed income corporate municipal' }),
        P('investing', 'account', 'treasuries', 'Treasury bills', 'bank', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Yield' },
            keywords: 't-bills government' }),
        P('investing', 'account', 'i-bonds', 'I bonds', 'seal-check', {
            fields: ['balance', 'rate', 'lockUntil'],
            labels: { rate: 'Yield' },
            keywords: 'savings bonds inflation' }),
        P('investing', 'account', 'crypto', 'Crypto', 'currency-btc', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'bitcoin ethereum coin' }),
        P('investing', 'account', 'reit', 'Real estate fund', 'building-office', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'reit property fund' }),
        P('investing', 'account', 'gold', 'Gold', 'diamond', {
            fields: ['balance', 'rate'],
            labels: { rate: 'Expected return' },
            keywords: 'precious metals silver bullion' }),

        // Retirement
        P('retirement', 'account', '401k', '401(k)', 'plant', {
            labels: { rate: 'Expected return' },
            keywords: '401k 403b workplace retirement' }),
        P('retirement', 'account', 'trad-ira', 'Traditional IRA', 'tree', {
            labels: { rate: 'Expected return' },
            keywords: 'ira retirement' }),
        P('retirement', 'account', 'roth-ira', 'Roth IRA', 'tree-evergreen', {
            labels: { rate: 'Expected return' },
            keywords: 'roth ira retirement' }),
        P('retirement', 'account', 'hsa', 'HSA', 'heartbeat', {
            labels: { rate: 'Expected return' },
            keywords: 'health savings account medical' }),
        P('retirement', 'account', '529', '529 plan', 'graduation-cap', {
            labels: { rate: 'Expected return' },
            keywords: 'college education savings' }),

        // Property. Only a rental shows rent. A secured loan is one the
        // asset backs, so an unsecured personal loan never docks.
        P('property', 'asset', 'home', 'Home', 'house-line', {
            fields: ASSET_FIELDS,
            labels: { rate: 'Appreciation' },
            loans: ['mortgage', 'home-equity'],
            keywords: 'house real estate property' }),
        P('property', 'asset', 'rental-property', 'Rental property', 'buildings', {
            fields: [...ASSET_FIELDS, 'rent'],
            labels: { rate: 'Appreciation' },
            loans: ['mortgage', 'home-equity'],
            keywords: 'investment property landlord rent' }),
        P('property', 'asset', 'vehicle', 'Vehicle', 'car', {
            fields: ASSET_FIELDS,
            labels: { rate: 'Value change' },
            loans: ['car-loan'],
            keywords: 'car truck depreciation buy new car' }),
        P('property', 'asset', 'land', 'Land', 'mountains', {
            fields: ASSET_FIELDS,
            labels: { rate: 'Appreciation' },
            loans: ['mortgage'],
            keywords: 'lot acreage' }),

        // Spending
        P('spending', 'expense', 'living', 'Living expenses', 'shopping-bag', {
            keywords: 'cost of living spending budget' }),
        P('spending', 'expense', 'rent', 'Rent', 'house', {
            inLink: monthly(), keywords: 'housing apartment lease' }),
        P('spending', 'expense', 'groceries', 'Groceries', 'basket', {
            inLink: monthly(), keywords: 'food supermarket' }),
        P('spending', 'expense', 'dining', 'Dining out', 'fork-knife', {
            inLink: monthly(), keywords: 'restaurants food takeout' }),
        P('spending', 'expense', 'utilities', 'Utilities', 'lightning', {
            inLink: monthly(), keywords: 'electric water gas internet phone bills' }),
        P('spending', 'expense', 'transport', 'Transportation', 'bus', {
            inLink: monthly(), keywords: 'gas fuel transit commute car' }),
        P('spending', 'expense', 'insurance', 'Insurance', 'shield-check', {
            inLink: monthly(), keywords: 'health auto home life premium' }),
        P('spending', 'expense', 'healthcare', 'Healthcare', 'first-aid', {
            inLink: monthly(), keywords: 'medical doctor pharmacy' }),
        P('spending', 'expense', 'subscriptions', 'Subscriptions', 'repeat', {
            inLink: monthly(), keywords: 'streaming software memberships' }),
        P('spending', 'expense', 'entertainment', 'Entertainment', 'popcorn', {
            inLink: monthly(), keywords: 'fun hobbies movies games' }),
        P('spending', 'expense', 'shopping', 'Shopping', 'handbag', {
            inLink: monthly(), keywords: 'clothes retail' }),
        P('spending', 'expense', 'travel', 'Travel', 'airplane-tilt', {
            inLink: yearly(7), keywords: 'vacation holiday trips' }),
        P('spending', 'expense', 'childcare', 'Childcare', 'baby', {
            inLink: monthly(), keywords: 'daycare kids nanny' }),
        P('spending', 'expense', 'education', 'Education', 'book-open', {
            inLink: monthly(), keywords: 'tuition school courses' }),
        P('spending', 'expense', 'pets', 'Pets', 'paw-print', {
            inLink: monthly(), keywords: 'dog cat vet' }),
        P('spending', 'expense', 'gifts', 'Gifts', 'gift', {
            inLink: yearly(12), keywords: 'holidays birthdays presents' }),
        P('spending', 'expense', 'charity', 'Charity', 'hand-heart', {
            inLink: monthly(), keywords: 'donation giving tithe' }),
        P('spending', 'expense', 'taxes', 'Taxes', 'receipt', {
            inLink: yearly(4), keywords: 'property tax income tax irs' }),
        P('spending', 'expense', 'home-upkeep', 'Home upkeep', 'hammer', {
            inLink: monthly(), keywords: 'repairs maintenance renovation' }),

        // Debt
        P('debt', 'debt', 'credit-card', 'Credit card', 'credit-card', {
            kind: 'card',
            fields: ['balance', 'rate', 'minPayment', 'cashBack', 'annualFee'],
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'cash back rewards points miles travel revolving debt' }),
        P('debt', 'debt', 'student-loan', 'Student loan', 'student', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'college education loan' }),
        P('debt', 'debt', 'car-loan', 'Car loan', 'car-profile', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'auto vehicle loan' }),
        P('debt', 'debt', 'mortgage', 'Mortgage', 'house-simple', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'home loan house' }),
        P('debt', 'debt', 'home-equity', 'Home equity loan', 'key', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'heloc cash-out refinance borrow against home equity line' }),
        P('debt', 'debt', 'personal-loan', 'Personal loan', 'handshake', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'loan installment' }),
        P('debt', 'debt', 'medical-debt', 'Medical debt', 'first-aid-kit', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'hospital bills' }),
        P('debt', 'debt', 'bnpl', 'Buy now, pay later', 'shopping-cart-simple', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'bnpl installments klarna afterpay' }),

        // Modifiers
        P('modifiers', 'modifier', 'employer-match', 'Employer match', 'hand-coins', {
            kind: 'match',
            labels: { rate: 'Match', capYearly: 'Yearly match limit' },
            keywords: '401k match contribution free money' }),
        P('modifiers', 'modifier', 'tax', 'Tax', 'percent', {
            kind: 'skim',
            fields: ['rate'],
            labels: { rate: 'Tax rate' },
            keywords: 'withholding income capital gains' }),
        P('modifiers', 'modifier', 'fee', 'Fee', 'scissors', {
            kind: 'skim',
            fields: ['rate'],
            labels: { rate: 'Fee' },
            keywords: 'advisor commission cost' }),

        // Events
        P('events', 'source', 'windfall', 'Windfall', 'sparkle', {
            fixed: { per: 'once' },
            fields: ['amount', 'tax', 'start'],
            labels: { start: 'Date', tax: 'Tax' },
            keywords: 'lottery prize one-time gift' }),
        P('events', 'source', 'inheritance', 'Inheritance', 'scroll', {
            fixed: { per: 'once' },
            fields: ['amount', 'tax', 'start'],
            labels: { start: 'Date', tax: 'Tax' },
            keywords: 'estate one-time' }),
        P('events', 'expense', 'big-purchase', 'Big purchase', 'package', {
            inLink: once(12), keywords: 'one-time furniture appliance' }),
        P('events', 'expense', 'wedding', 'Wedding', 'heart', {
            inLink: once(18), keywords: 'marriage ceremony one-time' }),
        P('events', 'expense', 'dream-trip', 'Dream trip', 'island', {
            inLink: once(12), keywords: 'vacation travel one-time' }),
        P('events', 'expense', 'emergency', 'Unexpected bill', 'siren', {
            inLink: once(9), keywords: 'emergency repair one-time' }),
    ];

    const PRESET_BY_ID = Object.create(null);
    for (const p of PRESETS) {
        if (PRESET_BY_ID[p.id]) throw new Error(`duplicate preset id ${p.id}`);
        if (!ROLES[p.role]) throw new Error(`preset ${p.id}: unknown role ${p.role}`);
        if (p.role === 'modifier' && !['match', 'skim'].includes(p.kind)) {
            throw new Error(`preset ${p.id}: modifier needs a kind`);
        }
        PRESET_BY_ID[p.id] = p;
    }

    function preset(id) {
        return PRESET_BY_ID[id] || null;
    }

    /** The fields a preset shows, in display order. */
    function fieldsFor(p) {
        const all = ROLE_FIELDS[p.role];
        const shown = p.fields ? all.filter((k) => p.fields.includes(k)) : all.slice();
        const pinned = p.fixed ? Object.keys(p.fixed) : [];
        return shown.filter((k) => !pinned.includes(k));
    }

    /** A field's label on a preset (preset override, else the generic one). */
    function fieldLabel(p, key) {
        return (p.labels && p.labels[key]) || FIELDS[key].label;
    }

    /** Starting params for a preset: role defaults, preset defaults, pins. */
    function defaultParams(p) {
        return { ...ROLE_DEFAULTS[p.role], ...(p.defaults || {}), ...(p.fixed || {}) };
    }

    return {
        ROLES, ROLE_ORDER, LINK_TARGETS, FIELDS, ROLE_FIELDS, ROLE_DEFAULTS,
        CATEGORIES, PRESETS, preset, fieldsFor, fieldLabel, defaultParams,
    };
}));
