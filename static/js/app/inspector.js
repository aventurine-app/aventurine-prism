'use strict';

// ─── inspector.js ───────────────────────────────────────────────────────────
// The right-hand panel. It edits the selection:
//
//   a module   its name, its settings (the fields its preset shows), where its
//              money goes and comes from, its outlook and its issues
//   a link     its rule, as a sentence and as controls: from what, how much,
//              when, and an optional window
//   nothing    the plan: name, start, length, inflation, outlook, issues
//
// Controls are bound to the plan through `binds`: each has a get and a set,
// and every change goes through Store.edit, so it is undoable and saved. The
// panel is rebuilt only when the selection (or a field that changes which
// fields exist) changes; otherwise values are synced in place, skipping the
// control being typed in.

(function () {
    const C = window.CitrineCatalog;
    const P = window.CitrinePlan;
    const D = window.Describe;

    const root = document.getElementById('inspector');
    if (!root) return;

    const OPEN_KEY = 'inspector-open';
    let isOpenState = true;
    try { isOpenState = localStorage.getItem(OPEN_KEY) !== '0'; } catch { /* default open */ }

    let built = null;           // what the panel shows: 'plan' | 'node:<id>' | 'link:<id>'
    let binds = new Map();      // data-bind key → { type, get, set, ... }
    let statsEl = null;

    // ── Helpers ────────────────────────────────────────────────────────────

    const esc = escapeHtml;
    const plan = () => Store.state.plan;
    const results = () => Store.state.results;

    function section(title, body) {
        return `<section class="insp-section"><p class="eyebrow">${esc(title)}</p>${body}</section>`;
    }

    function row(label, control, { id, wide = false } = {}) {
        const w = wide ? ' insp-label--wide' : '';
        return `<label class="insp-label${w}" ${id ? `for="${id}"` : ''}>${esc(label)}</label><div class="insp-control${wide ? ' insp-control--wide' : ''}">${control}</div>`;
    }

    let uid = 0;
    const nextId = () => `insp-${++uid}`;

    /** Register a binding and return its control's HTML. */
    function bind(key, spec) {
        binds.set(key, spec);
        const id = nextId();
        const sym = Fmt.symbolParts();
        const attrs = `id="${id}" data-bind="${esc(key)}" autocomplete="off" spellcheck="false"`;
        let html;
        switch (spec.type) {
            case 'money': {
                const input = `<input class="field-input" type="text" inputmode="decimal" ${attrs}
                    ${spec.optional ? 'placeholder="None"' : ''}>`;
                html = `<span class="field-affix">${sym.suffix ? input : `<span class="field-affix-text">${esc(sym.symbol)}</span>${input}`}${sym.suffix ? `<span class="field-affix-text">${esc(sym.symbol)}</span>` : ''}</span>`;
                break;
            }
            case 'percent':
                html = `<span class="field-affix"><input class="field-input" type="text" inputmode="decimal" ${attrs}>
                    <span class="field-affix-text">%${spec.suffix ? esc(spec.suffix) : ''}</span></span>`;
                break;
            case 'number': {
                const input = `<input class="field-input" type="text" inputmode="${spec.decimals ? 'decimal' : 'numeric'}" ${attrs}
                    ${spec.optional ? 'placeholder="None"' : ''}>`;
                html = spec.suffix ? `<span class="field-affix">${input}<span class="field-affix-text">${esc(spec.suffix)}</span></span>` : input;
                break;
            }
            case 'text':
                html = `<input class="${spec.className || 'field-input'}" type="text" maxlength="${P.LIMITS.name}" ${attrs}>`;
                break;
            case 'select':
                html = `<select class="field-select" ${attrs}>${spec.options.map(([v, l]) =>
                    `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
                break;
            case 'yearmonth':
                html = `<button class="field-input field-month" type="button" id="${id}" data-bind="${esc(key)}" data-month aria-haspopup="dialog">
                    <span></span>${iconSvg('calendar-blank')}</button>`;
                break;
            default:
                throw new Error(`unknown bind type ${spec.type}`);
        }
        return { id, html };
    }

    function field(label, key, spec) {
        const b = bind(key, spec);
        return row(label, b.html, { id: b.id });
    }

    function display(spec, v) {
        if (spec.type === 'money') return v == null ? '' : Fmt.inputValue(v);
        if (spec.type === 'percent' || spec.type === 'number') return v == null ? '' : Fmt.number(v, 4);
        if (spec.type === 'select') return String(v);
        return v == null ? '' : String(v);
    }

    /** Push model values into every control except the one being edited. */
    function sync() {
        if (!plan()) return;
        for (const el of root.querySelectorAll('[data-bind]')) {
            const spec = binds.get(el.dataset.bind);
            if (!spec) continue;
            if (spec.type === 'yearmonth') {
                const v = spec.get();
                el.firstElementChild.textContent = v ? P.ymLabel(v) : (spec.empty || 'None');
                el.classList.toggle('is-empty', !v);
                continue;
            }
            if (el === document.activeElement) continue;
            const v = display(spec, spec.get());
            if (el.value !== v) el.value = v;
            el.removeAttribute('aria-invalid');
        }
        root.querySelectorAll('[data-years]').forEach((b) => {
            b.setAttribute('aria-pressed', String(Number(b.dataset.years) === plan().settings.years));
        });
        const sentence = root.querySelector('[data-sentence]');
        if (sentence) {
            const l = Store.link(built.slice(5));
            if (l) sentence.innerHTML = D.linkSentence(l, Store.node(l.from), Store.node(l.to));
        }
    }

    function commit(el, final) {
        const key = el.dataset.bind;
        const spec = binds.get(key);
        if (!spec) return;
        let v;
        if (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number') {
            const raw = el.value.trim();
            if (!raw && spec.optional) v = null;
            else {
                v = Fmt.parseNumber(raw);
                if (!Number.isFinite(v)) {
                    el.setAttribute('aria-invalid', 'true');
                    return;
                }
                v = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
                if (spec.type === 'number' && !spec.decimals) v = Math.round(v);
            }
        } else if (spec.type === 'text') {
            // eslint-disable-next-line no-control-regex
            v = el.value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, P.LIMITS.name);
            if (!v.trim()) {
                if (!final) return;
                v = spec.fallback();
            }
        } else if (spec.type === 'select') {
            v = spec.numeric ? Number(el.value) : el.value;
        } else {
            return;
        }
        el.removeAttribute('aria-invalid');
        const before = spec.get();
        if (before === v && !final) return;
        Store.edit((p) => spec.set(p, v), { key: `${built}:${key}` });
        if (final) {
            const shown = display(spec, spec.get());
            if (el.value !== shown && spec.type !== 'text') el.value = shown;
        }
        if (spec.rebuild) rebuild();
    }

    function rebuild() {
        const focusKey = document.activeElement && root.contains(document.activeElement)
            ? document.activeElement.dataset.bind : null;
        built = null;
        render();
        if (focusKey) root.querySelector(`[data-bind="${CSS.escape(focusKey)}"]`)?.focus();
    }

    // ── Sparkline ──────────────────────────────────────────────────────────

    function spark(values, role, marker) {
        const n = values.length;
        if (n < 2) return '';
        let lo = 0; let hi = 0;
        for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo < 1e-9) hi = lo + 1;
        const W = 280; const H = 64;
        const x = (i) => (i / (n - 1)) * W;
        const y = (v) => H - ((v - lo) / (hi - lo)) * (H - 4) - 2;
        let line = '';
        for (let i = 0; i < n; i++) line += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`;
        const area = `${line}L${W},${y(Math.max(lo, 0)).toFixed(1)}L0,${y(Math.max(lo, 0)).toFixed(1)}Z`;
        const zero = lo < 0 ? `<line class="spark-zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" vector-effect="non-scaling-stroke"/>` : '';
        const mark = marker != null
            ? `<line class="spark-zero" x1="${x(marker)}" x2="${x(marker)}" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/>`
            : '';
        return `<svg class="spark" data-role="${role}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            <path class="spark-area" d="${area}"/>${zero}${mark}
            <path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
    }

    function stat(label, value, dir = '') {
        return `<div><div class="stat-label">${esc(label)}</div><div class="stat-value${dir ? ` is-${dir}` : ''}">${esc(value)}</div></div>`;
    }

    const total = (arr) => (arr ? arr.reduce((a, b) => a + b, 0) : 0);
    const money = (v, o) => Fmt.money(v, o);

    const MAX_ISSUES = 8;

    function issuesHtml(all) {
        if (!all.length) return '';
        const list = all.slice(0, MAX_ISSUES);
        const more = all.length - list.length;
        return section('Issues', `<ul class="issues">${list.map((w) => {
            const d = D.warning(w, plan());
            const icon = d.level === 'info' ? 'info' : 'warning';
            const attrs = d.select ? `data-select="${d.select.kind}:${esc(d.select.id)}"` : '';
            const tag = d.select ? 'button type="button"' : 'li';
            const close = d.select ? 'button' : 'li';
            return `${d.select ? '<li>' : ''}<${tag} class="issue${d.level === 'info' ? ' issue--info' : ''}" ${attrs}>${iconSvg(icon)}<span>${esc(d.text)}</span></${close}>${d.select ? '</li>' : ''}`;
        }).join('')}${more > 0 ? `<li class="insp-none">${more} more</li>` : ''}</ul>`);
    }

    // ── Plan panel ─────────────────────────────────────────────────────────

    const ROLE_ICON = { source: 'briefcase', account: 'piggy-bank', asset: 'house-line', expense: 'shopping-bag', debt: 'cardholder', modifier: 'sliders-horizontal' };

    function planPanel() {
        const nameB = bind('plan.name', {
            type: 'text', className: 'insp-name',
            get: () => plan().name,
            set: (pl, v) => { pl.name = v; },
            fallback: () => 'Untitled plan',
        });
        const settings = `<div class="insp-fields">
            ${field('Starts', 'plan.start', {
                type: 'yearmonth',
                get: () => plan().settings.start,
                set: (pl, v) => { pl.settings.start = v; },
            })}
            ${field('Years', 'plan.years', {
                type: 'number', min: 1, max: P.LIMITS.years,
                get: () => plan().settings.years,
                set: (pl, v) => { pl.settings.years = v; },
            })}
            ${field('Inflation', 'plan.inflation', {
                type: 'percent', min: -20, max: 50, suffix: '/yr',
                get: () => plan().settings.inflation,
                set: (pl, v) => { pl.settings.inflation = v; },
            })}
        </div>`;
        return `
            <div class="insp-header">
                <span class="role-tile role-tile--lg" style="--tile: var(--accent-primary)">${iconSvg('sparkle')}</span>
                <div class="insp-titles">${nameB.html}
                </div>
            </div>
            ${section('Timeline', settings)}
            <div data-stats></div>`;
    }

    function planStats() {
        const p = plan();
        const r = results();
        if (!r) return '';
        const T = r.totals;
        const delta = T.endNetWorth - T.startNetWorth;
        const counts = C.ROLE_ORDER.map((role) => {
            const n = p.nodes.filter((x) => D.roleOf(x) === role).length;
            return n ? `<span class="role-count" data-role="${role}"><span class="role-tile">${iconSvg(ROLE_ICON[role])}</span>${n} ${esc(C.ROLES[role].label)}</span>` : '';
        }).join('');
        const outlook = `
            <div class="worth-line"><span class="worth-from">${money(T.startNetWorth, { compact: true })} →</span>
                <span class="worth-to">${money(T.endNetWorth)}</span></div>
            ${spark(Array.from(r.netWorth), 'none', Store.state.scrub)}
            <div class="insp-stats">
                ${stat('Change', money(delta, { sign: true }), delta >= 0 ? 'up' : 'down')}
                ${stat('Earned', money(T.earned - T.withheld))}
                ${stat('Spent', money(T.spent))}
                ${stat('Growth', money(T.growth))}
                ${T.interest > 0.5 ? stat('Interest paid', money(T.interest)) : ''}
                ${T.cashback + T.match > 0.5 ? stat('Cash back and match', money(T.cashback + T.match)) : ''}
                ${T.unassigned > 0.5 ? stat('Unassigned', money(T.unassigned)) : ''}
            </div>`;
        return section('Net worth', outlook)
            + issuesHtml(r.warnings)
            + (counts ? section('Modules', `<div class="role-counts">${counts}</div>`) : '');
    }

    // ── Node panel ─────────────────────────────────────────────────────────

    // What a blank date field means, shown in the field itself.
    const EMPTY_MONTH = {
        start: (p) => (p.role === 'debt' ? 'Already owed' : 'Plan start'),
        end: () => 'No end',
        lockUntil: () => 'Not locked',
        bought: () => 'Already owned',
        sold: () => 'Not sold',
    };

    function paramSpec(node, key) {
        const p = C.preset(node.type);
        const f = C.FIELDS[key];
        const id = node.id;
        const base = {
            get: () => (Store.node(id) || node).params[key],
            set: (pl, v) => { pl.nodes.find((n) => n.id === id).params[key] = v; },
            optional: !!f.optional,
            min: f.min, max: f.max,
        };
        switch (f.type) {
            case 'money': return { ...base, type: 'money' };
            case 'percent': return { ...base, type: 'percent', suffix: f.suffix };
            case 'number': return { ...base, type: 'number', suffix: f.suffix, decimals: true };
            case 'choice': return { ...base, type: 'select', options: f.options, rebuild: true };
            case 'month': return {
                ...base, type: 'select', numeric: true,
                options: [['0', 'Spread monthly'], ...P.MONTHS.map((m, i) => [String(i + 1), m])],
            };
            case 'yearmonth': return { ...base, type: 'yearmonth', empty: EMPTY_MONTH[key](p) };
            default: throw new Error(`unknown field ${key} on ${p.id}`);
        }
    }

    /** Which of a preset's fields apply right now (some depend on others). */
    function visibleFields(node) {
        const p = C.preset(node.type);
        const per = node.params.per;
        return C.fieldsFor(p).filter((k) => {
            if (k === 'payMonth') return per === 'year';
            if (k === 'end') return per !== 'once';
            if (k === 'sellCost') return !!node.params.sold;
            return true;
        });
    }

    function labelFor(node, key) {
        const p = C.preset(node.type);
        if (key === 'start' && node.params.per === 'once') return 'Date';
        return C.fieldLabel(p, key);
    }

    /** What a link moves a month: the plan's average, or the scrubbed month. */
    function flowText(linkId) {
        const r = results();
        const lr = r && r.links[linkId];
        if (!lr) return '';
        const scrub = Store.state.scrub;
        const amount = scrub == null ? lr.avg : lr.flow[Math.max(0, scrub - 1)];
        return `${money(amount)}/mo`;
    }

    /** One row in Sends to / Receives from: the module at the other end, the
     *  money moving along the link, and the link's rule. */
    function linkRow(l, other) {
        const r = results() && results().links[l.id];
        const short = r && r.short > 0.005;
        return `<li><button class="insp-link" type="button" data-select="link:${esc(l.id)}">
            <span class="role-tile role-tile--sm" data-role="${D.roleOf(other)}">${iconSvg(C.preset(other.type).icon)}</span>
            <span class="insp-link-text">
                <span class="insp-link-name">${esc(other.name)}</span>
                <span class="insp-link-amount" data-flow="${esc(l.id)}">${esc(flowText(l.id))}</span>
            </span>
            <span class="chip${short ? ' chip--warn' : ''}">${esc(D.linkShort(l, Store.node(l.from), Store.node(l.to)))}</span>
            ${iconSvg('caret-right', { cls: 'icon-caret' })}
        </button></li>`;
    }

    function nodePanel(node) {
        const p = C.preset(node.type);
        const role = p.role;
        const id = node.id;
        const nameB = bind('node.name', {
            type: 'text', className: 'insp-name',
            get: () => (Store.node(id) || node).name,
            set: (pl, v) => { pl.nodes.find((n) => n.id === id).name = v; },
            fallback: () => p.name,
        });

        const keys = visibleFields(node);
        const settings = keys.length
            ? section('Settings', `<div class="insp-fields">${keys.map((k) => field(labelFor(node, k), `param.${k}`, paramSpec(node, k))).join('')}</div>`)
            : '';

        const outs = plan().links.filter((l) => l.from === id);
        const ins = plan().links.filter((l) => l.to === id);
        // An asset that is not sold and collects no rent has nothing to send.
        const sends = C.ROLES[role].hasOut && P.basesFor(node).length ? section('Sends to',
            outs.length
                ? `<ul class="insp-links">${outs.map((l) => linkRow(l, Store.node(l.to))).join('')}</ul>`
                : '<p class="insp-none">No links yet</p>') : '';
        const receives = C.ROLES[role].hasIn ? section('Receives from',
            ins.length
                ? `<ul class="insp-links">${ins.map((l) => linkRow(l, Store.node(l.from))).join('')}</ul>`
                : '<p class="insp-none">Nothing links here yet</p>') : '';

        return `
            <div class="insp-header">
                <span class="role-tile role-tile--lg" data-role="${role}">${iconSvg(p.icon)}</span>
                <div class="insp-titles">${nameB.html}
                    <div class="insp-sub"><span class="chip chip--role" data-role="${role}">${esc(C.ROLES[role].label)}</span>
                        ${D.CATEGORY_NAME[p.cat] !== C.ROLES[role].label ? `<span class="chip">${esc(D.CATEGORY_NAME[p.cat])}</span>` : ''}
                        ${node.dock && Store.node(node.dock) ? `<button class="chip" type="button" data-select="node:${esc(node.dock)}">Secures ${esc(Store.node(node.dock).name)}</button>` : ''}</div>
                </div>
                <button class="button-icon" type="button" data-act="node-menu" aria-label="Module options" aria-haspopup="menu">${iconSvg('dots-three')}</button>
            </div>
            ${settings}${sends}${receives}
            <div data-stats></div>`;
    }

    /** A library module before it is added: its starting settings, read-only. */
    function presetPanel(presetId) {
        const p = C.preset(presetId);
        const role = p.role;
        const node = P.createNode(plan(), presetId, 0, 0);
        const keys = visibleFields(node);
        const settings = keys.length
            ? section('Settings', `<div class="insp-fields">${keys.map((k) => field(labelFor(node, k), `param.${k}`, paramSpec(node, k))).join('')}</div>`)
            : '';
        return `
            <div class="insp-header">
                <span class="role-tile role-tile--lg" data-role="${role}">${iconSvg(p.icon)}</span>
                <div class="insp-titles"><div class="insp-name">${esc(p.name)}</div>
                    <div class="insp-sub"><span class="chip chip--role" data-role="${role}">${esc(C.ROLES[role].label)}</span>
                        ${D.CATEGORY_NAME[p.cat] !== C.ROLES[role].label ? `<span class="chip">${esc(D.CATEGORY_NAME[p.cat])}</span>` : ''}</div>
                </div>
            </div>
            ${settings}`;
    }

    function nodeStats(node) {
        const r = results();
        const nr = r && r.nodes[node.id];
        if (!nr) return '';
        const role = D.roleOf(node);
        const kind = C.preset(node.type).kind;
        const m = r.months;
        let stats = '';
        if (role === 'account') {
            const end = nr.balance[m];
            stats = stat('Balance at end', money(end))
                + stat('Change', money(end - nr.balance[0], { sign: true }), end >= nr.balance[0] ? 'up' : 'down')
                + stat('Deposits', money(nr.totals.in))
                + stat('Growth', money(nr.totals.earnings))
                + (nr.totals.out > 0.5 ? stat('Sent on', money(nr.totals.out)) : '');
        } else if (role === 'asset') {
            const end = nr.balance[m];
            const docks = P.docksOf(plan(), node.id);
            const owed = docks.reduce((a, d) => a + (r.nodes[d.id] ? r.nodes[d.id].balance[m] : 0), 0);
            const sold = r.milestones.find((x) => x.code === 'sold' && x.nodeId === node.id);
            const change = nr.totals.earnings;
            stats = (sold ? stat('Sold', D.monthLabel(plan(), sold.month)) + stat('Sale after costs', money(nr.totals.out)) : '')
                + (owed > 0.5 ? stat('Equity at end', money(end - owed), end - owed >= 0 ? 'up' : 'down') + stat('Owed on loans', money(owed)) : '')
                + (sold ? '' : stat('Value at end', money(end)))
                + (nr.totals.in > 0.5 ? stat('Paid in', money(nr.totals.in)) : '')
                + stat(change >= 0 ? 'Appreciation' : 'Depreciation', money(Math.abs(change)), change >= 0 ? 'up' : 'down')
                + (nr.totals.produced > 0.5 ? stat('Rent collected', money(nr.totals.produced)) : '')
                + (nr.totals.consumed > 0.5 ? stat('Selling costs', money(nr.totals.consumed)) : '');
        } else if (role === 'debt') {
            const paidOff = r.milestones.find((x) => x.code === 'paid-off' && x.nodeId === node.id);
            stats = (nr.payment ? stat('Payment', `${money(nr.payment)}/mo`) : '')
                + stat('Owed at end', money(nr.balance[m]), nr.balance[m] > 0.5 ? 'down' : '')
                + stat('Paid off', paidOff ? D.monthLabel(plan(), paidOff.month + 1) : 'Not in this plan')
                + stat('Paid', money(nr.totals.paid))
                + stat('Interest', money(nr.totals.interest));
            if (kind === 'card') {
                const net = nr.totals.cashback - nr.totals.fees;
                stats += stat('Spent on card', money(nr.totals.charged))
                    + stat('Cash back', money(nr.totals.cashback))
                    + (nr.totals.fees > 0.5 ? stat('Annual fees', money(nr.totals.fees)) : '')
                    + (nr.totals.cashback + nr.totals.fees > 0.5
                        ? stat(net >= 0 ? 'Rewards after fees' : 'Fees beyond rewards', money(Math.abs(net)), net >= 0 ? 'up' : 'down') : '');
            }
        } else if (role === 'source') {
            const gross = total(nr.gross);
            const pretax = nr.totals.pretax;
            const takeHome = nr.totals.produced - pretax;
            stats = stat('Earned', money(gross))
                + (pretax > 0.5 ? stat('Before tax', money(pretax)) : '')
                + (gross - nr.totals.produced > 0.5 ? stat('Withheld', money(gross - nr.totals.produced)) : '')
                + stat('Take-home', money(takeHome))
                + stat('Average', `${money(takeHome / m)}/mo`);
        } else if (role === 'expense') {
            stats = stat('Spent here', money(nr.totals.consumed))
                + stat('Average', `${money(nr.totals.in / m)}/mo`)
                + (nr.totals.out > 0.5 ? stat('Paid through links', money(nr.totals.out)) : '');
        } else {
            if (kind === 'match') stats = stat('Match added', money(nr.totals.produced)) + stat('Contributions', money(nr.totals.in));
            else stats = stat('Taken', money(nr.totals.consumed)) + stat('Passed on', money(nr.totals.out));
        }
        const unplaced = nr.totals.unplaced;
        if (unplaced > 0.5 && role !== 'account') stats += stat('Unassigned', money(unplaced));
        const issues = r.warnings.filter((w) => w.nodeId === node.id || (w.nodeIds && w.nodeIds.includes(node.id)));
        return section('Outlook', `<div class="insp-stats">${stats}</div>`) + issuesHtml(issues);
    }

    // ── Link panel ─────────────────────────────────────────────────────────

    const MODE_LABEL = { due: 'Due', percent: '%', fixed: null, rest: 'Rest', above: 'Above' };
    const WHEN_LABEL = { monthly: 'Every month', yearly: 'Every year', once: 'Once' };

    function linkPanel(link) {
        const from = Store.node(link.from);
        const to = Store.node(link.to);
        const id = link.id;
        const L = () => Store.link(id) || link;
        const ends = (pl, l) => [pl.nodes.find((n) => n.id === l.from), pl.nodes.find((n) => n.id === l.to)];
        const setL = (fn) => (pl, v) => { const l = pl.links.find((x) => x.id === id); fn(l, v); P.fitRule(l, ...ends(pl, l)); };

        const bases = P.basesFor(from);
        const modes = P.modesFor(from, link.basis, to);
        const timings = P.timingsFor(link.basis, link.mode);
        const sym = Fmt.symbolParts().symbol;

        let rule = '';
        // The output port the link leaves from is fixed when it is drawn.
        if (bases.length > 1) rule += row('From', `<span class="insp-static">${esc(D.portLabel(from, link.basis))}</span>`);
        rule += row('Send', `<div class="segctl" role="group" aria-label="Send">${modes.map((m) =>
            `<button class="segctl-btn" type="button" data-mode="${m}" aria-pressed="${link.mode === m}">${esc(MODE_LABEL[m] || sym)}</button>`).join('')}</div>`,
        { wide: modes.length > 3 });
        if (link.mode === 'percent') {
            rule += field('Percent', 'link.value', {
                type: 'percent', min: 0, max: 100,
                get: () => L().value,
                set: setL((l, v) => { l.value = v; }),
            });
        } else if (link.mode === 'fixed' || link.mode === 'above') {
            rule += field(link.mode === 'above' ? 'Keep' : 'Amount', 'link.value', {
                type: 'money', min: 0, max: P.LIMITS.money,
                get: () => L().value,
                set: setL((l, v) => { l.value = v; }),
            });
        }
        if (timings.length > 1) {
            rule += field('When', 'link.when', {
                type: 'select', rebuild: true,
                options: timings.map((w) => [w, WHEN_LABEL[w]]),
                get: () => L().when,
                set: setL((l, v) => {
                    l.when = v;
                    if (v === 'once' && !l.date) l.date = P.ymAdd(plan().settings.start, 12);
                }),
            });
            if (link.when === 'yearly') {
                rule += field('In', 'link.month', {
                    type: 'select', numeric: true,
                    options: P.MONTHS.map((mo, i) => [String(i + 1), mo]),
                    get: () => L().month,
                    set: setL((l, v) => { l.month = v; }),
                });
            } else if (link.when === 'once') {
                rule += field('On', 'link.date', {
                    type: 'yearmonth',
                    get: () => L().date,
                    set: setL((l, v) => { l.date = v; }),
                });
            }
        }

        let windowRows = field('Starts', 'link.start', {
            type: 'yearmonth', optional: true, empty: 'Plan start',
            get: () => L().start,
            set: setL((l, v) => { l.start = v; }),
        }) + field('Ends', 'link.end', {
            type: 'yearmonth', optional: true, empty: 'Plan end',
            get: () => L().end,
            set: setL((l, v) => { l.end = v; }),
        });
        if (link.mode === 'fixed') {
            windowRows += field('Grows', 'link.growth', {
                type: 'percent', min: -100, max: 100, suffix: '/yr',
                get: () => L().growth,
                set: setL((l, v) => { l.growth = v; }),
            });
        }

        return `
            <div class="insp-header">
                <div class="insp-titles">
                    <div class="link-ends">
                        <button class="link-end" type="button" data-select="node:${esc(from.id)}">
                            <span class="role-tile" data-role="${D.roleOf(from)}">${iconSvg(C.preset(from.type).icon)}</span><span>${esc(from.name)}</span></button>
                        <span class="link-ends-arrow" aria-hidden="true">${iconSvg('arrow-right')}</span>
                        <button class="link-end" type="button" data-select="node:${esc(to.id)}">
                            <span class="role-tile" data-role="${D.roleOf(to)}">${iconSvg(C.preset(to.type).icon)}</span><span>${esc(to.name)}</span></button>
                    </div>
                </div>
                <button class="button-icon" type="button" data-act="link-delete" aria-label="Delete link" title="Delete link">${iconSvg('trash')}</button>
            </div>
            <section class="insp-section"><p class="sentence" data-sentence>${D.linkSentence(link, from, to)}</p></section>
            ${section('Rule', `<div class="insp-fields">${rule}</div>`)}
            ${section('Window', `<div class="insp-fields">${windowRows}</div>`)}
            <div data-stats></div>`;
    }

    function linkStats(link) {
        const r = results();
        const lr = r && r.links[link.id];
        if (!lr) return '';
        const flows = Array.from(lr.flow);
        const first = flows.findIndex((v) => v > 0.005);
        const scrub = Store.state.scrub;
        const stats = stat('Moved in total', money(lr.total))
            + stat('Average', `${money(lr.avg)}/mo`)
            + (first >= 0 ? stat('First move', D.monthLabel(plan(), first)) : stat('First move', 'Never'))
            + (lr.short > 0.5 ? stat('Short by', money(lr.short), 'down') : '');
        const issues = r.warnings.filter((w) => w.linkId === link.id);
        return section('Moved', `${spark(flows, D.roleOf(Store.node(link.from)), scrub == null ? null : Math.max(0, scrub - 1))}<div class="insp-stats">${stats}</div>`)
            + issuesHtml(issues);
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function currentKey() {
        if (Store.state.preview) return `preset:${Store.state.preview}`;
        const s = Store.state.selection;
        if (s && s.kind === 'node' && Store.node(s.id)) return `node:${s.id}`;
        if (s && s.kind === 'link' && Store.link(s.id)) return `link:${s.id}`;
        return 'plan';
    }

    function renderStats() {
        if (!statsEl || !plan()) return;
        const key = built;
        let html = '';
        if (key === 'plan') html = planStats();
        else if (key.startsWith('preset:')) html = '';
        else if (key.startsWith('node:')) html = nodeStats(Store.node(key.slice(5)));
        else if (key.startsWith('link:')) html = linkStats(Store.link(key.slice(5)));
        statsEl.innerHTML = html;
        for (const el of root.querySelectorAll('[data-flow]')) el.textContent = flowText(el.dataset.flow);
    }

    function render() {
        root.dataset.collapsed = String(!isOpenState);
        const p = plan();
        if (!p || !isOpenState) return;
        const key = currentKey();
        if (key === built) {
            sync();
            renderStats();
            return;
        }
        built = key;
        binds = new Map();
        let html;
        if (key === 'plan') html = planPanel();
        else if (key.startsWith('preset:')) html = presetPanel(key.slice(7));
        else if (key.startsWith('node:')) html = nodePanel(Store.node(key.slice(5)));
        else html = linkPanel(Store.link(key.slice(5)));
        root.innerHTML = `<div class="insp-scroll">${html}</div>`;
        if (key.startsWith('preset:')) {
            for (const el of root.querySelectorAll('[data-bind]')) el.disabled = true;
        }
        builtSig = structureSig();
        statsEl = root.querySelector('[data-stats]');
        sync();
        renderStats();
    }

    // ── Events ─────────────────────────────────────────────────────────────

    root.addEventListener('input', (e) => {
        const el = e.target.closest('[data-bind]');
        if (!el) return;
        const spec = binds.get(el.dataset.bind);
        if (spec && (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number' || spec.type === 'text')) commit(el, false);
    });

    root.addEventListener('change', (e) => {
        const el = e.target.closest('[data-bind]');
        if (el) commit(el, true);
    });

    root.addEventListener('focusout', (e) => {
        const el = e.target.closest('[data-bind]');
        if (!el) return;
        const spec = binds.get(el.dataset.bind);
        if (spec && spec.type !== 'select' && spec.type !== 'yearmonth') commit(el, true);
    });

    root.addEventListener('keydown', (e) => {
        const el = e.target.closest('input[data-bind]');
        if (el && e.key === 'Enter') {
            e.preventDefault();
            el.blur();
        } else if (el && e.key === 'Escape') {
            const spec = binds.get(el.dataset.bind);
            if (spec) el.value = display(spec, spec.get());
            el.blur();
        }
        // Keep Delete/Backspace inside text fields from reaching the canvas.
        if (e.target.closest('input, select')) e.stopPropagation();
    });

    root.addEventListener('click', async (e) => {
        const sel = e.target.closest('[data-select]');
        if (sel) {
            const [kind, ...rest] = sel.dataset.select.split(':');
            Store.select({ kind, id: rest.join(':') });
            return;
        }
        const month = e.target.closest('[data-month]');
        if (month) {
            const spec = binds.get(month.dataset.bind);
            if (!spec) return;
            UI.monthPicker(month, {
                value: spec.get(),
                fallback: plan().settings.start,
                clearLabel: spec.optional ? (spec.clearLabel || 'Clear') : null,
                onPick: (v) => {
                    Store.edit((pl) => spec.set(pl, v));
                    if (spec.rebuild) rebuild(); else sync();
                },
            });
            return;
        }
        const years = e.target.closest('[data-years]');
        if (years) {
            const y = Number(years.dataset.years);
            Store.edit((pl) => { pl.settings.years = y; });
            root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.years) === y)));
            return;
        }
        const mode = e.target.closest('[data-mode]');
        if (mode) {
            const id = built.slice(5);
            Store.edit((pl) => {
                const l = pl.links.find((x) => x.id === id);
                const next = mode.dataset.mode;
                if (l.mode === next) return false;
                // A rest link elsewhere on this basis cannot coexist with a second one.
                if (next === 'rest' && pl.links.some((x) => x.id !== id && x.from === l.from && x.basis === l.basis && x.mode === 'rest')) {
                    UI.toast('Another link already takes the rest.');
                    return false;
                }
                if (next === 'percent' && (l.mode !== 'percent')) l.value = Math.min(l.value || 25, 100) || 25;
                if (next === 'fixed' && l.mode === 'percent') l.value = 500;
                // From 'due' to a fixed amount: start at the payment it was making.
                if (next === 'fixed' && l.mode === 'due') {
                    const target = pl.nodes.find((n) => n.id === l.to);
                    l.value = Math.round(P.loanPayment(target.params)) || 500;
                }
                if (next === 'above' && l.mode !== 'above') l.value = 10000;
                l.mode = next;
                P.fitRule(l, pl.nodes.find((n) => n.id === l.from), pl.nodes.find((n) => n.id === l.to));
                return true;
            });
            rebuild();
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const key = built;
        if (act.dataset.act === 'node-menu') {
            const id = key.slice(5);
            const docking = Store.dockChoices(id).map((c) => (c.kind === 'undock'
                ? { label: `Detach from ${c.asset.name}`, icon: 'x', onSelect: () => Store.undockLoan(id) }
                : { label: `Attach to ${c.asset.name}`, icon: 'link-simple', onSelect: () => Store.dockLoan(id, c.asset.id) }));
            UI.menu(act, [
                { label: 'Link to…', icon: 'flow-arrow', onSelect: () => openLinkPicker(id, act) },
                ...docking,
                { label: 'Duplicate', icon: 'copy', onSelect: () => Store.duplicateNode(id) },
                'sep',
                { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteNode(id) },
            ], { align: 'right' });
        } else if (act.dataset.act === 'link-delete') {
            Store.removeLink(key.slice(5));
        }
    });

    function deleteNode(id) {
        const n = Store.node(id);
        if (!n) return;
        const name = n.name;
        Store.removeNode(id);
        UI.toast(`Deleted ${name}.`, { action: { label: 'Undo', onClick: () => Store.undo() } });
    }

    /** Link this module to an existing one, or to a new module placed beside it. */
    function openLinkPicker(id, anchor) {
        const from = Store.node(id);
        if (!from) return;
        const p = plan();
        const existing = p.nodes
            .filter((n) => P.canConnect(p, id, n.id).ok)
            .map((n) => ({ id: `node:${n.id}`, label: n.name, icon: C.preset(n.type).icon, role: D.roleOf(n) }));
        const roles = C.LINK_TARGETS[D.roleOf(from)];
        const fresh = C.CATEGORIES.map((cat) => ({
            label: `New · ${cat.name}`,
            items: C.PRESETS.filter((pr) => pr.cat === cat.id && roles.includes(pr.role))
                .map((pr) => ({ id: `preset:${pr.id}`, label: pr.name, icon: pr.icon, role: pr.role, keywords: pr.keywords })),
        })).filter((g) => g.items.length);
        UI.picker(anchor, [{ label: 'In this plan', items: existing }, ...fresh], {
            placeholder: `Link ${from.name} to…`,
            onPick: (item) => {
                const [kind, ref] = item.id.split(/:(.*)/s);
                if (kind === 'node') {
                    Store.connect(id, ref);
                } else {
                    const n = Store.addNode(ref, from.x + 320, from.y + (p.links.filter((l) => l.from === id).length * 136) - 68);
                    if (n) Store.connect(id, n.id);
                }
            },
        });
    }

    function toggle() {
        isOpenState = !isOpenState;
        try { localStorage.setItem(OPEN_KEY, isOpenState ? '1' : '0'); } catch { /* not persisted */ }
        built = null;
        render();
    }

    Store.on((c) => {
        if (c.type === 'selection' || c.type === 'tabs') { built = c.type === 'tabs' ? null : built; render(); }
        else if (c.type === 'plan') {
            // Structural changes (links added or removed) change the panel's lists.
            const key = currentKey();
            if (key !== built) render();
            else if (key !== 'plan' && listsChanged()) rebuild();
            else sync();
        } else if (c.type === 'results' || c.type === 'scrub') renderStats();
    });

    /** What the built panel's layout depends on beyond the selection: a
     *  module's links (its lists) and its schedule (which fields show), or a
     *  link's mode, basis and timing (which controls show). */
    function structureSig() {
        const p = plan();
        if (!p || !built) return '';
        if (built.startsWith('node:')) {
            const id = built.slice(5);
            const n = Store.node(id);
            const links = p.links.filter((l) => l.from === id || l.to === id)
                .map((l) => `${l.id}:${l.mode}:${l.value}:${l.basis}:${l.when}:${l.date}:${Store.node(l.from === id ? l.to : l.from)?.name}`);
            return `${links.join('|')}#${n ? n.params.per : ''}`;
        }
        if (built.startsWith('link:')) {
            const l = Store.link(built.slice(5));
            return l ? `${l.mode}|${l.basis}|${l.when}|${Store.node(l.from)?.params.start}` : '';
        }
        return '';
    }

    let builtSig = '';
    function listsChanged() {
        const sig = structureSig();
        const changed = sig !== builtSig;
        builtSig = sig;
        return changed;
    }

    /** Rebuild from scratch (number formats changed). */
    function refresh() {
        built = null;
        render();
    }

    window.Inspector = { render, refresh, toggle, isOpen: () => isOpenState };
}());
