'use strict';

// ─── canvas.js ──────────────────────────────────────────────────────────────
// The sandbox. Draws the active plan's modules as cards and its links as
// curves, and turns pointer and keyboard input into Store actions.
//
//   pan       middle-drag, Space+drag, or scroll
//   zoom      Ctrl+scroll (or pinch), the zoom island, Fit
//   add       drop a library tile, double-click empty space, or drag a link
//             out of a port onto empty space
//   link      drag from a module's right port onto another module
//   select    click a module or a link; drag empty space to box-select several
//             modules, then drag any one of them to move the group together;
//             Escape clears; Delete removes
//
// The world layer carries one CSS transform (the camera); everything inside it
// is laid out in world units, so a camera move touches a single style. Cards
// are keyed DOM: built once, then only the parts whose text changed are
// written. Hovering the outlook chart sets Store.state.scrub, and the cards
// and links then show that month instead of the whole run.

(function () {
    const C = window.CitrineCatalog;
    const P = window.CitrinePlan;
    const D = window.Describe;

    const stage = document.getElementById('stage');
    const world = document.getElementById('world');
    const svg = document.getElementById('links');
    const flowLayer = document.getElementById('flows');
    const labelLayer = document.getElementById('labels');
    const nodeLayer = document.getElementById('nodes');
    if (!stage) return;

    // Mirrors .node in canvas.css; the input port sits on the vertical centre
    // and the output ports are spread down the right edge.
    const { NODE_W, NODE_H, DOCK_H } = P.GEOM;
    const heightOf = (n) => (n.dock ? DOCK_H : NODE_H);
    const GRID = 24;
    const SNAP = 8;
    const ZOOM_MIN = 0.3;
    const ZOOM_MAX = 2;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // Past this many links the flow dots run only on the links touching the
    // selection: each animated link repaints the whole SVG layer every frame,
    // and a 262-link plan measured 245 ms a frame animated against 34 ms still.
    const FLOW_LIMIT = 60;

    let cam = { x: 0, y: 0, zoom: 1 };
    // Modules picked by a box-select (two or more). A single pick is the
    // Store selection instead, so the inspector keeps working as before.
    const group = new Set();
    const nodeViews = new Map();
    const linkViews = new Map();

    // ── Islands ────────────────────────────────────────────────────────────

    stage.insertAdjacentHTML('beforeend', `
        <div class="island island--tools" role="toolbar" aria-label="Canvas tools">
            <button class="button-icon" type="button" data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${iconSvg('arrow-counter-clockwise')}</button>
            <button class="button-icon" type="button" data-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${iconSvg('arrow-clockwise')}</button>
            <span class="island-sep"></span>
            <button class="button-icon" type="button" data-act="add" aria-label="Add module" title="Add module">${iconSvg('plus')}</button>
            <button class="button-icon" type="button" data-act="fit" aria-label="Fit plan to view" title="Fit to view">${iconSvg('corners-out')}</button>
            <button class="button-icon" type="button" data-act="inspector" aria-label="Show inspector" title="Inspector" aria-pressed="true">${iconSvg('sidebar-simple')}</button>
        </div>
        <div class="island island--zoom" role="toolbar" aria-label="Zoom">
            <button class="button-icon" type="button" data-act="zoom-out" aria-label="Zoom out">${iconSvg('minus')}</button>
            <button class="zoom-level" type="button" data-act="zoom-reset" title="Reset zoom">100%</button>
            <button class="button-icon" type="button" data-act="zoom-in" aria-label="Zoom in">${iconSvg('plus')}</button>
        </div>
        <div class="island island--time" hidden aria-live="polite">${iconSvg('clock-counter-clockwise')}<span></span></div>
        <div class="canvas-empty" hidden>
            <div class="empty-state">
                <div class="empty-state-art" aria-hidden="true">
                    ${['source', 'account', 'expense', 'debt', 'modifier', 'account'].map((r, i) =>
                        `<span class="role-tile role-tile--lg" data-role="${r}">${iconSvg(['briefcase', 'piggy-bank', 'shopping-bag', 'cardholder', 'credit-card', 'chart-line-up'][i])}</span>`).join('')}
                </div>
                <h2 class="empty-state-title">Empty plan</h2>
                <div class="empty-state-actions">
                    <button class="button-primary" type="button" data-act="example">${iconSvg('sparkle')}Load example</button>
                    <button class="button-secondary" type="button" data-act="add">Add module</button>
                </div>
            </div>
        </div>`);

    const zoomLabel = stage.querySelector('.zoom-level');
    const timeIsland = stage.querySelector('.island--time');
    const emptyEl = stage.querySelector('.canvas-empty');

    // ── Camera ─────────────────────────────────────────────────────────────

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function applyCamera() {
        world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
        const g = GRID * cam.zoom;
        stage.style.setProperty('--grid', `${g}px`);
        stage.style.setProperty('--grid-x', `${cam.x % g}px`);
        stage.style.setProperty('--grid-y', `${cam.y % g}px`);
        zoomLabel.textContent = `${Math.round(cam.zoom * 100)}%`;
    }

    let viewTimer = null;
    function setCamera(next, { save = true } = {}) {
        cam = { x: next.x, y: next.y, zoom: clamp(next.zoom, ZOOM_MIN, ZOOM_MAX) };
        applyCamera();
        if (!save) return;
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => Store.setView({ ...cam }), 400);
    }

    function zoomAt(factor, sx, sy) {
        const z = clamp(cam.zoom * factor, ZOOM_MIN, ZOOM_MAX);
        const k = z / cam.zoom;
        setCamera({ zoom: z, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k });
    }

    function stagePoint(clientX, clientY) {
        const r = stage.getBoundingClientRect();
        return { x: clientX - r.left, y: clientY - r.top };
    }

    function toWorld(clientX, clientY) {
        const s = stagePoint(clientX, clientY);
        return { x: (s.x - cam.x) / cam.zoom, y: (s.y - cam.y) / cam.zoom };
    }

    function fit() {
        const plan = Store.state.plan;
        if (!plan || !plan.nodes.length) {
            setCamera({ x: 80, y: 60, zoom: 1 });
            return;
        }
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (const n of plan.nodes) {
            x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
            x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + heightOf(n));
        }
        const pad = 48;
        const w = stage.clientWidth - pad * 2;
        const h = stage.clientHeight - pad * 2;
        const zoom = clamp(Math.min(w / (x1 - x0), h / (y1 - y0), 1.1), ZOOM_MIN, ZOOM_MAX);
        setCamera({
            zoom,
            x: pad + (w - (x1 - x0) * zoom) / 2 - x0 * zoom,
            y: pad + (h - (y1 - y0) * zoom) / 2 - y0 * zoom,
        });
    }

    // ── Geometry ───────────────────────────────────────────────────────────

    /** Height of output port `i` of `count` down the card's right edge. */
    const portY = (i, count, h = NODE_H) => Math.round(h * (i + 1) / (count + 1));

    function outPort(n, basis) {
        const bases = P.basesFor(n);
        return { x: n.x + NODE_W + 1, y: n.y + portY(Math.max(0, bases.indexOf(basis)), bases.length, heightOf(n)) };
    }
    const inPort = (n) => ({ x: n.x - 1, y: n.y + heightOf(n) / 2 });

    /** A cubic from port to port. Forward links bow gently; a link that runs
     *  backward loops out past both cards so it never cuts through them. */
    function curve(a, b) {
        const dx = b.x - a.x;
        const c = dx > 40 ? Math.max(40, dx * 0.45) : Math.max(90, Math.abs(dx) * 0.5 + 60);
        const p1 = { x: a.x + c, y: a.y };
        const p2 = { x: b.x - c, y: b.y };
        const mid = {
            x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8,
            y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8,
        };
        return { d: `M${a.x},${a.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${b.x},${b.y}`, mid };
    }

    // ── Figures for the cards ──────────────────────────────────────────────
    // The point being shown: the scrubbed month, or the end of the plan.

    function viewPoint() {
        const r = Store.state.results;
        if (!r) return null;
        const k = Store.state.scrub;
        return k == null ? { k: r.months, month: null, all: true } : { k, month: Math.max(0, Math.min(r.months - 1, k - 1)), all: false };
    }

    const avg = (arr) => (arr ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

    /** What a source pays per period, from its settings (for the resting card). */
    function sourcePeriod(node) {
        const p = node.params;
        const net = p.amount * (1 - (p.tax || 0) / 100);
        if (p.per === 'once') return { value: net, unit: p.start ? P.ymLabel(p.start) : 'once' };
        if (p.per === 'year') return p.payMonth ? { value: net, unit: '/yr' } : { value: net / 12, unit: '/mo' };
        const perMonth = { week: 52 / 12, biweek: 26 / 12, month: 1 }[p.per] || 1;
        return { value: net * perMonth, unit: '/mo' };
    }

    /** What the loans docked under an asset owe at month k. */
    function dockedOwed(docks, res, k) {
        let owed = 0;
        for (const d of docks) { const r = res.nodes[d.id]; if (r) owed += r.balance[k]; }
        return owed;
    }

    function figure(node, role, nr, vp, docks, res) {
        const out = { value: '', unit: '', delta: '', deltaDir: '', negative: false, done: false };
        if (!nr || !vp) return out;
        if (role === 'account' && docks.length) {
            // Equity: what the asset is worth, less what its docked loans owe.
            const v = nr.balance[vp.k] - dockedOwed(docks, res, vp.k);
            const d = v - (nr.balance[0] - dockedOwed(docks, res, 0));
            out.value = Fmt.money(v, { compact: Math.abs(v) >= 1e6 });
            out.unit = 'equity';
            out.negative = v < 0;
            if (Math.abs(d) >= 0.5) {
                out.delta = Fmt.money(d, { sign: true, compact: Math.abs(d) >= 1e4 });
                out.deltaDir = d > 0 ? 'up' : 'down';
            }
        } else if (role === 'account') {
            const v = nr.balance[vp.k];
            out.value = Fmt.money(v, { compact: v >= 1e6 });
            const d = v - nr.balance[0];
            if (Math.abs(d) >= 0.5) {
                out.delta = Fmt.money(d, { sign: true, compact: Math.abs(d) >= 1e4 });
                out.deltaDir = d > 0 ? 'up' : 'down';
            }
        } else if (role === 'debt') {
            const v = nr.balance[vp.k];
            let owedBefore = false;
            for (let i = 0; i < vp.k && !owedBefore; i++) owedBefore = nr.balance[i] > 0.005;
            if (v <= 0.005 && owedBefore) {
                out.value = 'Paid off';
                out.done = true;
            } else if (v <= 0.005 && node.params.start) {
                // Borrowed later in the plan: nothing owed yet.
                out.value = Fmt.money(0);
                out.unit = `until ${P.ymLabel(node.params.start)}`;
            } else {
                out.value = Fmt.money(v, { compact: v >= 1e6 });
                out.unit = 'owed';
                out.negative = v > 0.005;
            }
        } else if (role === 'source') {
            if (vp.all) {
                const s = sourcePeriod(node);
                out.value = Fmt.money(s.value);
                out.unit = s.unit;
            } else {
                out.value = Fmt.money(nr.produced[vp.month]);
                out.unit = '/mo';
            }
        } else {
            // Spending shows what reaches it; a card or a match shows what it
            // adds; a tax or fee shows what it takes.
            const kind = C.preset(node.type).kind;
            const series = role === 'expense' ? nr.inflow : kind === 'skim' ? nr.consumed : nr.produced;
            const v = vp.all ? avg(series) : series[vp.month];
            out.value = (role === 'modifier' && kind !== 'skim' && v >= 0.5 ? '+' : '') + Fmt.money(v);
            out.unit = vp.all ? 'avg/mo' : '/mo';
        }
        return out;
    }

    /** Segments for the bar under a card's figure. */
    function barSegments(node, role, nr, plan, res, vp) {
        if (!nr || !vp) return [];
        const upto = vp.all ? res.months : Math.max(1, vp.k);
        const sumTo = (arr) => { let s = 0; for (let i = 0; i < upto && i < arr.length; i++) s += arr[i]; return s; };
        if (role === 'account') {
            const docks = P.docksOf(plan, node.id);
            if (docks.length) {
                const owed = dockedOwed(docks, res, vp.k);
                const value = nr.balance[vp.k];
                return [{ role: 'source', w: Math.max(0, value - owed), label: 'Equity' }, { role: 'debt', w: Math.min(owed, value), label: 'Owed' }];
            }
            const balance = nr.balance[vp.k];
            const growth = Math.max(0, sumTo(nr.earnings));
            const principal = Math.max(0, balance - growth);
            return [{ role: 'account', w: principal, label: 'Saved' }, { role: 'growth', w: Math.min(growth, balance), label: 'Growth' }];
        }
        if (role === 'debt') {
            const peak = Math.max(...nr.balance);
            if (peak <= 0) return [];
            const paid = Math.max(0, peak - nr.balance[vp.k]);
            return [{ role: 'debt', w: paid, label: 'Paid' }, { role: 'track', w: peak - paid, label: 'Owed' }];
        }
        const segs = [];
        if (nr.consumed && (role === 'expense' || C.preset(node.type).kind !== 'match')) {
            const spent = sumTo(nr.consumed);
            if (spent > 0) segs.push({ role, w: spent, label: role === 'expense' ? 'Spent' : 'Used' });
        }
        for (const l of plan.links) {
            if (l.from !== node.id) continue;
            const target = Store.node(l.to);
            const lr = res.links[l.id];
            if (!target || !lr) continue;
            const w = sumTo(lr.flow);
            if (w > 0) segs.push({ role: D.roleOf(target), w, label: target.name });
        }
        if (nr.unplaced) {
            const u = sumTo(nr.unplaced);
            if (u > 0.005) segs.push({ role: 'none', w: u, label: 'Unassigned' });
        }
        return segs;
    }

    /** Warnings that belong to a node: its own, and its outgoing links'. */
    function nodeWarnings(nodeId, plan, res) {
        if (!res) return [];
        return res.warnings.filter((w) => {
            if (w.nodeId === nodeId || (w.nodeIds && w.nodeIds.includes(nodeId))) return w.code !== 'unassigned';
            return false;
        });
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    function buildNode(node) {
        const el = document.createElement('div');
        el.className = 'node';
        el.tabIndex = 0;
        el.dataset.id = node.id;
        el.innerHTML = `
            <span class="node-port node-port--in" aria-hidden="true"></span>
            <div class="node-head">
                <span class="role-tile"></span>
                <div class="node-titles"><span class="node-name"></span><span class="node-meta"></span></div>
            </div>
            <div class="node-figure"><span class="node-value"></span><span class="node-unit"></span><span class="node-delta"></span></div>
            <div class="node-bar" aria-hidden="true"></div>
            <span class="node-outs"></span>
            <div class="node-foot"></div>`;
        const view = {
            el,
            tile: el.querySelector('.role-tile'),
            name: el.querySelector('.node-name'),
            meta: el.querySelector('.node-meta'),
            value: el.querySelector('.node-value'),
            unit: el.querySelector('.node-unit'),
            delta: el.querySelector('.node-delta'),
            bar: el.querySelector('.node-bar'),
            inPort: el.querySelector('.node-port--in'),
            outs: el.querySelector('.node-outs'),
            foot: el.querySelector('.node-foot'),
            sig: {},
            flag: null,
        };
        nodeLayer.appendChild(el);
        return view;
    }

    /** Write `value` into `key` of the view only if it changed. */
    function put(view, key, value, write) {
        if (view.sig[key] === value) return;
        view.sig[key] = value;
        write(value);
    }

    function renderNode(node, view, plan, res, vp, sel) {
        const p = C.preset(node.type);
        const role = p.role;
        const parent = node.dock ? Store.node(node.dock) : null;
        if (parent) {
            // A docked loan is a section of its property's card: placed inside
            // it, below the card proper, and carried along with it.
            const dy = node.y - parent.y;
            put(view, 'pos', `dock:${dy}`, () => {
                view.el.style.transform = 'none';
                view.el.style.left = '-1px';
                view.el.style.top = `${dy - 1}px`;
            });
        } else {
            put(view, 'pos', `${node.x},${node.y}`, () => {
                view.el.style.transform = `translate(${node.x}px, ${node.y}px)`;
                view.el.style.left = '';
                view.el.style.top = '';
            });
        }
        put(view, 'role', role, (r) => {
            view.el.dataset.role = r;
            view.tile.dataset.role = r;
            view.inPort.hidden = !C.ROLES[r].hasIn;
        });
        const bases = P.basesFor(node);
        put(view, 'docked', !!node.dock, (on) => view.el.classList.toggle('is-docked', on));
        put(view, 'ports', `${role}|${bases.join()}|${node.dock ? 'd' : ''}`, () => {
            view.outs.innerHTML = bases.map((b, i) => `<span class="node-port node-port--out" data-basis="${b}"
                data-flow="${D.flowKey(node, b)}" style="top:${portY(i, bases.length, heightOf(node))}px" title="${D.portLabel(node, b)}"
                aria-hidden="true"><span class="node-port-label">${D.portLabel(node, b)}</span></span>`).join('');
        });
        put(view, 'icon', p.icon, (icon) => { view.tile.innerHTML = iconSvg(icon); });
        put(view, 'name', node.name, (t) => { view.name.textContent = t; });
        put(view, 'meta', D.nodeMeta(node), (t) => { view.meta.textContent = t; });

        const nr = res && res.nodes[node.id];
        const docks = role === 'account' ? P.docksOf(plan, node.id) : NO_DOCKS;
        const f = figure(node, role, nr, vp, docks, res);
        put(view, 'value', f.value, (t) => { view.value.textContent = t; });
        put(view, 'neg', f.negative, (v) => view.value.classList.toggle('is-negative', v));
        put(view, 'unit', f.unit, (t) => { view.unit.textContent = t; });
        put(view, 'delta', `${f.delta}|${f.deltaDir}`, () => {
            view.delta.textContent = f.delta;
            view.delta.className = `node-delta${f.deltaDir ? ` is-${f.deltaDir}` : ''}`;
        });

        const segs = barSegments(node, role, nr, plan, res, vp);
        const total = segs.reduce((a, s) => a + s.w, 0);
        const barSig = segs.map((s) => `${s.role}:${(s.w / (total || 1)).toFixed(3)}`).join('|');
        put(view, 'bar', barSig, () => {
            view.bar.innerHTML = segs.filter((s) => s.w > 0).map((s) => {
                const style = s.role === 'growth' ? 'background: var(--accent-positive);'
                    : s.role === 'track' ? 'background: transparent;' : '';
                const title = `${s.label}: ${Fmt.money(s.w, { compact: true })}`;
                return `<span data-role="${s.role}" style="flex: ${s.w} 1 0; ${style}" title="${escapeHtml(title)}"></span>`;
            }).join('');
        });

        const warns = nodeWarnings(node.id, plan, res);
        const done = f.done;
        const flagSig = warns.length ? `w:${warns.map((w) => w.code).join(',')}` : done ? 'done' : '';
        put(view, 'flag', flagSig, () => {
            if (view.flag) { view.flag.remove(); view.flag = null; }
            if (warns.length) {
                view.flag = document.createElement('span');
                view.flag.className = 'node-flag';
                view.flag.title = warns.map((w) => D.warning(w, plan).text).join('\n');
                view.flag.innerHTML = iconSvg('warning');
            } else if (done) {
                view.flag = document.createElement('span');
                view.flag.className = 'node-check';
                view.flag.innerHTML = iconSvg('check');
            }
            if (view.flag) view.el.appendChild(view.flag);
        });

        renderFoot(node, view, role, docks, plan);

        put(view, 'sel', group.has(node.id) || !!(sel && sel.kind === 'node' && sel.id === node.id), (on) => view.el.classList.toggle('is-selected', on));
        const label = `${node.name}, ${C.ROLES[role].label}, ${f.value} ${f.unit}`.trim();
        put(view, 'aria', label, (t) => view.el.setAttribute('aria-label', t));
    }

    // ── Foot strips ────────────────────────────────────────────────────────
    // A strip hanging under a card joins it to what it can take: "+ debt"
    // under a property (under its last docked loan), a card slot under
    // spending, and the list of what a credit card is paying for.

    const FOOT_H = 32;               // .node-foot-btn in canvas.css
    const NO_DOCKS = [];
    let cardOf = new Map();          // spending id -> the card paying for it
    let chargedTo = new Map();       // card id -> the spending it pays for

    const CARD_GLYPH = '<span class="card-glyph" aria-hidden="true"></span>';

    function indexCharges(plan) {
        cardOf = new Map();
        chargedTo = new Map();
        for (const l of plan.links) {
            if (l.basis !== 'charges') continue;
            const from = Store.node(l.from);
            const to = Store.node(l.to);
            if (!from || !to) continue;
            if (!cardOf.has(to.id)) cardOf.set(to.id, from);
            if (!chargedTo.has(from.id)) chargedTo.set(from.id, []);
            chargedTo.get(from.id).push(to);
        }
    }

    function renderFoot(node, view, role, docks, plan) {
        let html = '';
        let top = NODE_H;
        let kind = '';
        let endsStack = false;
        if (node.dock) {
            // A docked loan has no strip of its own: the asset's hangs below the last one,
            // unless the stack is full, and then the last loan closes the frame itself.
            const stack = P.docksOf(plan, node.dock);
            endsStack = stack.length >= P.MAX_DOCKS && stack[stack.length - 1].id === node.id;
        } else if (P.loanOptions(node).length) {
            if (docks.length < P.MAX_DOCKS) { kind = 'add'; html = '<button class="node-foot-btn" type="button" data-foot="add" aria-haspopup="menu">+ debt</button>'; }
            top = NODE_H + docks.length * DOCK_H;
        } else if (role === 'expense') {
            const card = cardOf.get(node.id);
            kind = card ? 'slot-on' : 'slot';
            html = `<button class="node-foot-btn node-slot${card ? ' is-on' : ''}" type="button" data-foot="slot" aria-haspopup="menu"
                aria-label="Choose the card that pays for ${escapeHtml(node.name)}">${CARD_GLYPH}${card ? `<span>${escapeHtml(card.name)}</span>` : ''}</button>`;
        } else if (C.preset(node.type).kind === 'card' && chargedTo.has(node.id)) {
            kind = 'tray';
            const list = chargedTo.get(node.id);
            const names = list.slice(0, 2).map((n) => `<span class="o-chip">${escapeHtml(n.name)}</span>`).join('');
            html = `<div class="node-tray">${names}${list.length > 2 ? `<span class="o-chip">+${list.length - 2}</span>` : ''}</div>`;
        }
        // How far the module reaches down: its card, the loans docked under it
        // and the strip below them. The selection ring wraps all of it.
        const extent = node.dock ? DOCK_H : top + (html ? FOOT_H : 0);
        put(view, 'foot', `${kind}|${top}|${html}|${extent}|${endsStack}`, () => {
            view.el.style.setProperty('--extent', `${extent}px`);
            view.el.classList.toggle('ends-stack', endsStack);
            view.foot.innerHTML = html;
            view.foot.style.setProperty('--foot-top', `${top}px`);
            view.foot.hidden = !html;
            view.el.classList.toggle('has-foot', !!html);
            view.el.classList.toggle('has-docks', docks.length > 0);
        });
    }

    // ── Links ──────────────────────────────────────────────────────────────

    function buildLink(link) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.classList.add('link');
        g.dataset.id = link.id;
        const path = document.createElementNS(SVG_NS, 'path');
        path.classList.add('link-path');
        const flow = document.createElementNS(SVG_NS, 'path');
        flow.classList.add('link-flow');
        const hit = document.createElementNS(SVG_NS, 'path');
        hit.classList.add('link-hit');
        hit.dataset.link = link.id;
        g.append(path, hit);
        svg.appendChild(g);
        flowLayer.appendChild(flow);
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'link-label link';
        label.dataset.link = link.id;
        labelLayer.appendChild(label);
        return { g, path, flow, hit, label, sig: {} };
    }

    function renderLink(link, view, plan, res, vp, sel) {
        const from = Store.node(link.from);
        const to = Store.node(link.to);
        if (!from || !to) return;
        const flow = D.flowKey(from, link.basis);
        const c = curve(outPort(from, link.basis), inPort(to));
        put(view, 'd', c.d, (d) => {
            view.path.setAttribute('d', d);
            view.flow.setAttribute('d', d);
            view.hit.setAttribute('d', d);
        });
        put(view, 'mid', `${c.mid.x},${c.mid.y}`, () => {
            view.label.style.left = `${c.mid.x}px`;
            view.label.style.top = `${c.mid.y}px`;
        });
        put(view, 'flow', flow, (f) => { view.g.dataset.flow = f; view.label.dataset.flow = f; });

        const lr = res && res.links[link.id];
        const amount = !lr || !vp ? 0 : vp.all ? lr.avg : lr.flow[vp.month];
        const idle = !lr || lr.total < 0.005;
        put(view, 'idle', idle, () => {
            view.g.classList.toggle('is-idle', idle);
            view.flow.classList.toggle('is-idle', idle);
        });

        const text = vp && !vp.all ? Fmt.money(amount, { compact: amount >= 1e4 }) : D.linkShort(link, from);
        put(view, 'text', text, (t) => { view.label.textContent = t; });
        put(view, 'short', !!(lr && lr.short > 0.005), (v) => view.label.classList.toggle('is-short', v));
        put(view, 'title', `${from.name} to ${to.name}`, (t) => view.label.setAttribute('aria-label', t));

        const selected = sel && sel.kind === 'link' && sel.id === link.id;
        const related = selected || (sel && sel.kind === 'node' && (link.from === sel.id || link.to === sel.id));
        const dim = sel && sel.kind === 'node' && !related;
        put(view, 'state', `${selected}|${dim}|${related}`, () => {
            view.g.classList.toggle('is-selected', selected);
            view.label.classList.toggle('is-selected', selected);
            view.g.classList.toggle('is-dim', !!dim);
            view.label.classList.toggle('is-dim', !!dim);
            view.flow.classList.toggle('is-dim', !!dim);
            view.flow.classList.toggle('is-related', !!related);
            view.g.classList.toggle('is-active', !!related);
            view.flow.classList.toggle('is-active', !!related);
        });
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function render() {
        const { plan, results: res, selection: sel } = Store.state;
        if (!plan) return;
        const vp = viewPoint();

        for (const id of group) if (!Store.node(id)) group.delete(id);
        indexCharges(plan);
        const seenNodes = new Set();
        for (const node of plan.nodes) {
            seenNodes.add(node.id);
            let view = nodeViews.get(node.id);
            if (!view) {
                view = buildNode(node);
                nodeViews.set(node.id, view);
            }
            renderNode(node, view, plan, res, vp, sel);
        }
        // Docked loans live inside their property's element (one card, not two
        // stacked); a loan that left its dock goes back on the canvas.
        for (const node of plan.nodes) {
            const view = nodeViews.get(node.id);
            const holder = node.dock && nodeViews.get(node.dock) ? nodeViews.get(node.dock).el : nodeLayer;
            if (view.el.parentElement !== holder) holder.appendChild(view.el);
        }
        for (const [id, view] of nodeViews) {
            if (!seenNodes.has(id)) {
                view.el.remove();
                nodeViews.delete(id);
            }
        }

        const seenLinks = new Set();
        for (const link of plan.links) {
            seenLinks.add(link.id);
            let view = linkViews.get(link.id);
            if (!view) {
                view = buildLink(link);
                linkViews.set(link.id, view);
            }
            renderLink(link, view, plan, res, vp, sel);
        }
        for (const [id, view] of linkViews) {
            if (!seenLinks.has(id)) {
                view.g.remove();
                view.flow.remove();
                view.label.remove();
                linkViews.delete(id);
            }
        }

        stage.classList.toggle('flow-limited', plan.links.length > FLOW_LIMIT);
        emptyEl.hidden = plan.nodes.length > 0;
        const tools = stage.querySelector('.island--tools');
        tools.querySelector('[data-act="undo"]').disabled = !Store.canUndo();
        tools.querySelector('[data-act="redo"]').disabled = !Store.canRedo();

        if (vp && !vp.all) {
            timeIsland.hidden = false;
            timeIsland.querySelector('span').textContent = D.monthLabel(plan, vp.k);
        } else {
            timeIsland.hidden = true;
        }
    }

    /** Clear every view: a different plan is about to be drawn. */
    function reset() {
        for (const v of nodeViews.values()) v.el.remove();
        for (const v of linkViews.values()) { v.g.remove(); v.flow.remove(); v.label.remove(); }
        nodeViews.clear();
        linkViews.clear();
        group.clear();
        const plan = Store.state.plan;
        if (!plan) return;
        const v = plan.view;
        const untouched = !v || (v.x === 0 && v.y === 0 && v.zoom === 1);
        if (!untouched) {
            setCamera(v, { save: false });
        } else if (plan.nodes.length) {
            // A plan never panned (a fresh example, an import): frame it once
            // the stage has its size.
            requestAnimationFrame(fit);
        } else {
            setCamera({ x: 80, y: 60, zoom: 1 }, { save: false });
        }
    }

    // ── Adding modules ─────────────────────────────────────────────────────

    const snap = (v) => Math.round(v / SNAP) * SNAP;

    /** A free spot near (x, y): step down-right past any card already there. */
    function freeSpot(x, y) {
        const plan = Store.state.plan;
        let px = snap(x);
        let py = snap(y);
        for (let i = 0; i < 40; i++) {
            const hit = plan.nodes.some((n) => Math.abs(n.x - px) < NODE_W * 0.6 && Math.abs(n.y - py) < NODE_H * 0.6);
            if (!hit) break;
            px += 32;
            py += 32;
        }
        return { x: px, y: py };
    }

    function addAt(presetId, wx, wy) {
        const spot = freeSpot(wx - NODE_W / 2, wy - NODE_H / 2);
        const node = Store.addNode(presetId, spot.x, spot.y);
        if (node) focusNode(node.id);
        return node;
    }

    function addAtCenter(presetId) {
        const r = stage.getBoundingClientRect();
        const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        return addAt(presetId, c.x, c.y);
    }

    /** Picker of presets, optionally limited to roles a link may run into. */
    function presetGroups(roles = null) {
        return C.CATEGORIES.map((cat) => ({
            label: cat.name,
            items: C.PRESETS
                .filter((p) => p.cat === cat.id && (!roles || roles.includes(p.role)))
                .map((p) => ({ id: p.id, label: p.name, icon: p.icon, role: p.role, keywords: p.keywords })),
        })).filter((g) => g.items.length);
    }

    function openAddPicker(clientX, clientY, { from = null, basis = null } = {}) {
        const wpt = toWorld(clientX, clientY);
        const roles = !from ? null : basis ? P.portTargets(from, basis) : C.LINK_TARGETS[D.roleOf(from)];
        UI.picker({ x: clientX, y: clientY }, presetGroups(roles), {
            placeholder: from ? `Link ${from.name} to…` : 'Add a module',
            onPick: (item) => {
                const node = addAt(item.id, wpt.x + NODE_W / 2, wpt.y);
                if (node && from) Store.connect(from.id, node.id, basis);
            },
        });
    }

    function focusNode(id) {
        requestAnimationFrame(() => {
            const v = nodeViews.get(id);
            if (v) v.el.focus({ preventScroll: true });
        });
    }

    // ── Pointer input ──────────────────────────────────────────────────────

    let action = null;      // the gesture in progress
    let spaceDown = false;
    let ghost = null;

    /** Pointer capture keeps a drag alive outside the stage. It throws for a
     *  pointer that is no longer active, which is harmless here. */
    function capture(e) {
        try { stage.setPointerCapture(e.pointerId); } catch { /* inactive pointer */ }
    }

    function nodeAt(clientX, clientY) {
        const el = document.elementFromPoint(clientX, clientY);
        const card = el && el.closest('.node');
        return card ? Store.node(card.dataset.id) : null;
    }

    function startPan(e) {
        action = { type: 'pan', x0: e.clientX, y0: e.clientY, cam0: { ...cam }, moved: false };
        stage.classList.add('is-panning');
    }

    // The box drawn while box-selecting, in stage pixels.
    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    marqueeEl.hidden = true;
    stage.appendChild(marqueeEl);

    function startMarquee(e) {
        const p = stagePoint(e.clientX, e.clientY);
        action = { type: 'marquee', x0: p.x, y0: p.y, moved: false, hits: [], key: '' };
    }

    /** Ids of the modules the box touches. */
    function nodesInBox(a, b) {
        const p0 = { x: (Math.min(a.x, b.x) - cam.x) / cam.zoom, y: (Math.min(a.y, b.y) - cam.y) / cam.zoom };
        const p1 = { x: (Math.max(a.x, b.x) - cam.x) / cam.zoom, y: (Math.max(a.y, b.y) - cam.y) / cam.zoom };
        return Store.state.plan.nodes
            .filter((n) => n.x < p1.x && n.x + NODE_W > p0.x && n.y < p1.y && n.y + heightOf(n) > p0.y)
            .map((n) => n.id);
    }

    function moveMarquee(e) {
        const p = stagePoint(e.clientX, e.clientY);
        if (!action.moved && Math.abs(p.x - action.x0) + Math.abs(p.y - action.y0) < 4) return;
        action.moved = true;
        const left = Math.min(p.x, action.x0);
        const top = Math.min(p.y, action.y0);
        marqueeEl.hidden = false;
        marqueeEl.style.transform = `translate(${left}px, ${top}px)`;
        marqueeEl.style.width = `${Math.abs(p.x - action.x0)}px`;
        marqueeEl.style.height = `${Math.abs(p.y - action.y0)}px`;
        // Preview the picks on the cards; only touch them when the set changes.
        action.hits = nodesInBox({ x: action.x0, y: action.y0 }, p);
        const key = action.hits.join(',');
        if (key === action.key) return;
        action.key = key;
        const hit = new Set(action.hits);
        for (const [id, v] of nodeViews) v.el.classList.toggle('is-selected', hit.has(id));
    }

    /** One module becomes the normal selection; two or more become the group. */
    function commitMarquee(hits) {
        group.clear();
        if (hits.length === 1) {
            Store.select({ kind: 'node', id: hits[0] });
        } else {
            Store.select(null);
            for (const id of hits) group.add(id);
        }
        render();
    }

    stage.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.island, .canvas-empty .empty-state')) return;
        UI.closePop();
        stage.focus({ preventScroll: true });

        if (e.button === 1 || (e.button === 0 && spaceDown)) {
            e.preventDefault();
            startPan(e);
            capture(e);
            return;
        }
        if (e.button !== 0) return;
        if (e.target.closest('.node-foot')) return;
        // A debt's input dot is a button (who pays this?), not a drag handle.
        if (e.target.closest('.node-port--in') && e.target.closest('.node')?.dataset.role === 'debt') return;

        const port = e.target.closest('.node-port--out');
        const card = e.target.closest('.node');
        const linkEl = e.target.closest('[data-link]');

        if (port && card) {
            const from = Store.node(card.dataset.id);
            const basis = port.dataset.basis;
            action = { type: 'connect', from, basis, target: null };
            ghost = document.createElementNS(SVG_NS, 'path');
            ghost.classList.add('link-ghost');
            ghost.dataset.flow = port.dataset.flow;
            svg.appendChild(ghost);
            stage.classList.add('is-linking');
            markTargets(from, basis);
            capture(e);
            moveGhost(e);
            return;
        }
        if (card) {
            const node = Store.node(card.dataset.id);
            // A card inside the group drags the whole group and keeps it.
            const inGroup = group.has(node.id);
            if (!inGroup) {
                group.clear();
                Store.select({ kind: 'node', id: node.id });
            }
            // A loan docked under an asset moves with it: dragging either drags the stack.
            const picked = inGroup ? [...group].map(Store.node).filter(Boolean) : [node];
            const roots = new Map();
            for (const n of picked) { const r = n.dock ? Store.node(n.dock) : n; if (r) roots.set(r.id, r); }
            const members = [];
            for (const r of roots.values()) members.push(r, ...P.docksOf(Store.state.plan, r.id));
            const w = toWorld(e.clientX, e.clientY);
            action = {
                type: 'drag', node, dx: w.x - node.x, dy: w.y - node.y, x0: e.clientX, y0: e.clientY, moved: false,
                starts: members.map((n) => ({ id: n.id, x: n.x, y: n.y })),
            };
            capture(e);
            return;
        }
        if (linkEl) {
            Store.select({ kind: 'link', id: linkEl.dataset.link });
            return;
        }
        startMarquee(e);
        capture(e);
    });

    stage.addEventListener('pointermove', (e) => {
        if (!action) return;
        if (action.type === 'pan') {
            const dx = e.clientX - action.x0;
            const dy = e.clientY - action.y0;
            if (Math.abs(dx) + Math.abs(dy) > 3) action.moved = true;
            setCamera({ zoom: cam.zoom, x: action.cam0.x + dx, y: action.cam0.y + dy });
        } else if (action.type === 'drag') {
            if (!action.moved && Math.abs(e.clientX - action.x0) + Math.abs(e.clientY - action.y0) < 4) return;
            if (!action.moved) {
                action.moved = true;
                Store.beginGesture();
                for (const s of action.starts) nodeViews.get(s.id)?.el.classList.add('is-dragging');
            }
            // Snap the grabbed card, then move the rest by the same distance.
            const w = toWorld(e.clientX, e.clientY);
            const lead = action.starts.find((s) => s.id === action.node.id);
            const mx = snap(w.x - action.dx) - lead.x;
            const my = snap(w.y - action.dy) - lead.y;
            Store.gestureMove(() => {
                for (const s of action.starts) {
                    const n = Store.node(s.id);
                    if (n) { n.x = s.x + mx; n.y = s.y + my; }
                }
            });
        } else if (action.type === 'marquee') {
            moveMarquee(e);
        } else if (action.type === 'connect') {
            moveGhost(e);
        }
    });

    function endAction(e) {
        if (!action) return;
        const a = action;
        action = null;
        stage.classList.remove('is-panning');
        if (a.type === 'marquee') {
            marqueeEl.hidden = true;
            if (!a.moved) {
                group.clear();
                Store.select(null);
                render();
            } else if (e.type === 'pointerup') {
                commitMarquee(a.hits);
            } else {
                render();
            }
        }
        if (a.type === 'drag') {
            for (const s of a.starts) nodeViews.get(s.id)?.el.classList.remove('is-dragging');
            if (a.moved) Store.endGesture();
        }
        if (a.type === 'connect') {
            clearTargets();
            stage.classList.remove('is-linking');
            if (ghost) { ghost.remove(); ghost = null; }
            if (e.type !== 'pointerup') return;
            const target = resolveTarget(a.from, nodeAt(e.clientX, e.clientY), a.basis);
            if (target && target.id !== a.from.id) {
                const ok = P.canConnect(Store.state.plan, a.from.id, target.id, a.basis);
                if (ok.ok) Store.connect(a.from.id, target.id, a.basis);
                else if (ok.reason === 'duplicate') UI.toast(`${D.portLabel(a.from, a.basis)} already links those two modules.`);
                else if (ok.reason === 'role') UI.toast(linkRuleText(D.roleOf(a.from), D.roleOf(target)));
                else if (ok.reason === 'basis') UI.toast(portRuleText(a.from, a.basis));
            } else if (!target) {
                const under = document.elementFromPoint(e.clientX, e.clientY);
                if (under && stage.contains(under) && !under.closest('.island')) {
                    openAddPicker(e.clientX, e.clientY, { from: a.from, basis: a.basis });
                }
            }
        }
    }
    stage.addEventListener('pointerup', endAction);
    stage.addEventListener('pointercancel', endAction);

    const PLURAL = { account: 'accounts', expense: 'spending', debt: 'debts', modifier: 'modifiers' };

    /** Why a link was refused, as what IS allowed. */
    function linkRuleText(fromRole, toRole) {
        if (toRole === 'source') return 'Income has no input.';
        const allowed = C.LINK_TARGETS[fromRole].map((r) => PLURAL[r]);
        const list = allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} and ${allowed[allowed.length - 1]}` : allowed[0];
        return `${C.ROLES[fromRole].label} links only to ${list}.`;
    }

    /** Why an output port refused a module, as what it can reach. */
    function portRuleText(from, basis) {
        const allowed = P.portTargets(from, basis).map((r) => PLURAL[r]);
        const list = allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} and ${allowed[allowed.length - 1]}` : allowed[0];
        return `${D.portLabel(from, basis)} goes only to ${list}.`;
    }

    /** A property with loans docked under it stands for them: dropping a link
     *  on the property pays its first loan that can take it. */
    function resolveTarget(from, target, basis) {
        if (!target || target.dock) return target;
        const plan = Store.state.plan;
        const loan = P.docksOf(plan, target.id).find((d) => P.canConnect(plan, from.id, d.id, basis).ok);
        return loan || target;
    }

    function moveGhost(e) {
        const a = outPort(action.from, action.basis);
        const target = resolveTarget(action.from, nodeAt(e.clientX, e.clientY), action.basis);
        const valid = target && P.canConnect(Store.state.plan, action.from.id, target.id, action.basis).ok;
        const b = valid ? inPort(target) : toWorld(e.clientX, e.clientY);
        ghost.setAttribute('d', curve(a, b).d);
        for (const [id, v] of nodeViews) v.el.classList.toggle('is-target', !!valid && id === target.id);
    }

    function markTargets(from, basis) {
        const plan = Store.state.plan;
        for (const [id, v] of nodeViews) {
            if (id === from.id) continue;
            // A loan is dimmed or lit with the card it sits in.
            if (Store.node(id).dock) { v.el.classList.remove('is-dim'); continue; }
            const ok = P.canConnect(plan, from.id, id, basis).ok
                || P.docksOf(plan, id).some((d) => P.canConnect(plan, from.id, d.id, basis).ok);
            v.el.classList.toggle('is-dim', !ok);
        }
    }

    function clearTargets() {
        for (const v of nodeViews.values()) v.el.classList.remove('is-dim', 'is-target');
    }

    stage.addEventListener('dblclick', (e) => {
        if (e.target.closest('.node, [data-link], .island, .canvas-empty')) return;
        openAddPicker(e.clientX, e.clientY);
    });

    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = stagePoint(e.clientX, e.clientY);
        if (e.ctrlKey || e.metaKey) {
            zoomAt(Math.exp(-e.deltaY * 0.0025), s.x, s.y);
        } else {
            const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
            const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
            setCamera({ zoom: cam.zoom, x: cam.x - dx, y: cam.y - dy });
        }
    }, { passive: false });

    // The strips under cards, and the dot a debt is paid through.
    stage.addEventListener('click', (e) => {
        const btn = e.target.closest('.node-foot-btn');
        const card = e.target.closest('.node');
        if (!card) return;
        const node = Store.node(card.dataset.id);
        if (!node) return;
        const plan = Store.state.plan;
        if (btn && btn.dataset.foot === 'add') {
            UI.menu(btn, P.loanOptions(node).map((pid) => ({
                label: C.preset(pid).name, icon: C.preset(pid).icon, onSelect: () => Store.addLoan(node.id, pid),
            })));
        } else if (btn && btn.dataset.foot === 'slot') {
            const cards = plan.nodes.filter((n) => C.preset(n.type).kind === 'card');
            const items = cards.map((c) => ({ label: c.name, icon: 'credit-card', onSelect: () => Store.payWithCard(node.id, c.id) }));
            items.push({ label: 'New credit card', icon: 'plus', onSelect: () => Store.payWithCard(node.id, 'new') });
            if (cardOf.has(node.id)) items.push('sep', { label: 'Not on a card', icon: 'x', onSelect: () => Store.payWithCard(node.id, null) });
            UI.menu(btn, items);
        } else if (e.target.closest('.node-port--in') && D.roleOf(node) === 'debt') {
            const payers = plan.nodes.filter((n) => ['source', 'account'].includes(D.roleOf(n)) && P.canConnect(plan, n.id, node.id).ok);
            UI.menu(e.target.closest('.node-port--in'), payers.length
                ? payers.map((n) => ({ label: `Pay from ${n.name}`, icon: C.preset(n.type).icon, onSelect: () => Store.connect(n.id, node.id) }))
                : [{ label: 'No account to pay from yet', disabled: true }]);
        }
    });

    stage.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const card = e.target.closest('.node');
        const linkEl = e.target.closest('[data-link]');
        const at = { x: e.clientX, y: e.clientY };
        if (card) {
            const id = card.dataset.id;
            Store.select({ kind: 'node', id });
            const docking = Store.dockChoices(id).map((c) => (c.kind === 'undock'
                ? { label: `Detach from ${c.asset.name}`, icon: 'x', onSelect: () => Store.undockLoan(id) }
                : { label: `Attach to ${c.asset.name}`, icon: 'link-simple', onSelect: () => Store.dockLoan(id, c.asset.id) }));
            UI.menu(at, [
                { label: 'Link to…', icon: 'flow-arrow', onSelect: () => openAddPicker(e.clientX + 24, e.clientY, { from: Store.node(id) }) },
                ...docking,
                { label: 'Duplicate', icon: 'copy', onSelect: () => Store.duplicateNode(id) },
                'sep',
                { label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeNode(id) },
            ]);
        } else if (linkEl) {
            const id = linkEl.dataset.link;
            Store.select({ kind: 'link', id });
            UI.menu(at, [{ label: 'Delete link', icon: 'trash', danger: true, onSelect: () => Store.removeLink(id) }]);
        } else if (!e.target.closest('.island')) {
            UI.menu(at, [
                { label: 'Add module here…', icon: 'plus', onSelect: () => openAddPicker(e.clientX, e.clientY) },
                { label: 'Fit to view', icon: 'corners-out', onSelect: fit },
            ]);
        }
    });

    // ── Library drops ──────────────────────────────────────────────────────

    const PRESET_TYPE = 'application/x-citrine-preset';
    stage.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(PRESET_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        stage.classList.add('is-drop-target');
    });
    stage.addEventListener('dragleave', (e) => {
        if (!stage.contains(e.relatedTarget)) stage.classList.remove('is-drop-target');
    });
    stage.addEventListener('drop', (e) => {
        stage.classList.remove('is-drop-target');
        const id = e.dataTransfer.getData(PRESET_TYPE);
        if (!id || !C.preset(id)) return;
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        const node = Store.addNode(id, snap(w.x - NODE_W / 2), snap(w.y - NODE_H / 2));
        if (node) focusNode(node.id);
    });

    // ── Keyboard ───────────────────────────────────────────────────────────

    function removeNode(id) {
        const node = Store.node(id);
        if (!node) return;
        const name = node.name;
        Store.removeNode(id);
        UI.toast(`Deleted ${name}.`, { action: { label: 'Undo', onClick: () => Store.undo() } });
        stage.focus({ preventScroll: true });
    }

    function removeGroup() {
        const ids = new Set(group);
        group.clear();
        Store.edit((plan) => {
            plan.nodes = plan.nodes.filter((n) => !ids.has(n.id));
            plan.links = plan.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
        });
        UI.toast(`Deleted ${ids.size} modules.`, { action: { label: 'Undo', onClick: () => Store.undo() } });
        stage.focus({ preventScroll: true });
    }

    function deleteSelection() {
        if (group.size) { removeGroup(); return; }
        const s = Store.state.selection;
        if (!s) return;
        if (s.kind === 'node') removeNode(s.id);
        else Store.removeLink(s.id);
    }

    stage.addEventListener('keydown', (e) => {
        if (e.target.closest('input, select, textarea')) return;
        const s = Store.state.selection;
        if (e.key === ' ' && !e.repeat) {
            spaceDown = true;
            stage.classList.add('is-space');
            e.preventDefault();
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteSelection();
        } else if (e.key === 'Escape') {
            group.clear();
            Store.select(null);
            render();
        } else if (e.key === 'Enter' && e.target.classList.contains('node')) {
            Store.select({ kind: 'node', id: e.target.dataset.id });
        } else if (s && s.kind === 'node' && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const step = e.shiftKey ? 32 : SNAP;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            Store.edit((plan) => {
                const n = plan.nodes.find((x) => x.id === s.id);
                n.x += d[0];
                n.y += d[1];
            }, { key: `nudge:${s.id}` });
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && s && s.kind === 'node') {
            e.preventDefault();
            Store.duplicateNode(s.id);
        } else if (e.key === '+' || e.key === '=') {
            zoomAt(1.2, stage.clientWidth / 2, stage.clientHeight / 2);
        } else if (e.key === '-') {
            zoomAt(1 / 1.2, stage.clientWidth / 2, stage.clientHeight / 2);
        }
    });
    stage.addEventListener('keyup', (e) => {
        if (e.key === ' ') {
            spaceDown = false;
            stage.classList.remove('is-space');
        }
    });
    stage.addEventListener('focusin', (e) => {
        const card = e.target.closest && e.target.closest('.node');
        if (card && e.target === card && !action) Store.select({ kind: 'node', id: card.dataset.id });
    });

    // ── Islands ────────────────────────────────────────────────────────────

    stage.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const r = stage.getBoundingClientRect();
        switch (btn.dataset.act) {
            case 'undo': Store.undo(); break;
            case 'redo': Store.redo(); break;
            case 'fit': fit(); break;
            case 'zoom-in': zoomAt(1.2, stage.clientWidth / 2, stage.clientHeight / 2); break;
            case 'zoom-out': zoomAt(1 / 1.2, stage.clientWidth / 2, stage.clientHeight / 2); break;
            case 'zoom-reset': zoomAt(1 / cam.zoom, stage.clientWidth / 2, stage.clientHeight / 2); break;
            case 'add': openAddPicker(r.left + r.width / 2 - 140, r.top + 80); break;
            case 'inspector': Inspector.toggle(); btn.setAttribute('aria-pressed', String(Inspector.isOpen())); break;
            case 'example': loadExample(); break;
            default: break;
        }
    });

    function loadExample() {
        Store.edit((plan) => { CitrineExample.fill(plan); });
        requestAnimationFrame(fit);
    }

    // ── Store wiring ───────────────────────────────────────────────────────

    let lastPlanId = null;
    Store.on((c) => {
        if (c.type === 'plan' || c.type === 'tabs') {
            const plan = Store.state.plan;
            if (plan && plan.id !== lastPlanId) {
                lastPlanId = plan.id;
                reset();
            }
            render();
        } else if (c.type === 'results' || c.type === 'selection' || c.type === 'scrub') {
            // Picking anything else (a card, a link, the inspector) ends the group.
            if (c.type === 'selection' && Store.state.selection) group.clear();
            render();
        }
    });

    window.Canvas = { addAtCenter, fit, render, focus: () => stage.focus(), deleteSelection, NODE_W, NODE_H };
}());
