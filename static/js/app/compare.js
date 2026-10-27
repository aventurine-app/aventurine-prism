'use strict';

// ─── compare.js ─────────────────────────────────────────────────────────────
// The Compare workspace: every plan side by side, one row each.
//
//   Net worth     at the plan's end
//   Taxes paid    over the whole plan: income tax withheld, plus what Tax or
//                 fee modules take (a card's annual fee is a fee, not a tax,
//                 so it is left out)
//   Leave behind  the end net worth in today's money: deflated over the plan
//                 at its own inflation rate, so plans of different lengths
//                 compare fairly
//
// Each column is shaded as a heat map by rank (highest worth, lowest tax):
// the best figure darkest and marked Best, the runners-up 2nd and 3rd lighter
// and labelled, the rest and last place plain. Pressing a plan's name opens
// it in Analyze.

(function () {
    const G = window.CitrineGoals;
    const D = window.Describe;
    const root = document.getElementById('compare');
    if (!root) return;

    const esc = escapeHtml;

    // The heat each podium place wears (--heat in compare.css), best first.
    const HEAT = [1, 0.6, 0.32];
    const PLACES = ['Best', '2nd', '3rd'];

    // The columns: their name, how to read them off a run, and which end is best.
    const COLUMNS = [
        { id: 'worth', name: 'Net worth', note: 'At the plan\'s end', best: 'max' },
        { id: 'taxes', name: 'Taxes paid', note: 'Over the whole plan', best: 'min' },
        { id: 'legacy', name: 'Leave behind', note: 'In today\'s money', best: 'max' },
    ];

    root.innerHTML = `
        <div class="board-head">
            <div class="board-titles">
                <h1 class="board-title">Compare</h1>
                <p class="board-sub">Every plan at its end, side by side.</p>
            </div>
        </div>
        <div class="board-body scroll-y">
            <div class="compare-wrap"></div>
            <p class="compare-note">Shading marks the best plan in each column and its runners-up. Taxes paid counts income tax withheld and Tax or fee modules. Leave behind is the end net worth in today's money, at each plan's inflation rate.</p>
        </div>`;

    const wrap = root.querySelector('.compare-wrap');
    const showing = () => Store.state.workspace === 'compare';

    /** One plan's figures, or null when its run failed. */
    function figures(plan, res) {
        if (!res) return null;
        const n = res.months;
        const T = res.totals;
        let cardFees = 0;
        for (const id of Object.keys(res.nodes)) {
            const r = res.nodes[id];
            if (r.kind === 'card') cardFees += r.totals.fees;
        }
        return {
            worth: res.netWorth[n],
            taxes: T.withheld + T.skimmed - cardFees,
            legacy: res.netWorth[n] * G.deflator(plan, n, true)[n],
        };
    }

    function render() {
        if (!showing()) return;
        const rows = Runs.all().map(({ plan, results }) => ({ plan, results, f: figures(plan, results) }));
        if (!rows.length) {
            wrap.innerHTML = '<p class="board-empty-text">No plans yet.</p>';
            return;
        }
        // Each column's distinct figures, best first, when the plans differ on
        // it at all. Figures within half a unit tie and share a place.
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
            const cls = [p >= 0 ? 'is-heat' : '', p === 0 ? 'is-best' : '', v < -0.5 && c.id !== 'taxes' ? 'is-negative' : ''].filter(Boolean).join(' ');
            const badge = p === 0 ? `<span class="compare-best">${iconSvg('trophy')}Best</span>`
                : p > 0 ? `<span class="compare-place">${PLACES[p]}</span>` : '';
            return `<td class="${cls}"${p >= 0 ? ` style="--heat: ${HEAT[p]}"` : ''}>${badge}<span class="compare-value">${esc(Fmt.money(v))}</span></td>`;
        };
        wrap.innerHTML = `<table class="compare-table">
            <caption class="sr-only">Every plan compared</caption>
            <thead><tr><th scope="col">Plan</th>${COLUMNS.map((c) => `<th scope="col"><span>${esc(c.name)}</span><span class="compare-col-note">${esc(c.note)}</span></th>`).join('')}</tr></thead>
            <tbody>${rows.map((r) => {
                const n = r.results ? r.results.months : Math.round(r.plan.settings.years * 12);
                const span = `${D.monthLabel(r.plan, 0)} to ${D.monthLabel(r.plan, n)}`;
                return `<tr>
                    <th scope="row">
                        <button class="compare-plan" type="button" data-open="${esc(r.plan.id)}" title="Analyze ${esc(r.plan.name)}">${esc(r.plan.name)}</button>
                        <span class="compare-span">${esc(span)} · ${esc(D.duration(n))}</span>
                    </th>
                    ${COLUMNS.map((c) => cell(r, c)).join('')}
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    root.addEventListener('click', (e) => {
        const open = e.target.closest('[data-open]');
        if (!open) return;
        Store.setWorkspace('analyze');
        Store.openPlan(open.dataset.open);
    });

    Store.on((c) => {
        if (c.type === 'workspace' || c.type === 'tabs' || c.type === 'results') render();
    });
    window.addEventListener('citrine:format', render);
}());
