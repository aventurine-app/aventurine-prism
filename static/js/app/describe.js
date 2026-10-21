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
        if (basis === 'balance') return 'balance';
        if (basis === 'proceeds') return 'loan proceeds';
        if (basis === 'charges') return 'credit limit';
        switch (p.role) {
            case 'source':  return 'income';
            case 'expense': return 'spending';
            case 'debt':    return 'overpayment';
            default:        return 'output';
        }
    }

    const INFLOW_PORT = { source: 'Pay', expense: 'Spending', modifier: 'Passes on', debt: 'Overpayment' };
    const BASIS_PORT = { balance: 'Balance', proceeds: 'Loan proceeds', charges: 'Purchases' };

    /** What a link carries out of a module, as a label: 'Deposits', 'Purchases'. */
    function portLabel(node, basis) {
        return BASIS_PORT[basis] || INFLOW_PORT[roleOf(node)] || 'Output';
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

    /** Bases whose money is split the moment it arrives, so their links have
     *  no timing of their own. */
    const ON_ARRIVAL = new Set(['inflow', 'proceeds']);

    /** The label on a link's pill: '20%', '$1,800/mo', 'Rest', 'Above $20K'. */
    function linkShort(link, from) {
        const onArrival = ON_ARRIVAL.has(link.basis);
        const tag = onArrival ? '' : link.basis === 'charges' ? ' of limit' : ' of balance';
        switch (link.mode) {
            case 'percent':
                return `${Fmt.number(link.value, 2)}%${tag}${onArrival ? '' : timingShort(link).replace('/mo', '')}`.trim();
            case 'fixed':
                return `${compact(link.value)}${timingShort(link)}`;
            case 'above':
                return `Above ${compact(link.value)}`;
            default:
                if (link.basis === 'balance') return `Everything${timingShort(link).replace('/mo', ' monthly')}`;
                if (link.basis === 'charges') return 'Credit left';
                if (link.basis === 'proceeds') return 'Proceeds';
                return roleOf(from) === 'debt' ? 'Overpayment' : 'Rest';
        }
    }

    /** The full rule as HTML, numbers and names in <b>. Names are escaped. */
    function linkSentence(link, from, to) {
        const b = (s) => `<b>${escapeHtml(s)}</b>`;
        const pretax = Store.state.plan && P.isPretax(Store.state.plan, link);
        const noun = pretax ? 'pay before tax' : basisNoun(from, link.basis);
        const target = b(to.name);
        let what;
        switch (link.mode) {
            case 'percent':
                what = `${b(`${Fmt.number(link.value, 2)}%`)} of the ${noun}`;
                break;
            case 'fixed':
                what = b(Fmt.money(link.value, { decimals: link.value % 1 ? 2 : 0 }));
                break;
            case 'above':
                what = `everything above ${b(Fmt.money(link.value))}`;
                break;
            default:
                what = link.basis === 'balance' ? 'the whole balance'
                    : link.basis === 'charges' ? 'the credit left' : `the rest of the ${noun}`;
        }
        // A card's fixed purchase names what it buys; a share of its limit or
        // the credit left is charged to the card for that spending.
        const parts = [link.basis !== 'charges' ? `Send ${what} to ${target}`
            : link.mode === 'fixed' ? `Charge ${what} of ${target} to ${b(from.name)}`
                : `Charge ${what} on ${b(from.name)} for ${target}`];
        const onArrival = ON_ARRIVAL.has(link.basis) && !(link.basis === 'inflow' && link.mode === 'fixed');
        // A percent or rest already says "of the pay before tax".
        if (pretax && link.mode === 'fixed') parts.push('before tax');
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
                const word = label === 'APY' ? 'APY' : label === 'Interest' ? 'interest' : 'return';
                return `${Fmt.pct(r)} ${word}`;
            }
            case 'debt': {
                const apr = r ? `${Fmt.pct(r)} APR` : '';
                const backTo = p.kind === 'card' && Store.node(node.params.cashBackTo);
                const back = p.kind === 'card' && node.params.cashBack
                    ? `${Fmt.pct(node.params.cashBack)} back${backTo ? ` to ${backTo.name}` : ''}` : '';
                const payment = p.kind === 'card' ? 0 : P.loanPayment(node.params);
                const due = payment > 0.005 ? `${compact(payment)}/mo` : '';
                return [apr, back, due].filter(Boolean).join(' · ');
            }
            case 'modifier':
                if (p.kind === 'group') return '';
                if (p.kind === 'match') return `+${Fmt.pct(r)} match`;
                return `${Fmt.pct(r)} tax`;
            default:
                return '';
        }
    }

    /** One line under a module's name: its key setting. */
    function nodeMeta(node) {
        const p = presetOf(node);
        if (p.role === 'source') {
            const v = node.params;
            if (v.per === 'once') return v.start ? P.ymLabel(v.start) : 'once';
            const lump = v.per === 'year' && v.payMonth ? ` in ${P.MONTHS[v.payMonth - 1]}` : '';
            return `${compact(v.amount)}${PER_WORD[v.per]}${lump}`;
        }
        return nodeBadge(node);
    }

    function monthLabel(plan, k) {
        return P.ymLabel(P.ymAdd(plan.settings.start, k));
    }

    const nameOf = (plan, id) => {
        const n = plan.nodes.find((x) => x.id === id);
        return n ? n.name : 'A module';
    };

    // How loud a warning is. A card's high utilization is a notice (not a
    // problem yet) and money parked in Unassigned is information; every other
    // warning is a warning.
    const WARNING_LEVEL = { unassigned: 'info', utilization: 'notice' };

    /** 'warn', 'notice' or 'info', without writing the warning's sentence. */
    function warningLevel(w) {
        return WARNING_LEVEL[w.code] || 'warn';
    }

    /** A warning as a sentence, plus what to select when it is clicked. */
    function warning(w, plan) {
        return { level: warningLevel(w), ...warningBody(w, plan) };
    }

    function warningBody(w, plan) {
        const m = (k) => monthLabel(plan, k);
        const name = nameOf(plan, w.nodeId);
        const node = { kind: 'node', id: w.nodeId };
        switch (w.code) {
            case 'short': {
                const l = plan.links.find((x) => x.id === w.linkId);
                const to = l ? nameOf(plan, l.to) : 'its target';
                return {
                    select: { kind: 'link', id: w.linkId },
                    text: `${name} to ${to} falls ${Fmt.money(w.amount, { compact: true })} short, starting ${m(w.month)}.`,
                };
            }
            case 'over-100':
                return {
                    select: node,
                    text: `${name} sends ${Fmt.number(w.amount, 2)}% of its ${basisNoun(plan.nodes.find((n) => n.id === w.nodeId), w.basis)}.`,
                };
            case 'unassigned':
                return { select: node, text: `${Fmt.money(w.amount, { compact: true })} from ${name} has no link and lands in Unassigned.` };
            case 'cap':
                return { select: node, text: `${name} reaches its yearly limit in ${m(w.month)}; ${Fmt.money(w.amount, { compact: true })} lands in Unassigned.` };
            case 'no-limit':
                return { select: node, text: `${name} charges a share of its limit or the credit left, but has no credit limit set.` };
            case 'utilization':
                return { select: node, text: `${name} uses up to ${Fmt.number(w.amount, 0)}% of its limit. Reducing usage below 30% turns this off.` };
            case 'debt-growing':
                return { select: node, text: `${name} grows by ${Fmt.money(w.amount, { compact: true })}: interest is more than the payments.` };
            case 'loop':
                return {
                    select: { kind: 'node', id: w.nodeIds[0] },
                    text: `Money circles between ${w.nodeIds.map((id) => nameOf(plan, id)).join(', ')}.`,
                };
            case 'runaway':
                return { select: null, text: 'A loop passes all of its money around; some was parked in Unassigned.' };
            default:
                return { select: null, text: w.code };
        }
    }

    window.Describe = {
        CATEGORY_NAME, roleOf, portLabel, linkShort, linkSentence, nodeMeta, monthLabel, warning, warningLevel,
    };
}());
