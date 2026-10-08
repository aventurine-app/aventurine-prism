'use strict';

// ─── describe.js ────────────────────────────────────────────────────────────
// Plan data into words. Part of the standard: every link can be read as one
// sentence ("Send 20% of income to Savings, every month") and every module as
// a one-line summary, and those words come from here so the canvas, the
// inspector and the warnings all say the same thing the same way.

(function () {
    const C = window.CitrineCatalog;
    const P = window.CitrinePlan;

    const CATEGORY_NAME = Object.fromEntries(C.CATEGORIES.map((c) => [c.id, c.name]));
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    const presetOf = (node) => C.preset(node.type);
    const roleOf = (node) => presetOf(node).role;

    /** What a link's basis is called, from the source's side. */
    function basisNoun(from, basis) {
        const p = presetOf(from);
        if (basis === 'earnings') return 'earnings';
        if (basis === 'balance') return 'balance';
        if (basis === 'proceeds') return 'loan proceeds';
        if (basis === 'charges') return 'purchases';
        if (basis === 'cashback') return 'cash back';
        if (basis === 'sale') return 'sale proceeds';
        if (basis === 'rent') return 'rent';
        switch (p.role) {
            case 'source':  return 'income';
            case 'account': return 'deposits';
            case 'expense': return 'spending';
            case 'debt':    return 'payoff overflow';
            default:        return 'output';
        }
    }

    const INFLOW_PORT = { source: 'Pay', account: 'Deposits', expense: 'Spending', modifier: 'Passes on', debt: 'Overflow' };
    const BASIS_PORT = { earnings: 'Earnings', balance: 'Balance', proceeds: 'Loan proceeds', charges: 'Purchases', cashback: 'Cash back',
        sale: 'Sale', rent: 'Rent' };
    const INFLOW_FLOW = { source: 'pay', account: 'deposits', expense: 'spending', modifier: 'passes', debt: 'overflow' };

    /** What an output port sends, as its label: 'Deposits', 'Cash back'. */
    function portLabel(node, basis) {
        return BASIS_PORT[basis] || INFLOW_PORT[roleOf(node)] || 'Output';
    }

    /** The colour key of an output port and of the links leaving it. */
    function flowKey(node, basis) {
        return basis === 'inflow' ? INFLOW_FLOW[roleOf(node)] || 'overflow' : basis;
    }

    /** Short timing word for a canvas label. */
    function timingShort(link) {
        if (link.when === 'yearly') return '/yr';
        if (link.when === 'once') return link.date ? ` · ${P.ymLabel(link.date)}` : ' once';
        return '/mo';
    }

    /** Timing as words for a sentence. */
    function timingWords(link) {
        if (link.when === 'yearly') return `every ${MONTH_NAMES[link.month - 1]}`;
        if (link.when === 'once') return link.date ? `once, in ${P.ymLabel(link.date)}` : 'once';
        return 'every month';
    }

    function compact(v) {
        return Fmt.money(v, { compact: v >= 10000 });
    }

    /** The label on a link's pill: '20%', '$1,800/mo', 'Rest', 'Above $20K'. */
    /** Bases whose money is split the moment it arrives, so their links have
     *  no timing of their own. */
    const ON_ARRIVAL = new Set(['inflow', 'proceeds', 'cashback', 'sale', 'rent']);

    function linkShort(link, from) {
        const onArrival = ON_ARRIVAL.has(link.basis);
        const tag = onArrival ? '' : ` ${link.basis === 'earnings' ? 'of earnings' : 'of balance'}`;
        switch (link.mode) {
            case 'percent':
                return `${Fmt.number(link.value, 2)}%${tag}${onArrival ? '' : timingShort(link).replace('/mo', '')}`.trim();
            case 'fixed':
                return `${compact(link.value)}${timingShort(link)}`;
            case 'above':
                return `Above ${compact(link.value)}`;
            default:
                if (link.basis === 'balance') return `Everything${timingShort(link).replace('/mo', ' monthly')}`;
                if (link.basis === 'earnings') return 'Rest of earnings';
                if (link.basis === 'proceeds') return 'Proceeds';
                if (link.basis === 'cashback') return 'Cash back';
                if (link.basis === 'sale') return 'Sale';
                return roleOf(from) === 'debt' ? 'Overflow' : 'Rest';
        }
    }

    /** The full rule as HTML, numbers and names in <b>. Names are escaped. */
    function linkSentence(link, from, to) {
        const b = (s) => `<b>${escapeHtml(s)}</b>`;
        const noun = basisNoun(from, link.basis);
        const target = b(to.name);
        let what;
        switch (link.mode) {
            case 'percent':
                what = `${b(`${Fmt.number(link.value, 2)}%`)} of ${link.basis === 'earnings' && link.when === 'yearly'
                    ? "each year's earnings" : `the ${noun}`}`;
                break;
            case 'fixed':
                what = b(Fmt.money(link.value, { decimals: link.value % 1 ? 2 : 0 }));
                break;
            case 'above':
                what = `everything above ${b(Fmt.money(link.value))}`;
                break;
            default:
                what = link.basis === 'balance' ? 'the whole balance' : `the rest of the ${noun}`;
        }
        const parts = [link.basis === 'charges'
            ? `Charge ${what} of ${target} to ${b(from.name)}`
            : `Send ${what} to ${target}`];
        const onArrival = ON_ARRIVAL.has(link.basis) && !(link.basis === 'inflow' && link.mode === 'fixed');
        if (!onArrival) parts.push(timingWords(link));
        if (link.mode === 'fixed' && link.growth) parts.push(`growing ${b(`${Fmt.number(link.growth, 2)}%`)} a year`);
        if (link.start && link.end) parts.push(`from ${P.ymLabel(link.start)} to ${P.ymLabel(link.end)}`);
        else if (link.start) parts.push(`starting ${P.ymLabel(link.start)}`);
        else if (link.end) parts.push(`until ${P.ymLabel(link.end)}`);
        return `${parts.join(', ')}.`;
    }

    const PER_WORD = { week: '/wk', biweek: ' every 2 weeks', month: '/mo', year: '/yr' };

    /** A module's defining figure as a badge: '4% APY', '24% APR', '2% back'. */
    function nodeBadge(node) {
        const p = presetOf(node);
        const r = node.params.rate;
        switch (p.role) {
            case 'account': {
                if (!r) return '';
                const label = C.fieldLabel(p, 'rate');
                const word = label === 'APY' ? 'APY' : label === 'Interest' ? 'interest'
                    : label === 'Yield' ? 'yield' : 'return';
                return `${Fmt.pct(r)} ${word}`;
            }
            case 'asset': {
                const rate = r ? `${Fmt.pct(r, { sign: r > 0 })}/yr` : '';
                const rent = node.params.rent && C.fieldsFor(p).includes('rent') ? `${compact(node.params.rent)} rent` : '';
                return [rate, rent].filter(Boolean).join(' · ');
            }
            case 'debt': {
                const apr = r ? `${Fmt.pct(r)} APR` : '';
                const back = p.kind === 'card' && node.params.cashBack ? `${Fmt.pct(node.params.cashBack)} back` : '';
                return [apr, back].filter(Boolean).join(' · ');
            }
            case 'modifier':
                if (p.kind === 'match') return `+${Fmt.pct(r)} match`;
                return `${Fmt.pct(r)} ${p.id === 'fee' ? 'fee' : 'tax'}`;
            default:
                return '';
        }
    }

    /** One line under a module's name: category plus its key setting. */
    function nodeMeta(node) {
        const p = presetOf(node);
        const cat = CATEGORY_NAME[p.cat];
        if (p.role === 'source') {
            const v = node.params;
            if (v.per === 'once') return `${cat} · ${v.start ? P.ymLabel(v.start) : 'once'}`;
            const lump = v.per === 'year' && v.payMonth ? ` in ${P.MONTHS[v.payMonth - 1]}` : '';
            return `${cat} · ${compact(v.amount)}${PER_WORD[v.per]}${lump}`;
        }
        const badge = nodeBadge(node);
        return badge ? `${cat} · ${badge}` : cat;
    }

    function monthLabel(plan, k) {
        return P.ymLabel(P.ymAdd(plan.settings.start, k));
    }

    const nameOf = (plan, id) => {
        const n = plan.nodes.find((x) => x.id === id);
        return n ? n.name : 'A module';
    };

    /** A warning as a sentence, plus what to select when it is clicked. */
    function warning(w, plan) {
        const m = (k) => monthLabel(plan, k);
        switch (w.code) {
            case 'short': {
                const l = plan.links.find((x) => x.id === w.linkId);
                const to = l ? nameOf(plan, l.to) : 'its target';
                return {
                    level: 'warn', select: { kind: 'link', id: w.linkId },
                    text: `${nameOf(plan, w.nodeId)} to ${to} falls ${Fmt.money(w.amount, { compact: true })} short, starting ${m(w.month)}.`,
                };
            }
            case 'over-100':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `${nameOf(plan, w.nodeId)} sends ${Fmt.number(w.amount, 2)}% of its ${basisNoun(plan.nodes.find((n) => n.id === w.nodeId), w.basis)}.`,
                };
            case 'unassigned':
                return {
                    level: 'info', select: { kind: 'node', id: w.nodeId },
                    text: `${Fmt.money(w.amount, { compact: true })} from ${nameOf(plan, w.nodeId)} has no link and lands in Unassigned.`,
                };
            case 'cap':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `${nameOf(plan, w.nodeId)} reaches its yearly limit in ${m(w.month)}; ${Fmt.money(w.amount, { compact: true })} lands in Unassigned.`,
                };
            case 'underpaid':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `${nameOf(plan, w.nodeId)} is paid less than its minimum from ${m(w.month)}.`,
                };
            case 'price': {
                const short = w.amount > 0;
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `${nameOf(plan, w.nodeId)} is paid ${Fmt.money(Math.abs(w.amount), { compact: true })} ${short ? 'less' : 'more'} than its value in ${m(w.month)}.`,
                };
            }
            case 'underwater':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `Selling ${nameOf(plan, w.nodeId)} in ${m(w.month)} leaves ${Fmt.money(w.amount, { compact: true })} still owed on its loans.`,
                };
            case 'debt-growing':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeId },
                    text: `${nameOf(plan, w.nodeId)} grows by ${Fmt.money(w.amount, { compact: true })}: interest is more than the payments.`,
                };
            case 'loop':
                return {
                    level: 'warn', select: { kind: 'node', id: w.nodeIds[0] },
                    text: `Money circles between ${w.nodeIds.map((id) => nameOf(plan, id)).join(', ')}.`,
                };
            case 'runaway':
                return { level: 'warn', select: null, text: 'A loop passes all of its money around; some was parked in Unassigned.' };
            default:
                return { level: 'info', select: null, text: w.code };
        }
    }

    window.Describe = {
        CATEGORY_NAME, MONTH_NAMES, presetOf, roleOf, basisNoun, portLabel, flowKey, linkShort, linkSentence,
        nodeBadge, nodeMeta, monthLabel, warning, compact,
    };
}());
