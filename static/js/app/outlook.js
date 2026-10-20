'use strict';

// ─── outlook.js ─────────────────────────────────────────────────────────────
// The results panel under the canvas: how the plan's money changes over its
// horizon.
//
//   Net worth   accounts stacked above zero, debts below, net worth on top
//   Cash flow   money in against money out, per year (per month under 3 years)
//   Table       year-end balances, and every link's total
//
// The headline figures follow the cursor: hovering a chart scrubs the plan to
// that month (Store.setScrub), which the canvas and inspector follow too.
// "Adjust for inflation" shows every figure in money of the plan's first
// month, deflated at the plan's inflation rate.

(function () {
    const C = window.CitrineCatalog;
    const D = window.Describe;
    const P = window.CitrinePlan;

    const root = document.getElementById('outlook');
    if (!root) return;

    const PREFS = { view: 'outlook-view', height: 'outlook-height', collapsed: 'outlook-collapsed', real: 'outlook-real' };
    const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not persisted */ } };

    let view = read(PREFS.view, 'worth');
    let real = read(PREFS.real, '0') === '1';
    let collapsed = read(PREFS.collapsed, '0') === '1';
    // The plan whose net worth is drawn beside this one, per active plan.
    const compareWith = new Map();
    const compareCache = new Map();   // plan id → { updatedAt, results }
    const LENGTHS = [1, 3, 5, 10, 20, 30];
    // Net worth bands: at most this many per family before the rest fold
    // into "Other". Each band wears its module's role colour (style.css).
    const ACCOUNT_BANDS = 6;
    const DEBT_BANDS = 4;
    const SHADES = 6;   // --chart-<role>-1..6

    root.innerHTML = `
        <div class="outlook-grip" aria-hidden="true"></div>
        <div class="kpis" aria-live="polite"></div>
        <div class="outlook-main">
            <div class="outlook-head">
                <div class="segctl segctl--rules" role="tablist" aria-label="Outlook view">
                    <button class="segctl-btn" type="button" role="tab" data-view="worth">${iconSvg('chart-line')}<span>Net worth</span></button>
                    <button class="segctl-btn" type="button" role="tab" data-view="flow">${iconSvg('chart-bar')}<span>Cash flow</span></button>
                    <button class="segctl-btn" type="button" role="tab" data-view="table">${iconSvg('table')}<span>Table</span></button>
                </div>
                <span class="outlook-spacer"></span>
                <span class="outlook-label">Over</span>
                <div class="segctl segctl--chips" role="group" aria-label="Plan length">
                    ${LENGTHS.map((y) => `<button class="segctl-btn" type="button" data-years="${y}">${y}Y</button>`).join('')}
                </div>
                <button class="button-icon" type="button" data-act="collapse" aria-label="Collapse outlook" title="Collapse">${iconSvg('caret-down')}</button>
            </div>
            <div class="outlook-body">
                <div class="chart-pane">
                    <div class="chart-top">
                        <div class="chart-legend"></div>
                        <button class="button-ghost compare-btn" type="button" data-act="compare" aria-haspopup="menu" aria-pressed="false">${iconSvg('chart-line')}<span>Compare</span></button>
                        <button class="toggle" type="button" data-act="real" aria-pressed="false"><span class="toggle-track" aria-hidden="true"></span>Adjust for inflation</button>
                    </div>
                    <div class="chart-box"></div>
                </div>
                <div class="outlook-table-wrap" hidden></div>
            </div>
        </div>`;

    const kpisEl = root.querySelector('.kpis');
    const pane = root.querySelector('.chart-pane');
    const legendEl = root.querySelector('.chart-legend');
    const box = root.querySelector('.chart-box');
    const tableWrap = root.querySelector('.outlook-table-wrap');
    const realBtn = root.querySelector('[data-act="real"]');

    // ── Values ─────────────────────────────────────────────────────────────

    /** Deflators at the plan's inflation, by balance point k (0..months). */
    function deflator(plan, months) {
        const d = new Float64Array(months + 1);
        const i = real ? (plan.settings.inflation || 0) / 100 : 0;
        for (let k = 0; k <= months; k++) d[k] = i ? Math.pow(1 + i, -k / 12) : 1;
        return d;
    }

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

    /** Ticks along the bottom: Januaries, thinned to at most ~8 labels. */
    function yearTicks(plan, count, offset = 0) {
        const startMonth = P.ymParse(plan.settings.start).m;
        const years = [];
        for (let k = 0; k < count; k++) {
            const cal = ((startMonth - 1 + k + offset) % 12) + 1;
            if (cal === 1) years.push({ i: k, label: String(P.ymParse(P.ymAdd(plan.settings.start, k + offset)).y) });
        }
        const step = Math.ceil(years.length / 8);
        return years.filter((_, i) => i % step === 0);
    }

    // ── Headline figures ───────────────────────────────────────────────────

    function renderKpis(plan, res, def) {
        const scrub = Store.state.scrub;
        const k = scrub == null ? res.months : scrub;
        const sumTo = (arr) => { let s = 0; for (let m = 0; m < k; m++) s += arr[m] * def[m + 1]; return s; };
        const F = res.flows;
        const worth = res.netWorth[k] * def[k];
        const delta = worth - res.netWorth[0];
        const keep = ([, v], i) => i < 1 || Math.abs(v) >= 0.5;
        const income = [
            ['Take-home income', sumTo(F.earned) - sumTo(F.withheld)],
            ['Growth', sumTo(F.growth)],
            ['Cash back and match', sumTo(F.cashback) + sumTo(F.match)],
        ].filter(keep);
        const expenses = [
            ['Spent', sumTo(F.spent)],
            ['Interest paid', sumTo(F.interest)],
            ['Taxes and fees', sumTo(F.skimmed)],
        ].filter(keep);
        const unassigned = res.unassigned[k] * def[k];
        const group = (title, rows) => `
            <section class="kpi-group">
                <h3 class="kpi-head">${title}</h3>
                <dl class="kpi-list">${rows.map(([name, v]) => `
                    <div class="kpi-row"><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(Fmt.money(v))}</dd></div>`).join('')}
                </dl>
            </section>`;
        kpisEl.innerHTML = `
            <div class="kpi-hero">
                <p class="eyebrow">Net worth</p>
                <div class="kpi-hero-value">${escapeHtml(Fmt.money(worth))}</div>
                <div class="kpi-hero-delta ${delta >= 0 ? 'is-up' : 'is-down'}">${escapeHtml(Fmt.money(delta, { sign: true }))}</div>
                <div class="kpi-hero-range">${escapeHtml(label(plan, 0))} to ${escapeHtml(label(plan, k))}</div>
            </div>
            ${group('Income', income)}
            ${group('Expenses', expenses)}
            ${Math.abs(unassigned) >= 0.5 ? group('Unallocated', [['Unassigned', unassigned]]) : ''}`;
    }

    // ── Charts ─────────────────────────────────────────────────────────────

    function legend(items) {
        legendEl.innerHTML = items.map((it) => `<span class="chart-legend-item"><i class="${it.line ? 'is-line' : it.dashed ? 'is-dashed' : ''}" style="--swatch: var(${it.color})"></i>${escapeHtml(it.label)}</span>`).join('');
    }

    /** Another plan's results, simulated once per version of it. */
    function resultsFor(other) {
        const hit = compareCache.get(other.id);
        if (hit && hit.updatedAt === other.updatedAt) return hit.results;
        const results = CitrineEngine.simulate(other);
        compareCache.set(other.id, { updatedAt: other.updatedAt, results });
        return results;
    }

    /** The compared plan's net worth on this plan's months (NaN outside its
     *  own span), deflated the same way. */
    function compareSeries(plan, res, def) {
        const id = compareWith.get(plan.id);
        const other = id && Store.getPlan(id);
        if (!other) return null;
        const r = resultsFor(other);
        const offset = P.ymDiff(other.settings.start, plan.settings.start);
        const values = new Float64Array(res.months + 1);
        for (let k = 0; k <= res.months; k++) {
            const j = k + offset;
            values[k] = j >= 0 && j <= r.months ? r.netWorth[j] * def[k] : NaN;
        }
        return { label: other.name, color: '--text-primary', values };
    }

    function drawWorth(plan, res, def) {
        const bands = worthBands(plan, res, def);
        const worth = balances(res.netWorth, def);
        const ghost = compareSeries(plan, res, def);
        const listed = topDown(bands);
        legend([
            { label: 'Net worth', color: '--chart-worth-line', line: true },
            ...(ghost ? [{ label: ghost.label, color: ghost.color, dashed: true }] : []),
            ...listed,
        ]);
        Chart.draw(box, {
            kind: 'area',
            label: 'Net worth over time',
            count: res.months + 1,
            xTicks: yearTicks(plan, res.months + 1),
            bands,
            line: { label: 'Net worth', color: '--chart-worth-line', values: worth },
            ghost,
            format: (v) => Fmt.money(v, { compact: true }),
            tooltip: (k) => ({
                title: label(plan, k),
                rows: [
                    ...listed.filter((b) => b.values[k] > 0.5).map((b) => ({
                        label: b.label, color: b.color, value: Fmt.money(b.sign < 0 ? -b.values[k] : b.values[k]),
                    })),
                    { label: 'Net worth', color: '--chart-worth-line', value: Fmt.money(worth[k]), total: true },
                    ...(ghost && Number.isFinite(ghost.values[k]) ? [
                        { label: ghost.label, color: ghost.color, value: Fmt.money(ghost.values[k]) },
                        { label: 'Difference', color: null, value: Fmt.money(worth[k] - ghost.values[k], { sign: true }) },
                    ] : []),
                ],
            }),
            onHover: (k) => Store.setScrub(k),
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
                <td>${escapeHtml(D.linkShort(l, from, to))}</td>
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
        root.querySelectorAll('[data-view]').forEach((b) => { b.setAttribute('aria-selected', String(!collapsed && b.dataset.view === view)); b.disabled = collapsed; });
        root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(!!plan && Number(b.dataset.years) === plan.settings.years)));
        realBtn.setAttribute('aria-pressed', String(real));
        const cmp = root.querySelector('[data-act="compare"]');
        const others = plan ? Store.state.tabs.filter((id) => id !== plan.id) : [];
        cmp.hidden = view !== 'worth' || !others.length;
        const on = !!(plan && compareWith.get(plan.id) && Store.getPlan(compareWith.get(plan.id)));
        cmp.setAttribute('aria-pressed', String(on));
        cmp.querySelector('span').textContent = on ? `vs ${Store.planName(compareWith.get(plan.id))}` : 'Compare';
        root.classList.toggle('is-collapsed', collapsed);
        const c = root.querySelector('[data-act="collapse"]');
        c.innerHTML = iconSvg(collapsed ? 'caret-up' : 'caret-down');
        c.setAttribute('aria-label', collapsed ? 'Expand outlook' : 'Collapse outlook');
    }

    function render() {
        renderHead();
        const plan = Store.state.plan;
        const res = Store.state.results;
        if (!plan || !res) return;
        const def = deflator(plan, res.months);
        renderKpis(plan, res, def);
        if (collapsed) return;
        const isTable = view === 'table';
        pane.hidden = isTable;
        tableWrap.hidden = !isTable;
        if (isTable) renderTables(plan, res, def);
        else if (view === 'flow') drawFlow(plan, res, def);
        else drawWorth(plan, res, def);
    }

    function renderKpisOnly() {
        const plan = Store.state.plan;
        const res = Store.state.results;
        if (!plan || !res) return;
        renderKpis(plan, res, deflator(plan, res.months));
    }

    // ── Input ──────────────────────────────────────────────────────────────

    root.addEventListener('click', (e) => {
        const v = e.target.closest('[data-view]');
        if (v) {
            view = v.dataset.view;
            write(PREFS.view, view);
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
        if (act.dataset.act === 'compare') {
            const plan = Store.state.plan;
            const current = compareWith.get(plan.id);
            const items = Store.state.tabs.filter((id) => id !== plan.id).map((id) => ({
                label: Store.planName(id),
                icon: id === current ? 'check' : 'chart-line',
                onSelect: () => { compareWith.set(plan.id, id); render(); },
            }));
            if (current) items.push('sep', { label: 'Stop comparing', icon: 'x', onSelect: () => { compareWith.delete(plan.id); render(); } });
            UI.menu(act, items, { align: 'right' });
            return;
        }
        if (act.dataset.act === 'real') {
            real = !real;
            write(PREFS.real, real ? '1' : '0');
            render();
        } else if (act.dataset.act === 'collapse') {
            collapsed = !collapsed;
            write(PREFS.collapsed, collapsed ? '1' : '0');
            Store.setScrub(null);
            render();
        }
    });

    // Drag the top edge to resize.
    const grip = root.querySelector('.outlook-grip');
    const savedH = Number(read(PREFS.height, '0'));
    if (savedH) root.style.setProperty('--outlook-h', `${savedH}px`);
    grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        root.classList.add('is-resizing');
        const y0 = e.clientY;
        const h0 = root.getBoundingClientRect().height;
        const move = (ev) => {
            const max = Math.max(220, window.innerHeight * 0.7);
            const h = Math.min(max, Math.max(200, h0 - (ev.clientY - y0)));
            root.style.setProperty('--outlook-h', `${Math.round(h)}px`);
        };
        const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            root.classList.remove('is-resizing');
            write(PREFS.height, String(Math.round(root.getBoundingClientRect().height)));
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
    });

    // Redraw when the chart's box changes size (window resize, panel drag,
    // inspector toggle). Coalesced to one draw per frame.
    let resizeQueued = false;
    new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            if (view !== 'table') render();
        });
    }).observe(box);

    Store.on((c) => {
        if (c.type === 'results') render();
        else if (c.type === 'scrub') renderKpisOnly();
        else if (c.type === 'plan' || c.type === 'tabs') renderHead();
    });

    window.Outlook = { render };
}());
