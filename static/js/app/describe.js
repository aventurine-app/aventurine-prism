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

    /** What an account keeps out of the reach of its shares and its rest
     *  (its Keep at least), or 0. Only a balance link is held back by it. */
    function kept(link, from) {
        return link.basis === 'balance' ? from.params.minBalance || 0 : 0;
    }

    /** The label on a link's pill: '20%', '$1,800/mo', 'Rest', 'Above $20K'. */
    function linkShort(link, from) {
        const onArrival = ON_ARRIVAL.has(link.basis);
        const tag = onArrival ? '' : link.basis === 'charges' ? ' of limit' : ' of balance';
        switch (link.mode) {
            case 'percent':
                return `${Fmt.number(link.value, 2)}%${tag}${onArrival ? '' : timingShort(link).replace('/mo', '')}`.trim();
            case 'fixed':
                return `${compact(link.value)}${timingShort(link)}`;
            case 'cost':
                return 'Cost';
            default:
                if (link.basis === 'balance') {
                    const floor = kept(link, from);
                    return `${floor ? `Above ${compact(floor)}` : 'Everything'}${timingShort(link).replace('/mo', ' monthly')}`;
                }
                if (link.basis === 'charges') return 'Credit left';
                if (link.basis === 'proceeds') return 'Proceeds';
                return roleOf(from) === 'debt' ? 'Overpayment' : 'Rest';
        }
    }

    /** A link's rule in a word or two, shown beside its dollars on the
     *  canvas: '20%', 'Rest', 'Above $20K'. A fixed link's rule is its
     *  amount, so it has none. */
    function linkRule(link, from) {
        switch (link.mode) {
            case 'percent': return `${Fmt.number(link.value, 2)}%`;
            case 'rest': {
                const floor = kept(link, from);
                return floor ? `Above ${compact(floor)}` : 'Rest';
            }
            case 'cost':    return 'Cost';
            default:        return null;
        }
    }

    /** What a link's line says on the canvas: the dollars it moves, and the
     *  rule behind them when that is not a fixed amount ('$1,200/mo' and
     *  '20%'). `amount` is one month's flow, or with `perMonth` the plan's
     *  monthly average; over the whole plan a fixed link shows its own amount
     *  and timing instead ('$1,800/mo', '$5K/yr'). */
    function linkFigure(link, from, amount, perMonth) {
        if (link.mode === 'fixed' && perMonth) return { amount: linkShort(link, from), rule: null };
        return { amount: `${compact(amount)}${perMonth ? '/mo' : ''}`, rule: linkRule(link, from) };
    }

    /** The full rule as HTML, numbers and names in <b>. Names are escaped. */
    function linkSentence(link, from, to) {
        const b = (s) => `<b>${escapeHtml(s)}</b>`;
        const pretax = Store.state.plan && P.isPretax(Store.state.plan, link);
        const noun = pretax ? 'pay before tax' : basisNoun(from, link.basis);
        const target = b(to.name);
        const floor = kept(link, from);
        const over = floor ? ` over ${b(Fmt.money(floor))}` : '';
        let what;
        switch (link.mode) {
            case 'percent':
                what = `${b(`${Fmt.number(link.value, 2)}%`)} of the ${noun}${over}`;
                break;
            case 'fixed':
                what = b(Fmt.money(link.value, { decimals: link.value % 1 ? 2 : 0 }));
                break;
            default:
                what = link.basis === 'balance' ? (floor ? `everything${over}` : 'the whole balance')
                    : link.basis === 'charges' ? 'the credit left' : `the rest of the ${noun}`;
        }
        if (link.mode === 'cost') return costSentence(link, from, to);
        // A card's fixed purchase names what it buys; a share of its limit or
        // the credit left is charged to the card for that spending.
        const parts = [link.basis !== 'charges' ? `Send ${what} to ${target}`
            : link.mode === 'fixed' ? `Charge ${what} of ${target} to ${b(from.name)}`
                : `Charge ${what} on ${b(from.name)} for ${target}`];
        const onArrival = ON_ARRIVAL.has(link.basis) && !(link.basis === 'inflow' && link.mode === 'fixed');
        // A percent or rest already says "of the pay before tax".
        if (pretax && link.mode === 'fixed') parts.push('before tax');
        // Any other share of a paycheck is withheld on its way out (engine.js).
        else if (!pretax && link.mode === 'percent' && link.basis === 'inflow' && roleOf(from) === 'source'
            && from.params.tax > 0) parts.push(`less ${b(`${Fmt.number(from.params.tax, 2)}%`)} withholding`);
        if (!onArrival) parts.push(timingWords(link));
        if (link.mode === 'fixed' && link.growth) parts.push(`growing ${b(`${Fmt.number(link.growth, 2)}%`)} a year`);
        if (link.start && link.end) parts.push(`from ${P.ymLabel(link.start)} to ${P.ymLabel(link.end)}`);
        else if (link.start) parts.push(`starting ${P.ymLabel(link.start)}`);
        else if (link.end) parts.push(`until ${P.ymLabel(link.end)}`);
        return `${parts.join(', ')}.`;
    }

    /** A link paying an expense's own cost, as a sentence: the cost and its
     *  schedule are the expense's. */
    function costSentence(link, from, to) {
        const b = (s) => `<b>${escapeHtml(s)}</b>`;
        const v = to.params;
        const pay = link.basis === 'charges'
            ? `Charge the cost of ${b(to.name)} to ${b(from.name)}` : `Pay the cost of ${b(to.name)}`;
        if (v.cost == null) return `${pay}. ${escapeHtml(to.name)} has no cost set yet.`;
        const parts = [`${pay}: ${b(Fmt.money(v.cost, { decimals: v.cost % 1 ? 2 : 0 }))} ${scheduleWords(v)}`];
        if (v.growth && v.per !== 'once') parts.push(`rising ${b(`${Fmt.number(v.growth, 2)}%`)} a year`);
        if (link.start && link.end) parts.push(`from ${P.ymLabel(link.start)} to ${P.ymLabel(link.end)}`);
        else if (link.start) parts.push(`starting ${P.ymLabel(link.start)}`);
        else if (link.end) parts.push(`until ${P.ymLabel(link.end)}`);
        return `${parts.join(', ')}.`;
    }

    /** How often a module's amount falls due, as words: 'a month', 'every March'. */
    function scheduleWords(v) {
        switch (v.per) {
            case 'week':   return 'a week';
            case 'biweek': return 'every 2 weeks';
            case 'year':   return v.payMonth ? `every ${MONTH_NAMES[v.payMonth - 1]}` : 'a year';
            case 'once':   return v.start ? `once, in ${P.ymLabel(v.start)}` : 'once';
            default:       return 'a month';
        }
    }

    const PER_WORD = { week: '/wk', biweek: ' every 2 weeks', month: '/mo', year: '/yr' };

    /** A scheduled amount in short: '$65K/yr', '$1,800/mo in March', 'Jun 2028'. */
    function scheduleShort(v, amount) {
        if (v.per === 'once') return `${compact(amount)} · ${v.start ? P.ymLabel(v.start) : 'once'}`;
        const lump = v.per === 'year' && v.payMonth ? ` in ${P.MONTHS[v.payMonth - 1]}` : '';
        return `${compact(amount)}${PER_WORD[v.per]}${lump}`;
    }

    /** A module's defining figure as a badge: '4% APY', '24% APR', '2% back'. */
    function nodeBadge(node) {
        const p = presetOf(node);
        const r = node.params.rate;
        switch (p.role) {
            case 'account': {
                const label = C.fieldLabel(p, 'rate');
                const word = label === 'APY' ? 'APY' : label === 'Interest' ? 'interest' : 'return';
                const growth = r ? `${Fmt.pct(r)} ${word}` : '';
                const match = p.employerMatch && node.params.match ? `${Fmt.pct(node.params.match)} match` : '';
                const keeps = node.params.minBalance ? `keeps ${compact(node.params.minBalance)}` : '';
                const taxed = p.taxChoice ? (node.params.contributions === 'pre' ? 'pre-tax' : 'after-tax') : '';
                const badge = [growth, match, taxed, keeps].filter(Boolean).join(' · ');
                return badge.charAt(0).toUpperCase() + badge.slice(1);
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
            return scheduleShort(v, v.amount);
        }
        if (p.role === 'expense') {
            const v = node.params;
            if (v.cost == null) return '';
            const inflation = v.growth && v.per !== 'once' ? ` · ${Fmt.pct(v.growth)} inflation` : '';
            return `${scheduleShort(v, v.cost)}${inflation}`;
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

    // How loud a warning is. A card's high utilization and an expense's cost
    // that no link pays are notices (not a problem yet) and money parked in
    // Unassigned is information; every other warning is a warning.
    const WARNING_LEVEL = { unassigned: 'info', utilization: 'notice', 'cost-unpaid': 'notice' };

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
            case 'overdrawn':
                return { select: node, text: `${name} goes below zero in ${m(w.month)}.` };
            case 'cost-unpaid':
                return { select: node, text: `${name} has a cost, but no link pays it. Set a link into it to Cost.` };
            case 'below-minimum':
                return { select: node, text: `${name} goes below the ${Fmt.money(w.amount, { compact: true })} it keeps in ${m(w.month)}.` };
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

    /** A debt's payoff as a sentence, plus the debt to select. Paid off
     *  during month m, as the plan's issues are dated. */
    function payoff(ms, plan) {
        return { level: 'done', select: { kind: 'node', id: ms.nodeId }, text: `${nameOf(plan, ms.nodeId)} is paid off in ${monthLabel(plan, ms.month)}.` };
    }

    // ── Goals ──────────────────────────────────────────────────────────────
    // A goal reads as one sentence: its measure, its comparison, its target
    // and its deadline ("Net worth is at least 25 × yearly expenses by age
    // 65"). Each part's words are here, so the goal builder and anything that
    // names a goal say it the same way.

    // Each measure: its name at the head of a rule, its name after "of",
    // whether it is plural (so the rule says "are"), and its icon. In the
    // order the builder offers them.
    const GOAL_METRICS = {
        'net-worth': { label: 'Net worth', of: 'net worth', icon: 'chart-line-up' },
        'savings':   { label: 'Account balance', of: 'account balance', icon: 'bank' },
        'debt':      { label: 'Debt', of: 'debt', icon: 'credit-card' },
        'expenses':  { label: 'Yearly expenses', of: 'yearly expenses', plural: true, icon: 'shopping-cart' },
        'income':    { label: 'Yearly income', of: 'yearly income', icon: 'briefcase' },
    };
    const GOAL_OPS = {
        gte: { words: 'at least', icon: 'greater-than-or-equal' },
        lte: { words: 'at most', icon: 'less-than-or-equal' },
    };
    // The names of the colours a goal's card can be (plan.js, GOAL_COLORS).
    const GOAL_COLORS = {
        lapis: 'Lapis', tourmaline: 'Tourmaline', 'tigers-eye': 'Tiger\'s eye', garnet: 'Garnet',
        tanzanite: 'Tanzanite', amber: 'Amber', rhodolite: 'Rhodolite', emerald: 'Emerald',
    };

    /** '7 months', '2 years', '1 year 3 months'. */
    function duration(months) {
        const y = Math.floor(months / 12);
        const m = months % 12;
        const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        return [y ? part(y, 'year') : '', m || !y ? part(m, 'month') : ''].filter(Boolean).join(' ');
    }

    /** A goal's comparison in words, agreeing with its measure: 'is at least', 'are at most'. */
    function goalOp(goal) {
        return `${GOAL_METRICS[goal.metric].plural ? 'are' : 'is'} ${GOAL_OPS[goal.op].words}`;
    }

    /** A goal's target in words: '$20,000', '25 × yearly expenses', '40% of yearly income'. */
    function goalTarget(goal) {
        if (goal.unit === 'amount') return Fmt.money(goal.value);
        const of = GOAL_METRICS[goal.of].of;
        return goal.unit === 'percent' ? `${Fmt.number(goal.value, 2)}% of ${of}` : `${Fmt.number(goal.value, 2)} × ${of}`;
    }

    /** A goal's deadline in words: 'by Mar 2040', 'by age 65'. */
    function goalDue(goal) {
        if (goal.due === 'age') return `by age ${Fmt.number(goal.age, 1)}`;
        return `by ${P.ymLabel(goal.by)}`;
    }

    /** A goal's rule as a sentence: 'Net worth is at least 25 × yearly expenses by age 65.' */
    function goalSentence(goal) {
        return `${GOAL_METRICS[goal.metric].label} ${goalOp(goal)} ${goalTarget(goal)} ${goalDue(goal)}.`;
    }

    // Why a goal cannot be measured in a plan, as what to do about it.
    const BLOCKED = {
        'no-age': 'Set your age in the plan details to date it',
        'no-income': 'Add income to measure',
        'no-expenses': 'Add spending to measure',
    };

    /** A goal's status: `text` in a few words, an optional `detail` beside its
     *  date, and its tone: 'positive' (met on time), 'warning' (met late),
     *  'negative' (not met by its deadline) or 'muted' (cannot tell yet).
     *  `ev` is one of CitrineGoals.evaluate's results; `months` is the plan's
     *  length. */
    function goalStatus(ev, plan, months) {
        if (ev.blocked) return { tone: 'muted', text: BLOCKED[ev.blocked] || 'Cannot measure yet', detail: null };
        if (ev.status === 'reached') {
            if (ev.month === 0) return { tone: 'positive', text: 'Met already', detail: null };
            const ahead = ev.byIdx != null && ev.byIdx >= 0 ? ev.byIdx - ev.month : null;
            return {
                tone: 'positive',
                text: `Met ${monthLabel(plan, ev.month)}`,
                detail: ahead == null ? null : ahead === 0 ? 'Right on time' : `${duration(ahead)} early`,
            };
        }
        if (ev.status === 'late') {
            return { tone: 'warning', text: `Met ${monthLabel(plan, ev.month)}`, detail: `${duration(ev.month - ev.byIdx)} late` };
        }
        // Due after the plan's end: lengthening the plan would tell.
        if (ev.status === 'open' && ev.byIdx != null && ev.byIdx > months) {
            return { tone: 'muted', text: 'Due after the plan ends', detail: monthLabel(plan, ev.byIdx) };
        }
        if (ev.status === 'behind') return { tone: 'negative', text: 'Not met', detail: `due ${monthLabel(plan, ev.byIdx)}` };
        return { tone: 'muted', text: 'Not met', detail: `by ${monthLabel(plan, months)}` };
    }

    window.Describe = {
        CATEGORY_NAME, roleOf, portLabel, linkShort, linkFigure, linkSentence, nodeMeta, monthLabel, warning, warningLevel, payoff,
        GOAL_METRICS, GOAL_OPS, GOAL_COLORS, duration, goalOp, goalTarget, goalDue, goalSentence, goalStatus,
    };
}());
