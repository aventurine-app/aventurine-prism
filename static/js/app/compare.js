'use strict';

// ─── compare.js ─────────────────────────────────────────────────────────────
// The Compare workspace: every plan side by side, one row each, all run over
// the same length (the Over dropdown, kept in Prefs) from each plan's own
// start. The plans themselves keep their lengths: Compare runs a copy
// (Runs.all({ years })).
//
//   Net worth     at the end
//   Growth        over the whole run: what accounts earn, plus card cash back
//   Debt payoff   how long until nothing is owed for the rest of the run:
//                 "No debt" when nothing ever is, "Not paid off" when debt
//                 is still owed at the end
//   Taxes paid    over the whole run: income tax withheld, plus what Tax or
//                 fee modules take (a card's annual fee is a fee, not a tax,
//                 so it is left out)
//
// Each column is shaded as a heat map by rank (highest worth and growth,
// soonest payoff, lowest tax): the best figure darkest and marked Best, the
// runners-up 2nd and 3rd lighter and labelled, the rest and last place plain.
// Pressing a plan's name opens it in Analyze.

(function () {
    const D = window.Describe;
    const root = document.getElementById('compare');
    if (!root) return;

    const esc = escapeHtml;

    // The heat each podium place wears (--heat in compare.css), best first.
    const HEAT = [1, 0.6, 0.32];
    const PLACES = ['Best', '2nd', '3rd'];

    // The lengths on offer: the same as Analyze's (LENGTHS in outlook.js).
    const LENGTHS = [1, 3, 5, 10, 20, 30, 40];
    const PREF = 'compare-years';
    const yearsWord = (y) => `${y} year${y === 1 ? '' : 's'}`;

    const money = (v) => Fmt.money(v);
    /** Months until debt-free, in words. */
    const payoff = (v) => (v === Infinity ? 'Not paid off' : v === 0 ? 'No debt' : D.duration(v));

    // The columns: their name, how to read them off a run, and which end is best.
    const COLUMNS = [
        { id: 'worth', name: 'Net worth', note: 'At the end', best: 'max', show: money, signed: true },
        { id: 'growth', name: 'Growth', note: 'Interest and rewards', best: 'max', show: money },
        { id: 'payoff', name: 'Debt payoff', note: 'Until debt-free', best: 'min', show: payoff },
        { id: 'taxes', name: 'Taxes paid', note: 'Over the whole run', best: 'min', show: money },
    ];

    root.innerHTML = `
        <div class="board-body scroll-y">
            <div class="compare-bar">
                <span class="compare-label" id="compare-length-label">Over</span>
                <button class="field-select compare-length" type="button" data-act="length" aria-haspopup="menu" aria-expanded="false"
                    aria-labelledby="compare-length-label compare-length-value">
                    ${iconSvg('calendar-blank')}<span id="compare-length-value"></span>${iconSvg('caret-down', { cls: 'compare-length-caret' })}</button>
            </div>
            <div class="compare-wrap"></div>
            <p class="compare-note">Every plan runs over the same length, from its own start; the plans keep their own lengths. Shading marks the best plan in each column and its runners-up. Growth is what accounts earn plus card cash back. Debt payoff is how long until nothing is owed for the rest of the run. Taxes paid counts income tax withheld and Tax or fee modules.</p>
        </div>`;

    const wrap = root.querySelector('.compare-wrap');
    const lengthValue = root.querySelector('#compare-length-value');
    const showing = () => Store.state.workspace === 'compare';

    /** The length every plan is run over. */
    function years() {
        const y = Number(Prefs.get(PREF, 30));
        return LENGTHS.includes(y) ? y : 30;
    }

    /** Months until no debt is owed for the rest of the run: 0 when none ever
     *  is, Infinity when some still is at the end. */
    function debtFree(res) {
        const n = res.months;
        const debts = Object.values(res.nodes).filter((r) => r.role === 'debt');
        for (let k = n; k >= 0; k--) {
            let owed = 0;
            for (const r of debts) owed += r.balance[k];
            if (owed > 0.005) return k === n ? Infinity : k + 1;
        }
        return 0;
    }

    /** One plan's figures, or null when its run failed. */
    function figures(res) {
        if (!res) return null;
        const T = res.totals;
        let cardFees = 0;
        for (const r of Object.values(res.nodes)) if (r.kind === 'card') cardFees += r.totals.fees;
        return {
            worth: res.netWorth[res.months],
            growth: T.growth + T.cashback,
            payoff: debtFree(res),
            taxes: T.withheld + T.skimmed - cardFees,
        };
    }

    function render() {
        if (!showing()) return;
        const y = years();
        lengthValue.textContent = yearsWord(y);
        const rows = Runs.all({ years: y }).map(({ plan, results }) => ({ plan, results, f: figures(results) }));
        if (!rows.length) {
            wrap.innerHTML = '<p class="board-empty-text">No plans yet.</p>';
            return;
        }
        // Each column's distinct figures, best first, when the plans differ on
        // it at all. Figures within half a unit tie and share a place (debt
        // still owed at the end, Infinity, never places).
        const ranked = {};
        const measured = rows.filter((r) => r.f);
        for (const c of COLUMNS) {
            const vals = measured.map((r) => r.f[c.id]).sort((a, b) => (c.best === 'max' ? b - a : a - b));
            const distinct = vals.filter((v, i) => i === 0 || Math.abs(v - vals[i - 1]) >= 0.5);
            if (distinct.length > 1) ranked[c.id] = distinct;
        }
        /** A figure's podium place (0 = best), or -1 off the podium or last. */
        const place = (c, v) => {
            const distinct = ranked[c.id];
            if (!distinct) return -1;
            const i = distinct.findIndex((d) => Math.abs(v - d) < 0.5);
            return i < HEAT.length && i < distinct.length - 1 ? i : -1;
        };
        const cell = (r, c) => {
            if (!r.f) return '<td class="is-missing">—</td>';
            const v = r.f[c.id];
            const p = place(c, v);
            const cls = [p >= 0 ? 'is-heat' : '', p === 0 ? 'is-best' : '', c.signed && v < -0.5 ? 'is-negative' : ''].filter(Boolean).join(' ');
            const badge = p === 0 ? `<span class="compare-best">${iconSvg('trophy')}Best</span>`
                : p > 0 ? `<span class="compare-place">${PLACES[p]}</span>` : '';
            return `<td class="${cls}"${p >= 0 ? ` style="--heat: ${HEAT[p]}"` : ''}>${badge}<span class="compare-value">${esc(c.show(v))}</span></td>`;
        };
        wrap.innerHTML = `<table class="compare-table">
            <caption class="sr-only">Every plan compared over ${esc(yearsWord(y))}</caption>
            <thead><tr><th scope="col">Plan</th>${COLUMNS.map((c) => `<th scope="col"><span>${esc(c.name)}</span><span class="compare-col-note">${esc(c.note)}</span></th>`).join('')}</tr></thead>
            <tbody>${rows.map((r) => {
                // The first and last months, as the plan builder's scrubber names them.
                const span = `${D.monthLabel(r.plan, 0)} to ${D.monthLabel(r.plan, y * 12 - 1)}`;
                return `<tr>
                    <th scope="row">
                        <button class="compare-plan" type="button" data-open="${esc(r.plan.id)}" title="Analyze ${esc(r.plan.name)}">${esc(r.plan.name)}</button>
                        <span class="compare-span">${esc(span)}</span>
                    </th>
                    ${COLUMNS.map((c) => cell(r, c)).join('')}
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    root.addEventListener('click', (e) => {
        const open = e.target.closest('[data-open]');
        if (open) {
            Store.setWorkspace('analyze');
            Store.openPlan(open.dataset.open);
            return;
        }
        const act = e.target.closest('[data-act="length"]');
        if (!act) return;
        const now = years();
        UI.menu(act, LENGTHS.map((y) => ({
            label: yearsWord(y),
            icon: y === now ? 'check' : 'calendar-blank',
            onSelect: () => { Prefs.set(PREF, String(y)); render(); },
        })));
    });

    Store.on((c) => {
        if (c.type === 'workspace' || c.type === 'tabs' || c.type === 'results') render();
    });
    window.addEventListener('citrine:format', render);
}());
