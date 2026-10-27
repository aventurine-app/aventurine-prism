'use strict';

// ─── scrubber.js ────────────────────────────────────────────────────────────
// The slim bar under the plan builder's canvas: the plan's net worth over its
// whole run, drawn small, with the figure at the point being looked at.
// Moving along it (pointer, or arrow keys once focused) scrubs the plan to
// that month (Store.setScrub), and the module cards follow. Leaving it goes
// back to the plan's end. The full charts are in Analyze.

(function () {
    const root = document.getElementById('scrubber');
    if (!root) return;

    root.innerHTML = `
        <div class="scrub-read" aria-hidden="true">
            <span class="scrub-label">Net worth</span>
            <span class="scrub-value"></span>
            <span class="scrub-when"></span>
        </div>
        <div class="scrub-track" role="slider" tabindex="0" aria-label="Net worth over time" aria-valuemin="0">
            <div class="scrub-plot" aria-hidden="true">
                <svg class="scrub-svg" preserveAspectRatio="none">
                    <line class="scrub-zero"></line>
                    <path class="scrub-area"></path>
                    <path class="scrub-line"></path>
                </svg>
                <span class="scrub-cursor"></span>
                <span class="scrub-dot"></span>
            </div>
            <span class="scrub-edge scrub-edge--start" aria-hidden="true"></span>
            <span class="scrub-edge scrub-edge--end" aria-hidden="true"></span>
        </div>`;

    const valueEl = root.querySelector('.scrub-value');
    const whenEl = root.querySelector('.scrub-when');
    const track = root.querySelector('.scrub-track');
    const svg = root.querySelector('.scrub-svg');
    const area = root.querySelector('.scrub-area');
    const line = root.querySelector('.scrub-line');
    const zero = root.querySelector('.scrub-zero');
    const cursor = root.querySelector('.scrub-cursor');
    const dot = root.querySelector('.scrub-dot');
    const startEl = root.querySelector('.scrub-edge--start');
    const endEl = root.querySelector('.scrub-edge--end');

    // The drawn run: its net worth series and the value range drawn.
    let drawn = null;
    let dragging = false;

    /** Draw the net worth line in a viewBox of months by value, stretched to
     *  the track (the strokes keep their width: vector-effect in the CSS). */
    function draw() {
        const plan = Store.state.plan;
        const res = Store.state.results;
        if (!plan || !res) return;
        const worth = res.netWorth;
        const n = res.months;
        let lo = 0;
        let hi = 0;
        for (let k = 0; k <= n; k++) { lo = Math.min(lo, worth[k]); hi = Math.max(hi, worth[k]); }
        if (hi - lo < 1) hi = lo + 1;
        const pad = (hi - lo) * 0.08;
        lo -= lo < 0 ? pad : 0;
        hi += pad;
        // y runs down from `hi`, so the lowest value sits on the box's bottom edge.
        const y = (v) => (hi - v).toFixed(2);
        let d = '';
        for (let k = 0; k <= n; k++) d += `${k ? 'L' : 'M'}${k},${y(worth[k])}`;
        svg.setAttribute('viewBox', `0 0 ${n} ${hi - lo}`);
        line.setAttribute('d', d);
        // The area fills down to zero, or to the bottom when nothing is negative.
        const base = y(Math.max(lo, 0));
        area.setAttribute('d', `${d}L${n},${base}L0,${base}Z`);
        zero.setAttribute('x1', 0);
        zero.setAttribute('x2', n);
        zero.setAttribute('y1', y(0));
        zero.setAttribute('y2', y(0));
        zero.style.display = lo < 0 ? '' : 'none';
        drawn = { worth, n, lo, hi };
        startEl.textContent = window.Describe.monthLabel(plan, 0);
        endEl.textContent = window.Describe.monthLabel(plan, n);
        track.setAttribute('aria-valuemax', String(n));
        place();
    }

    /** Put the cursor and the figure at the scrubbed point, or the end. */
    function place() {
        if (!drawn) return;
        const plan = Store.state.plan;
        const { worth, n, lo, hi } = drawn;
        const scrub = Store.state.scrub;
        const k = scrub == null ? n : Math.max(0, Math.min(n, scrub));
        const v = worth[k];
        const x = n ? (k / n) * 100 : 0;
        const yPct = ((hi - v) / (hi - lo)) * 100;
        cursor.style.left = `${x}%`;
        dot.style.left = `${x}%`;
        dot.style.top = `${yPct}%`;
        root.classList.toggle('is-scrubbing', scrub != null);
        dot.classList.toggle('is-negative', v < 0);
        const money = Fmt.money(v);
        const when = window.Describe.monthLabel(plan, k);
        valueEl.textContent = money;
        valueEl.classList.toggle('is-negative', v < -0.005);
        whenEl.textContent = scrub == null ? `at the end, ${when}` : when;
        track.setAttribute('aria-valuenow', String(k));
        track.setAttribute('aria-valuetext', `${when}: ${money}`);
    }

    /** The balance point under a pointer at clientX. */
    function pointAt(clientX) {
        const r = track.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
        return Math.round(f * (drawn ? drawn.n : 0));
    }

    track.addEventListener('pointermove', (e) => {
        if (drawn) Store.setScrub(pointAt(e.clientX));
    });
    track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !drawn) return;
        dragging = true;
        track.setPointerCapture(e.pointerId);
        Store.setScrub(pointAt(e.clientX));
    });
    const release = () => { dragging = false; };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);
    track.addEventListener('pointerleave', () => {
        if (!dragging && document.activeElement !== track) Store.setScrub(null);
    });
    track.addEventListener('blur', () => Store.setScrub(null));

    // Arrows step a month (Shift: a year); Home and End jump; Escape lets go.
    track.addEventListener('keydown', (e) => {
        if (!drawn) return;
        const { n } = drawn;
        const now = Store.state.scrub == null ? n : Store.state.scrub;
        const step = e.shiftKey ? 12 : 1;
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n, now + step);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, now - step);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = n;
        else if (e.key === 'Escape') { Store.setScrub(null); return; }
        else return;
        e.preventDefault();
        Store.setScrub(next);
    });

    Store.on((c) => {
        if (c.type === 'results') draw();
        else if (c.type === 'scrub') place();
    });
    // A Format change (Preferences) rewrites the figure.
    window.addEventListener('citrine:format', place);
}());
