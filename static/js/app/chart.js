'use strict';

// ─── chart.js ───────────────────────────────────────────────────────────────
// The outlook's two chart forms, drawn as SVG:
//
//   area   stacked bands over time (accounts above zero, debts below) with a
//          headline line on top (net worth)
//   bars   one in-bar above zero and one out-bar below it per period, with a
//          line for the difference (cash flow)
//
// Both share the same frame (recessive dashed grid, compact currency ticks,
// year ticks along the bottom) and the same hover layer: a crosshair, a
// tooltip listing every series at that point, and onHover(index) so the rest
// of the app can follow the cursor through time.
//
// Colours arrive as CSS custom-property names and are applied as
// `fill: var(--x)`, so a theme switch recolours a drawn chart with no redraw.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const M = { top: 10, right: 16, bottom: 26, left: 60 };

    /** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [lo, hi] in ~5 steps. */
    function niceTicks(lo, hi, count = 5) {
        if (hi - lo < 1e-9) hi = lo + 1;
        const raw = (hi - lo) / count;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
        const start = Math.floor(lo / step) * step;
        const end = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        return ticks;
    }

    function el(tag, attrs = {}, parent = null) {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        if (parent) parent.appendChild(n);
        return n;
    }

    /**
     * Draw into `box` (a positioned element).
     *   opts.kind       'area' | 'bars'
     *   opts.count      number of x positions
     *   opts.xTicks     [{ i, label }]
     *   opts.bands      area: [{ label, color, values, sign }]   sign -1 stacks below zero
     *   opts.bars       bars: [{ label, color, values, sign }]   one up series, one down
     *   opts.line       { label, color, values }
     *   opts.ghost      optional { label, color, values } drawn dashed behind the
     *                   line; NaN values leave gaps (a compared plan's months
     *                   outside this one)
     *   opts.format     value → axis label
     *   opts.tooltip    index → { title, rows: [{ label, color, value, total }] }
     *   opts.onHover    index | null
     */
    function draw(box, opts) {
        box.querySelector('.chart-svg')?.remove();
        box.querySelector('.chart-tip')?.remove();
        const W = box.clientWidth;
        const H = box.clientHeight;
        if (W < 60 || H < 60 || opts.count < 2) return;
        const pw = W - M.left - M.right;
        const ph = H - M.top - M.bottom;

        // ── Domain ─────────────────────────────────────────────────────────
        let lo = 0;
        let hi = 0;
        const n = opts.count;
        const up = new Float64Array(n);
        const down = new Float64Array(n);
        const layers = (opts.kind === 'area' ? opts.bands : opts.bars) || [];
        for (const s of layers) {
            for (let i = 0; i < n; i++) {
                const v = Math.max(0, s.values[i] || 0);
                if (s.sign < 0) down[i] += v; else up[i] += v;
            }
        }
        for (let i = 0; i < n; i++) { hi = Math.max(hi, up[i]); lo = Math.min(lo, -down[i]); }
        if (opts.line) for (let i = 0; i < n; i++) { hi = Math.max(hi, opts.line.values[i]); lo = Math.min(lo, opts.line.values[i]); }
        if (opts.ghost) {
            for (let i = 0; i < n; i++) {
                const v = opts.ghost.values[i];
                if (Number.isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
            }
        }
        // A flat-zero plan still gets a readable axis rather than $0..$1.
        if (hi - lo < 1) hi = lo + 1000;
        const ticks = niceTicks(lo, hi);
        const y0 = ticks[0];
        const y1 = ticks[ticks.length - 1];
        const Y = (v) => M.top + ph - ((v - y0) / (y1 - y0)) * ph;

        const bars = opts.kind === 'bars';
        const slot = bars ? pw / n : 0;
        const X = bars ? (i) => M.left + slot * (i + 0.5) : (i) => M.left + (i / (n - 1)) * pw;

        const svg = el('svg', { class: 'chart-svg', role: 'img', 'aria-label': opts.label || 'Chart' });

        // ── Frame ──────────────────────────────────────────────────────────
        for (const t of ticks) {
            el('line', { class: t === 0 ? 'chart-zero' : 'chart-grid', x1: M.left, x2: M.left + pw, y1: Y(t), y2: Y(t) }, svg);
            const label = el('text', { class: 'chart-tick', x: M.left - 10, y: Y(t) + 4, 'text-anchor': 'end' }, svg);
            label.textContent = opts.format(t);
        }
        for (const t of opts.xTicks || []) {
            const label = el('text', { class: 'chart-tick', x: X(t.i), y: H - 6, 'text-anchor': 'middle' }, svg);
            label.textContent = t.label;
        }

        // ── Marks ──────────────────────────────────────────────────────────
        if (!bars) {
            const accUp = new Float64Array(n);
            const accDown = new Float64Array(n);
            for (const s of layers) {
                const below = s.sign < 0;
                const acc = below ? accDown : accUp;
                let top = '';
                let bottom = '';
                for (let i = 0; i < n; i++) {
                    const v = Math.max(0, s.values[i] || 0);
                    const a = acc[i];
                    const b = a + v;
                    acc[i] = b;
                    const ya = Y(below ? -a : a);
                    const yb = Y(below ? -b : b);
                    top += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${yb.toFixed(1)}`;
                    bottom = `L${X(i).toFixed(1)},${ya.toFixed(1)}${bottom}`;
                }
                el('path', { class: 'chart-band', d: `${top}${bottom}Z`, style: `fill: var(${s.color})` }, svg);
            }
        } else {
            // Series stack away from zero: ups upward, downs downward. Only the
            // outermost segment of each stack gets the rounded data end; the
            // others are square, separated by a 2px surface gap.
            const bw = Math.max(2, Math.min(36, slot * 0.62));
            const r = Math.min(4, bw / 2);
            const accUp = new Float64Array(n);
            const accDown = new Float64Array(n);
            layers.forEach((s, li) => {
                const below = s.sign < 0;
                for (let i = 0; i < n; i++) {
                    const v = Math.max(0, s.values[i] || 0);
                    const acc = below ? accDown : accUp;
                    const a = acc[i];
                    const b = a + v;
                    acc[i] = b;
                    if (v <= 0) continue;
                    const ya = Y(below ? -a : a);
                    const yb = Y(below ? -b : b);
                    const h = Math.abs(yb - ya) - (a > 0 ? 2 : 0);
                    if (h < 0.5) continue;
                    const x = X(i) - bw / 2;
                    const start = below ? ya + (a > 0 ? 2 : 0) : ya - (a > 0 ? 2 : 0);
                    // Is anything stacked beyond this segment at this index?
                    let outer = true;
                    for (let k = li + 1; k < layers.length; k++) {
                        if ((layers[k].sign < 0) === below && (layers[k].values[i] || 0) > 0) { outer = false; break; }
                    }
                    const rr = outer ? Math.min(r, h) : 0;
                    const d = below
                        ? `M${x},${start}h${bw}v${h - rr}q0,${rr} ${-rr},${rr}h${-(bw - 2 * rr)}q${-rr},0 ${-rr},${-rr}Z`
                        : `M${x},${start}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${bw - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}Z`;
                    el('path', { class: 'chart-bar', d, style: `fill: var(${s.color})` }, svg);
                }
            });
        }

        if (opts.ghost) {
            let d = '';
            let pen = false;
            for (let i = 0; i < n; i++) {
                const v = opts.ghost.values[i];
                if (!Number.isFinite(v)) { pen = false; continue; }
                d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
                pen = true;
            }
            if (d) {
                // A surface-coloured halo keeps the dashes legible over the bands.
                el('path', { class: 'chart-line chart-ghost-halo', d }, svg);
                el('path', { class: 'chart-line chart-ghost', d, style: `stroke: var(${opts.ghost.color})` }, svg);
            }
        }

        if (opts.line) {
            let d = '';
            for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(opts.line.values[i]).toFixed(1)}`;
            el('path', { class: 'chart-line', d, style: `stroke: var(${opts.line.color})` }, svg);
        }

        // ── Hover ──────────────────────────────────────────────────────────
        const cross = el('line', { class: 'chart-cross', x1: 0, x2: 0, y1: M.top, y2: M.top + ph, visibility: 'hidden' }, svg);
        const dot = opts.line ? el('circle', { class: 'chart-dot', r: 5, cx: 0, cy: 0, visibility: 'hidden', style: `fill: var(${opts.line.color})` }, svg) : null;
        const hit = el('rect', { class: 'chart-hit', x: M.left, y: M.top, width: pw, height: ph }, svg);
        box.appendChild(svg);

        const tip = document.createElement('div');
        tip.className = 'chart-tip';
        tip.hidden = true;
        box.appendChild(tip);

        let last = -1;
        function show(i) {
            if (i === last) return;
            last = i;
            const x = X(i);
            cross.setAttribute('x1', x);
            cross.setAttribute('x2', x);
            cross.setAttribute('visibility', 'visible');
            if (dot) {
                dot.setAttribute('cx', x);
                dot.setAttribute('cy', Y(opts.line.values[i]));
                dot.setAttribute('visibility', 'visible');
            }
            const t = opts.tooltip(i);
            tip.innerHTML = `<div class="chart-tip-title">${escapeHtml(t.title)}</div>${t.rows.map((r) => `
                <div class="chart-tip-row${r.total ? ' is-total' : ''}"><i style="--swatch: var(${r.color || '--chart-grid'})"></i>
                    <span>${escapeHtml(r.label)}</span><b>${escapeHtml(r.value)}</b></div>`).join('')}`;
            tip.hidden = false;
            const tw = tip.offsetWidth;
            const left = x + 16 + tw > W ? x - 16 - tw : x + 16;
            tip.style.left = `${Math.max(0, left)}px`;
            // A tall tooltip grows upward rather than off the bottom.
            tip.style.top = `${Math.min(M.top, H - tip.offsetHeight - 4)}px`;
            if (opts.onHover) opts.onHover(i);
        }
        function hide() {
            last = -1;
            cross.setAttribute('visibility', 'hidden');
            if (dot) dot.setAttribute('visibility', 'hidden');
            tip.hidden = true;
            if (opts.onHover) opts.onHover(null);
        }
        hit.addEventListener('pointermove', (e) => {
            const r = svg.getBoundingClientRect();
            const px = e.clientX - r.left - M.left;
            const i = bars ? Math.floor(px / slot) : Math.round((px / pw) * (n - 1));
            show(Math.max(0, Math.min(n - 1, i)));
        });
        hit.addEventListener('pointerleave', hide);
    }

    window.Chart = { draw, niceTicks };
}());
