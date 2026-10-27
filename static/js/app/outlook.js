'use strict';

// ─── outlook.js ─────────────────────────────────────────────────────────────
// The Analyze workspace: how one plan's money changes over its horizon. The
// plan is the open one; the dropdown in the header row opens another.
//
//   Net worth   bars of accounts stacked above zero, debts below, net worth
//               on top (monthly on short plans, thinning to yearly)
//   Cash flow   money in against money out, per year (per month under 3 years)
//   Sankey      where one year's money (or the whole plan's) came from and
//               where it went: into spending, taxes, debts and accounts,
//               then module by module (sankey.js)
//   Table       year-end balances, and every link's total
//
// The Net worth chart flags each goal (set in the Goals workspace) the plan
// reaches.
//
// Hovering a chart scrubs the plan to that month (Store.setScrub), which the
// canvas and inspector follow. The Net worth chart has no legend row: its
// tooltip names every band. Money is
// shown as of its own month (Compare's "Leave behind" is the place that
// reckons in today's money).

(function () {
    const C = window.CitrineCatalog;
    const D = window.Describe;
    const P = window.CitrinePlan;
    const G = window.CitrineGoals;

    const root = document.getElementById('outlook');
    if (!root) return;

    const PREFS = { view: 'outlook-view' };

    const VIEWS = [['worth', 'chart-line', 'Net worth'], ['flow', 'chart-bar', 'Cash flow'], ['sankey', 'flow-arrow', 'Sankey'],
        ['table', 'table', 'Table']];
    let view = Prefs.get(PREFS.view, 'worth');
    if (!VIEWS.some(([v]) => v === view)) view = 'worth';
    const LENGTHS = [1, 3, 5, 10, 20, 30, 40];
    // Net worth bands: at most this many per family before the rest fold
    // into "Other". Each band wears its module's role colour (style.css).
    const ACCOUNT_BANDS = 6;
    const DEBT_BANDS = 4;
    const SHADES = 6;   // --chart-<role>-1..6
    // The Sankey's span: a plan year (0-based), or -1 for the whole plan.
    let sankeyYear = 0;
    const SANKEY_IN = [1, 2, 3, 4, 5, 6].map((i) => `--chart-inflow-${i}`);
    const SANKEY_OUT = [1, 2, 3, 4, 5].map((i) => `--chart-outflow-${i}`);
    const SANKEY_FEES = [1, 2, 3, 4].map((i) => `--chart-fee-${i}`);
    const SANKEY_DEBTS = [1, 2, 3, 4, 5, 6].map((i) => `--chart-debt-${i}`);
    const SANKEY_ACCOUNTS = [1, 2, 3, 4, 5, 6].map((i) => `--chart-account-${i}`);

    root.innerHTML = `
        <div class="outlook-main">
            <div class="outlook-head">
                <div class="segctl outlook-views" role="tablist" aria-label="Analyze view">
                    ${VIEWS.map(([v, icon, name]) =>
                        `<button class="segctl-btn" type="button" role="tab" data-view="${v}" aria-label="${name}" title="${name}">${iconSvg(icon)}<span>${name}</span></button>`).join('')}
                </div>
                <button class="field-select plan-pick" type="button" data-act="plan" aria-haspopup="menu" aria-expanded="false" title="Analyze another plan">
                    ${iconSvg('file')}<span class="plan-pick-name"></span>${iconSvg('caret-down', { cls: 'plan-pick-caret' })}</button>
                <div class="outlook-length">
                    <span class="outlook-label">Over</span>
                    <div class="segctl segctl--chips" role="group" aria-label="Plan length">
                        ${LENGTHS.map((y) => `<button class="segctl-btn" type="button" data-years="${y}">${y}Y</button>`).join('')}
                    </div>
                </div>
            </div>
            <div class="outlook-body">
                <div class="chart-pane">
                    <div class="chart-top">
                        <button class="button-ghost span-btn" type="button" data-act="span" aria-haspopup="menu" hidden>${iconSvg('calendar-blank')}<span></span>${iconSvg('caret-down')}</button>
                        <div class="chart-legend"></div>
                    </div>
                    <div class="chart-box"></div>
                </div>
                <div class="outlook-table-wrap scroll-y" hidden></div>
            </div>
        </div>`;

    const planBtn = root.querySelector('[data-act="plan"]');
    const pane = root.querySelector('.chart-pane');
    const legendEl = root.querySelector('.chart-legend');
    const box = root.querySelector('.chart-box');
    const tableWrap = root.querySelector('.outlook-table-wrap');
    const chartTop = root.querySelector('.chart-top');
    const spanBtn = root.querySelector('[data-act="span"]');

    // Analyze draws only while it is the open workspace.
    const showing = () => Store.state.workspace === 'analyze';

    // ── Values ─────────────────────────────────────────────────────────────

    /** The factor each balance point's money is shown at: 1 throughout, as
     *  Analyze shows money as of its own month. Every figure reads through
     *  these, so a way to show today's money would go here. */
    const deflator = (plan, months) => G.deflator(plan, months, false);

    const balances = (arr, def) => Float64Array.from(arr, (v, k) => v * def[k]);
    // A month's flow lands at the end of that month: balance point m + 1.
    const flows = (arr, def) => Float64Array.from(arr, (v, m) => v * def[m + 1]);

    const label = (plan, k) => D.monthLabel(plan, k);

    /** Bands as the chart shows them, top to bottom. They stack away from
     *  zero in array order, so that is the positives reversed, then the debts. */
    const topDown = (bands) => [...bands.filter((b) => b.sign > 0).reverse(), ...bands.filter((b) => b.sign < 0)];

    /** Account and debt bands in module order (never by size), folded into
     *  an "other" band past each family's limit. Each band wears its module's
     *  role colour (accounts blue, debts red); several of one role take
     *  successive shades of it. */
    function worthBands(plan, res, def) {
        const bands = [];
        const accounts = plan.nodes.filter((n) => D.roleOf(n) === 'account');
        const debts = plan.nodes.filter((n) => D.roleOf(n) === 'debt');
        const fold = (list, limit, sign, otherLabel) => {
            list.forEach((n, i) => {
                const values = balances(res.nodes[n.id].balance, def);
                if (i < limit - 1 || list.length === limit) {
                    bands.push({ label: n.name, values, sign, id: n.id, role: D.roleOf(n) });
                } else if (i === limit - 1) {
                    bands.push({ label: otherLabel, values: Float64Array.from(values), sign, other: true });
                } else {
                    const other = bands[bands.length - 1];
                    for (let k = 0; k < values.length; k++) other.values[k] += values[k];
                }
            });
        };
        fold(accounts, ACCOUNT_BANDS, 1, 'Other accounts');
        if (res.unassigned.some((v) => v > 0.005)) {
            bands.push({ label: 'Unassigned', values: balances(res.unassigned, def), sign: 1 });
        }
        fold(debts, DEBT_BANDS, -1, 'Other debts');
        const used = {};
        for (const b of bands) {
            if (!b.role) { b.color = '--chart-unassigned'; continue; }
            used[b.role] = (used[b.role] || 0) + 1;
            b.color = `--chart-${b.role}-${((used[b.role] - 1) % SHADES) + 1}`;
        }
        return bands;
    }

    // ── Charts ─────────────────────────────────────────────────────────────

    function legend(items) {
        legendEl.innerHTML = items.map((it) => `<span class="chart-legend-item"><i class="${it.line ? 'is-line' : ''}" style="--swatch: var(${it.color})"></i>${escapeHtml(it.label)}</span>`).join('');
    }

    /** Month indices the net worth bars sample: every month on short plans,
     *  thinning to quarterly, half-yearly or yearly so there are at most
     *  ~40 bars. Always ends on the plan's last month. */
    function worthSamples(months) {
        const step = [1, 3, 6, 12].find((s) => Math.ceil(months / s) + 1 <= 40) || 12;
        const idx = [];
        for (let k = 0; k < months; k += step) idx.push(k);
        idx.push(months);
        return idx;
    }

    /** Bar ticks: each sample that starts a new calendar year (the first only
     *  if it is a January), thinned to at most ~8 labels. */
    function sampleTicks(plan, idx) {
        const ticks = [];
        let prev = null;
        idx.forEach((k, i) => {
            const { y, m } = P.ymParse(P.ymAdd(plan.settings.start, k));
            if (i === 0 ? m === 1 : y !== prev) ticks.push({ i, label: String(y) });
            prev = y;
        });
        const step = Math.ceil(ticks.length / 8);
        return ticks.filter((_, i) => i % step === 0);
    }

    /** A flag for each goal the plan meets after its start, on the first bar
     *  that shows it met: its badge in the goal's card colour, whose white
     *  text it is made for, its rule in the chart shade of it. Goals met from
     *  the start are not events; one met after its deadline says so. */
    function goalMarkers(plan, res, idx) {
        const goals = Store.state.goals;
        if (!goals.length) return [];
        const evs = G.evaluate(plan, res, goals);
        const out = [];
        goals.forEach((g, n) => {
            const ev = evs[n];
            if (!ev.month) return;
            const late = ev.status === 'late';
            out.push({
                i: idx.findIndex((k) => k >= ev.month), month: ev.month, name: g.name, late,
                label: late ? `${g.name} (late)` : g.name,
                color: `--goal-${g.color}-mark`,
                fill: `--goal-${g.color}`,
            });
        });
        return out;
    }

    function drawWorth(plan, res, def) {
        const idx = worthSamples(res.months);
        const pick = (values) => Float64Array.from(idx, (k) => values[k]);
        const bands = worthBands(plan, res, def).map((b) => ({ ...b, values: pick(b.values) }));
        const worth = pick(balances(res.netWorth, def));
        const markers = goalMarkers(plan, res, idx);
        const listed = topDown(bands);
        Chart.draw(box, {
            kind: 'bars',
            label: 'Net worth over time',
            count: idx.length,
            xTicks: sampleTicks(plan, idx),
            bars: bands,
            gap: 0,
            line: { label: 'Net worth', color: '--chart-worth-line', values: worth },
            markers,
            format: (v) => Fmt.money(v, { compact: true }),
            tooltip: (k) => ({
                title: label(plan, idx[k]),
                rows: [
                    ...listed.filter((b) => b.values[k] > 0.5).map((b) => ({
                        label: b.label, color: b.color, value: Fmt.money(b.sign < 0 ? -b.values[k] : b.values[k]),
                    })),
                    { label: 'Net worth', color: '--chart-worth-line', value: Fmt.money(worth[k]), total: true },
                    ...markers.filter((mk) => mk.i === k).map((mk) => ({
                        label: `${mk.name} met${mk.late ? ' late' : ''}`, color: mk.color, value: label(plan, mk.month),
                    })),
                ],
            }),
            onHover: (k) => Store.setScrub(k == null ? null : idx[k]),
        });
    }

    function drawFlow(plan, res, def) {
        const F = res.flows;
        const months = res.months;
        const yearly = plan.settings.years >= 3;
        const size = yearly ? 12 : 1;
        const count = Math.ceil(months / size);
        const agg = (fn) => {
            const out = new Float64Array(count);
            for (let m = 0; m < months; m++) out[Math.floor(m / size)] += fn(m) * def[m + 1];
            return out;
        };
        const income = agg((m) => F.earned[m] - F.withheld[m] + F.match[m] + F.cashback[m]);
        const growth = agg((m) => Math.max(0, F.growth[m]));
        const spent = agg((m) => F.spent[m] + F.skimmed[m]);
        const cost = agg((m) => F.interest[m] + Math.max(0, -F.growth[m]));
        const net = Float64Array.from(income, (v, i) => v + growth[i] - spent[i] - cost[i]);
        const bars = [
            { label: 'Income', color: '--chart-in', values: income, sign: 1 },
            { label: 'Growth', color: '--chart-growth', values: growth, sign: 1 },
            { label: 'Spending', color: '--chart-out', values: spent, sign: -1 },
            { label: 'Interest and losses', color: '--chart-interest', values: cost, sign: -1 },
        ].filter((b) => b.values.some((v) => v > 0.5));
        legend([...bars, { label: 'Net change', color: '--chart-networth', line: true }]);
        const periodLabel = (i) => yearly
            ? `${label(plan, i * 12)} to ${label(plan, Math.min(months, (i + 1) * 12) - 1)}`
            : label(plan, i);
        const ticks = yearly
            ? Array.from({ length: count }, (_, i) => ({ i, label: `Y${i + 1}` })).filter((_, i) => count <= 12 || i % Math.ceil(count / 10) === 0)
            : Array.from({ length: count }, (_, i) => ({ i, label: P.MONTHS[P.ymParse(P.ymAdd(plan.settings.start, i)).m - 1] })).filter((_, i) => i % 3 === 0);
        Chart.draw(box, {
            kind: 'bars',
            label: 'Cash flow by period',
            count,
            xTicks: ticks,
            bars,
            line: { label: 'Net change', color: '--chart-networth', values: net },
            format: (v) => Fmt.money(v, { compact: true }),
            tooltip: (i) => ({
                title: periodLabel(i),
                rows: [
                    ...bars.map((b) => ({ label: b.label, color: b.color, value: Fmt.money(b.sign < 0 ? -b.values[i] : b.values[i]) })),
                    { label: 'Net change', color: '--chart-networth', value: Fmt.money(net[i], { sign: true }), total: true },
                ],
            }),
            onHover: (i) => Store.setScrub(i == null ? null : Math.min(months, (i + 1) * size)),
        });
    }

    // ── Sankey ─────────────────────────────────────────────────────────────

    /** The spans the Sankey offers: each plan year, then the whole plan. */
    function sankeySpans(plan, months) {
        const spans = [];
        for (let from = 0; from < months; from += 12) {
            const to = Math.min(months, from + 12);
            spans.push({ year: spans.length, from, to, label: `${label(plan, from)} to ${label(plan, to - 1)}` });
        }
        if (spans.length > 1) spans.push({ year: -1, from: 0, to: months, label: `All ${spans.length} years` });
        return spans;
    }

    /** The chosen span; a year past a shortened plan (or the whole of a
     *  one-year plan) falls back to its last year. */
    function currentSpan(plan, months) {
        const spans = sankeySpans(plan, months);
        const years = spans.filter((s) => s.year >= 0);
        return spans.find((s) => s.year === sankeyYear) || years[years.length - 1];
    }

    /** Where the money in months [from, to) came from and where it went.
     *
     *  In: gross income, match, cash back and account growth, plus money drawn
     *  back out of an account or borrowed on a debt over the span.
     *  Out, in groups: spending, taxes and fees (withholding included),
     *  debts (interest, fees and principal paid down), what each account
     *  kept, and losses.
     *
     *  A balance's part is its change over the span, so the two sides agree
     *  to the cent: net worth is accounts + Unassigned - debts, and the
     *  engine's conservation rule makes the flows explain its change. Each
     *  month's step is deflated like that month's flows, which keeps the
     *  identity whatever factor the money is shown at. */
    function sankeyFlows(plan, res, def, from, to) {
        const total = (arr) => {
            let s = 0;
            if (arr) for (let m = from; m < to; m++) s += arr[m] * def[m + 1];
            return s;
        };
        const change = (bal) => {
            let s = 0;
            for (let m = from; m < to; m++) s += (bal[m + 1] - bal[m]) * def[m + 1];
            return s;
        };
        const left = [];
        const group = (name, color, ramp) => ({ label: name, color, ramp, items: [] });
        const spending = group('Spending', '--chart-outflow-1', SANKEY_OUT);
        const fees = group('Taxes and fees', '--chart-fee-1', SANKEY_FEES);
        const debts = group('Debts', '--chart-debt-1', SANKEY_DEBTS);
        const losses = group('Losses', '--chart-interest', SANKEY_DEBTS);
        const accounts = group('Accounts', '--chart-account-1', SANKEY_ACCOUNTS);
        const add = (list, name, value, id, extra) => { if (value > 0.005) list.push({ label: name, value, id, ...extra }); };
        const money = (v) => Fmt.money(v);

        for (const n of plan.nodes) {
            const r = res.nodes[n.id];
            if (!r) continue;
            switch (D.roleOf(n)) {
                case 'source': {
                    // Gross pay in; what is withheld goes out again as a tax.
                    const gross = total(r.gross);
                    const withheld = gross - total(r.produced);
                    add(left, n.name, gross, n.id, withheld > 0.5 ? { note: `Withheld ${money(withheld)}` } : null);
                    add(fees.items, `${n.name} withholding`, withheld, n.id);
                    break;
                }
                case 'expense':
                    add(spending.items, n.name, total(r.consumed), n.id);
                    break;
                case 'modifier':
                    // What a budget group keeps is spending; a skim's cut is a tax or fee.
                    add((r.kind === 'group' ? spending : fees).items, n.name, total(r.consumed), n.id);
                    break;
                case 'account': {
                    add(left, `${n.name} match`, total(r.matched), n.id);
                    const growth = total(r.earnings);
                    if (growth >= 0) add(left, `${n.name} growth`, growth, n.id);
                    else add(losses.items, n.name, -growth, n.id);
                    const kept = change(r.balance);
                    if (kept >= 0) add(accounts.items, n.name, kept, n.id);
                    else add(left, `From ${n.name}`, -kept, n.id, { color: '--chart-account-1', pinned: true });
                    break;
                }
                case 'debt': {
                    add(left, `${n.name} cash back`, total(r.cashback), n.id);
                    const interest = total(r.interest);
                    const fee = total(r.fees);
                    const paidDown = -change(r.balance);
                    const note = [['Interest', interest], ['Fees', fee], ['Paid down', paidDown]]
                        .filter(([, v]) => v > 0.5).map(([k, v]) => `${k} ${money(v)}`).join(', ');
                    add(debts.items, n.name, interest + fee + Math.max(0, paidDown), n.id, { note });
                    if (paidDown < 0) add(left, `Borrowed on ${n.name}`, -paidDown, n.id, { color: '--chart-debt-1', pinned: true });
                    break;
                }
            }
        }
        const pool = change(res.unassigned);
        if (pool >= 0) add(accounts.items, 'Unassigned', pool, null, { color: '--chart-unassigned' });
        else add(left, 'From Unassigned', -pool, null, { color: '--chart-unassigned', pinned: true });

        return { left, groups: [spending, fees, debts, losses, accounts] };
    }

    function drawSankey(plan, res, def) {
        const span = currentSpan(plan, res.months);
        spanBtn.querySelector('span').textContent = span.label;
        legend([]);
        const { left, groups } = sankeyFlows(plan, res, def, span.from, span.to);
        Sankey.draw(box, {
            label: `Where the money came from and went, ${span.label}`,
            left,
            groups,
            inRamp: SANKEY_IN,
            hubLabel: 'Money in',
            hubColor: '--chart-net',
            otherLabel: 'Other',
            format: (v) => Fmt.money(v),
            empty: 'Add income and spending to see where the money goes.',
            onSelect: (id) => Store.select({ kind: 'node', id }),
        });
    }

    // ── Tables ─────────────────────────────────────────────────────────────

    function renderTables(plan, res, def) {
        const months = res.months;
        const points = [0];
        for (let k = 12; k <= months; k += 12) points.push(k);
        if (points[points.length - 1] !== months) points.push(months);
        const holders = plan.nodes.filter((n) => C.ROLES[D.roleOf(n)].holds);
        const cell = (v, neg) => `<td class="${neg && v > 0.5 ? 'is-negative' : ''}">${escapeHtml(Fmt.money(neg ? -v : v))}</td>`;
        const nameCell = (n) => `<td><span class="cell-name"><span class="role-tile role-tile--sm" data-role="${D.roleOf(n)}">${iconSvg(P.iconOf(n))}</span>${escapeHtml(n.name)}</span></td>`;
        let html = `<table class="outlook-table"><caption class="sr-only">Balances</caption><thead><tr><th>Balance</th>${points.map((k) => `<th>${escapeHtml(label(plan, k))}</th>`).join('')}</tr></thead><tbody>`;
        for (const n of holders) {
            const b = res.nodes[n.id].balance;
            const neg = D.roleOf(n) === 'debt';
            html += `<tr>${nameCell(n)}${points.map((k) => cell(b[k] * def[k], neg)).join('')}</tr>`;
        }
        if (res.unassigned.some((v) => v > 0.005)) {
            html += `<tr><td>Unassigned</td>${points.map((k) => cell(res.unassigned[k] * def[k], false)).join('')}</tr>`;
        }
        html += `<tr class="is-total"><td>Net worth</td>${points.map((k) => `<td>${escapeHtml(Fmt.money(res.netWorth[k] * def[k]))}</td>`).join('')}</tr></tbody></table>`;

        const linksSorted = plan.links
            .map((l) => ({ l, r: res.links[l.id] }))
            .filter((x) => x.r)
            .sort((a, b) => b.r.total - a.r.total);
        html += `<table class="outlook-table"><caption class="sr-only">Money moved</caption><thead><tr><th>Money moved</th><th>Rule</th><th>Total</th><th>Average a month</th><th>First</th><th>Last</th></tr></thead><tbody>`;
        for (const { l, r } of linksSorted) {
            const from = Store.node(l.from);
            const to = Store.node(l.to);
            const flowsDef = flows(r.flow, def);
            const total = flowsDef.reduce((a, b) => a + b, 0);
            const first = r.flow.findIndex((v) => v > 0.005);
            let lastIdx = -1;
            for (let m = r.flow.length - 1; m >= 0; m--) if (r.flow[m] > 0.005) { lastIdx = m; break; }
            html += `<tr><td>${escapeHtml(from.name)} → ${escapeHtml(to.name)}</td>
                <td>${escapeHtml(D.linkShort(l, from))}</td>
                <td>${escapeHtml(Fmt.money(total))}</td>
                <td>${escapeHtml(Fmt.money(total / months))}</td>
                <td>${first >= 0 ? escapeHtml(label(plan, first)) : 'Never'}</td>
                <td>${lastIdx >= 0 ? escapeHtml(label(plan, lastIdx)) : 'Never'}</td></tr>`;
        }
        html += '</tbody></table>';
        tableWrap.innerHTML = html;
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function renderHead() {
        const plan = Store.state.plan;
        const { activeId } = Store.state;
        const name = activeId ? Store.planName(activeId) : '';
        planBtn.querySelector('.plan-pick-name').textContent = name;
        planBtn.setAttribute('aria-label', `Plan: ${name}`);
        root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
        root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(!!plan && Number(b.dataset.years) === plan.settings.years)));
        // The Net worth chart needs no row above it: its tooltip names every band.
        chartTop.hidden = view === 'worth';
        spanBtn.hidden = view !== 'sankey';
        pane.classList.toggle('is-sankey', view === 'sankey');
    }

    function render() {
        if (!showing()) return;
        renderHead();
        const plan = Store.state.plan;
        const res = Store.state.results;
        if (!plan || !res) return;
        // A redraw (a resize) can land in the frame between an edit that adds a
        // module and its run; the run that follows draws it.
        if (plan.nodes.some((n) => !res.nodes[n.id])) return;
        const def = deflator(plan, res.months);
        const isTable = view === 'table';
        pane.hidden = isTable;
        tableWrap.hidden = !isTable;
        if (isTable) renderTables(plan, res, def);
        else if (view === 'flow') drawFlow(plan, res, def);
        else if (view === 'sankey') drawSankey(plan, res, def);
        else drawWorth(plan, res, def);
    }

    // ── Input ──────────────────────────────────────────────────────────────

    root.addEventListener('click', (e) => {
        const v = e.target.closest('[data-view]');
        if (v) {
            view = v.dataset.view;
            Prefs.set(PREFS.view, view);
            Store.setScrub(null);
            render();
            return;
        }
        const y = e.target.closest('[data-years]');
        if (y) {
            const years = Number(y.dataset.years);
            Store.edit((plan) => { plan.settings.years = years; });
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        switch (act.dataset.act) {
            case 'plan': {
                const { tabs, activeId } = Store.state;
                UI.menu(act, tabs.map((id) => ({
                    label: Store.planName(id),
                    icon: id === activeId ? 'check' : 'file',
                    onSelect: () => Store.openPlan(id),
                })));
                return;
            }
            case 'span': {
                const plan = Store.state.plan;
                const res = Store.state.results;
                if (!plan || !res) return;
                const current = currentSpan(plan, res.months);
                const items = sankeySpans(plan, res.months).map((s) => ({
                    label: s.label,
                    icon: s.year === current.year ? 'check' : 'calendar-blank',
                    onSelect: () => { sankeyYear = s.year; render(); },
                }));
                if (items.length > 1) items.splice(items.length - 1, 0, 'sep');
                UI.menu(act, items);
                return;
            }
        }
    });

    // Redraw when the chart's box changes size (window resize, the navigation
    // or inspector toggled). Coalesced to one draw per frame.
    let resizeQueued = false;
    new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            if (view !== 'table') render();
        });
    }).observe(box);

    // Goals redraw the Net worth chart, which flags the ones reached.
    Store.on((c) => {
        if (c.type === 'results' || c.type === 'goals' || c.type === 'workspace') render();
        else if (!showing()) return;
        else if (c.type === 'plan' || c.type === 'tabs') renderHead();
    });

    window.Outlook = { render };
}());
