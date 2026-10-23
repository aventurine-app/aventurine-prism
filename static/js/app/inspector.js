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
    let isOpenState = Prefs.get(OPEN_KEY) !== '0';

    let built = null;           // what the panel shows: 'plan' | 'preset:<id>' | 'node:<id>' | 'link:<id>'
    let builtSig = '';          // structureSig() of the built panel
    let binds = new Map();      // data-bind key → { type, get, set, ... }
    let statsEl = null;
    let issuesEl = null;

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
        const iconTile = root.querySelector('[data-act="node-icon"]');
        const shown = iconTile && Store.node(built.slice(5));
        if (shown && iconTile.dataset.icon !== P.iconOf(shown)) {
            iconTile.dataset.icon = P.iconOf(shown);
            iconTile.innerHTML = iconSvg(P.iconOf(shown));
        }
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

    function spark(values, marker) {
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
        return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
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
            const cls = d.level === 'warn' ? 'issue' : `issue issue--${d.level}`;
            const body = `${iconSvg(d.level === 'warn' ? 'warning' : 'info')}<span>${esc(d.text)}</span>`;
            // One that points somewhere is a button that selects it.
            return d.select
                ? `<li><button type="button" class="${cls}" data-select="${d.select.kind}:${esc(d.select.id)}">${body}</button></li>`
                : `<li class="${cls}">${body}</li>`;
        }).join('')}${more > 0 ? `<li class="insp-none">${more} more</li>` : ''}</ul>`);
    }

    // ── Plan panel ─────────────────────────────────────────────────────────

    const ROLE_ICON = { source: 'briefcase', account: 'piggy-bank', expense: 'shopping-bag', debt: 'cardholder', modifier: 'sliders-horizontal' };

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
            ${field('Inflation', 'plan.inflation', {
                type: 'percent', min: -20, max: 50, suffix: '/yr',
                get: () => plan().settings.inflation,
                set: (pl, v) => { pl.settings.inflation = v; },
            })}
        </div>`;
        return `
            <div class="insp-header">
                <span class="role-tile role-tile--lg role-tile--accent">${iconSvg('sparkle')}</span>
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
            ${spark(Array.from(r.netWorth), Store.state.scrub)}
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
        lockUntil: () => 'Not locked',
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
            case 'account': return {
                // A target that is gone reads as the default; the plan clears it on save.
                ...base, type: 'select',
                options: [['', 'Card balance'], ...plan().nodes.filter((n) => D.roleOf(n) === 'account').map((n) => [n.id, n.name])],
                get: () => {
                    const v = (Store.node(id) || node).params[key];
                    const to = v && Store.node(v);
                    return to && D.roleOf(to) === 'account' ? v : '';
                },
                set: (pl, v) => { pl.nodes.find((n) => n.id === id).params[key] = v || null; },
            };
            default: throw new Error(`unknown field ${key} on ${p.id}`);
        }
    }

    /** Which of a preset's fields apply right now (some depend on others). */
    function visibleFields(node) {
        const p = C.preset(node.type);
        const per = node.params.per;
        return C.fieldsFor(p).filter((k) => {
            if (k === 'payMonth') return per === 'year';
            if (k === 'cashBackTo') return node.params.cashBack > 0;
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

    /** The Settings section: a control for each field the module shows now. */
    function settingsSection(node) {
        const keys = visibleFields(node);
        if (!keys.length) return '';
        const fields = keys.map((k) => field(labelFor(node, k), `param.${k}`, paramSpec(node, k))).join('');
        return section('Settings', `<div class="insp-fields">${fields}</div>`);
    }

    /** One row in Outgoing / Incoming Flows: the module at the other end, the
     *  money moving along the link, and the link's rule. */
    function linkRow(l, other) {
        const r = results() && results().links[l.id];
        const short = r && r.short > 0.005;
        return `<li><button class="insp-link" type="button" data-select="link:${esc(l.id)}">
            <span class="role-tile role-tile--sm" data-role="${D.roleOf(other)}">${iconSvg(P.iconOf(other))}</span>
            <span class="insp-link-text">
                <span class="insp-link-name">${esc(other.name)}</span>
                <span class="insp-link-amount" data-flow="${esc(l.id)}">${esc(flowText(l.id))}</span>
            </span>
            <span class="chip${short ? ' chip--warn' : ''}">${esc(D.linkShort(l, Store.node(l.from)))}</span>
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

        const outs = plan().links.filter((l) => l.from === id);
        const ins = plan().links.filter((l) => l.to === id);
        const sends = P.basesFor(node).length ? section('Outgoing Flows',
            outs.length
                ? `<ul class="insp-links">${outs.map((l) => linkRow(l, Store.node(l.to))).join('')}</ul>`
                : '<p class="insp-none">No links yet</p>') : '';
        const receives = C.ROLES[role].hasIn ? section('Incoming Flows',
            ins.length
                ? `<ul class="insp-links">${ins.map((l) => linkRow(l, Store.node(l.from))).join('')}</ul>`
                : '<p class="insp-none">Nothing links here yet</p>') : '';

        return `
            <div class="insp-card" data-role="${role}">
            <div class="insp-header">
                <button class="role-tile role-tile--lg role-tile--button" type="button" data-act="node-icon" data-role="${role}"
                    data-icon="${esc(P.iconOf(node))}" aria-haspopup="dialog" aria-label="Change icon" title="Change icon">${iconSvg(P.iconOf(node))}</button>
                <div class="insp-titles">${nameB.html}</div>
            </div>
            ${settingsSection(node)}
            </div>
            <div data-issues></div>
            ${receives}${sends}
            <div data-stats></div>`;
    }

    /** A library module before it is added: its starting settings, read-only. */
    function presetPanel(presetId) {
        const p = C.preset(presetId);
        const role = p.role;
        const node = P.createNode(plan(), presetId, 0, 0);
        const icon = Store.state.previewIcon || p.icon;
        return `
            <div class="insp-card" data-role="${role}">
            <div class="insp-header">
                <button class="role-tile role-tile--lg role-tile--button" type="button" data-act="preview-icon" data-role="${role}"
                    aria-haspopup="dialog" aria-label="Change icon" title="Change icon">${iconSvg(icon)}</button>
                <div class="insp-titles"><div class="insp-name">${esc(p.name)}</div></div>
            </div>
            ${settingsSection(node)}
            </div>`;
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
        } else if (role === 'debt') {
            const paidOff = r.milestones.find((x) => x.code === 'paid-off' && x.nodeId === node.id);
            stats = (nr.payment ? stat('Payment', `${money(nr.payment)}/mo`) : '')
                + stat('Owed at end', money(nr.balance[m]), nr.balance[m] > 0.5 ? 'down' : '')
                + stat('Paid off', paidOff ? D.monthLabel(plan(), paidOff.month + 1) : 'Not in this plan')
                + stat('Paid', money(nr.totals.paid))
                + stat('Interest', money(nr.totals.interest));
            if (kind === 'card') {
                const net = nr.totals.cashback - nr.totals.fees;
                stats += (node.params.limit > 0 ? stat('Credit limit', money(node.params.limit)) : '')
                    + stat('Spent on card', money(nr.totals.charged))
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
            if (kind === 'match') stats = stat('Match added', money(nr.totals.produced)) + stat('Pay matched', money(nr.totals.in));
            else if (kind === 'group') stats = stat('Received', money(nr.totals.in)) + stat('Passed on', money(nr.totals.out))
                + (nr.totals.consumed > 0.5 ? stat('Spent in group', money(nr.totals.consumed)) : '');
            else stats = stat('Taken', money(nr.totals.consumed)) + stat('Passed on', money(nr.totals.out));
        }
        const unplaced = nr.totals.unplaced;
        if (unplaced > 0.5 && role !== 'account') stats += stat('Unassigned', money(unplaced));
        return section('Outlook', `<div class="insp-stats">${stats}</div>`);
    }

    /** What the last run flagged on a module, shown right under its settings. */
    function nodeIssues(node) {
        const r = results();
        if (!r) return '';
        return issuesHtml(r.warnings.filter((w) => w.nodeId === node.id || (w.nodeIds && w.nodeIds.includes(node.id))));
    }

    // ── Link panel ─────────────────────────────────────────────────────────

    const MODE_LABEL = { percent: '%', fixed: null, rest: 'Rest', above: 'Above' };
    const WHEN_LABEL = { monthly: 'Every month', yearly: 'Every year', once: 'Once' };

    function linkPanel(link) {
        const from = Store.node(link.from);
        const to = Store.node(link.to);
        const id = link.id;
        const L = () => Store.link(id) || link;
        const ends = (pl, l) => [pl.nodes.find((n) => n.id === l.from), pl.nodes.find((n) => n.id === l.to)];
        const setL = (fn) => (pl, v) => { const l = pl.links.find((x) => x.id === id); fn(l, v); P.fitRule(l, ends(pl, l)[0]); };

        const bases = P.basesFor(from);
        const modes = P.modesFor(from, link.basis);
        const timings = P.timingsFor(link.basis, link.mode);
        const sym = Fmt.symbolParts().symbol;

        let rule = '';
        // What the link carries (a card's purchases, a loan's proceeds...) is picked here;
        // the other links between this pair hold the bases they already use.
        const sources = bases.filter((b) => b === link.basis || P.basesBetween(plan(), from, to, link.id).includes(b));
        if (sources.length > 1) {
            rule += field('From', 'link.basis', {
                type: 'select', options: sources.map((b) => [b, D.portLabel(from, b)]), rebuild: true,
                get: () => L().basis,
                set: (pl, v) => P.changeBasis(pl, pl.links.find((x) => x.id === id), v),
            });
        } else if (bases.length > 1) {
            rule += row('From', `<span class="insp-static">${esc(D.portLabel(from, link.basis))}</span>`);
        }
        rule += row('Send', `<div class="segctl" role="group" aria-label="Send">${modes.map((m) =>
            `<button class="segctl-btn" type="button" data-mode="${m}" aria-pressed="${link.mode === m}">${esc(MODE_LABEL[m] || sym)}</button>`).join('')}</div>`,
        { wide: modes.length > 3 });
        if (link.mode === 'percent') {
            rule += field(link.basis === 'charges' ? 'Of limit' : 'Percent', 'link.value', {
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

        if (link.mode === 'fixed') {
            rule += field('Grows', 'link.growth', {
                type: 'percent', min: -100, max: 100, suffix: '/yr',
                get: () => L().growth,
                set: setL((l, v) => { l.growth = v; }),
            });
        }

        return `
            <div class="insp-card insp-card--link">
            <div class="insp-header">
                <div class="insp-titles">
                    <div class="link-ends">
                        <button class="link-end" type="button" data-select="node:${esc(from.id)}">
                            <span class="role-tile" data-role="${D.roleOf(from)}">${iconSvg(P.iconOf(from))}</span><span>${esc(from.name)}</span></button>
                        <span class="link-ends-arrow" aria-hidden="true">${iconSvg('arrow-right')}</span>
                        <button class="link-end" type="button" data-select="node:${esc(to.id)}">
                            <span class="role-tile" data-role="${D.roleOf(to)}">${iconSvg(P.iconOf(to))}</span><span>${esc(to.name)}</span></button>
                    </div>
                </div>
                <button class="button-icon" type="button" data-act="link-delete" aria-label="Delete flow" title="Delete flow">${iconSvg('trash')}</button>
            </div>
            ${section('Flow', `<div class="insp-fields">${rule}</div>`)}
            <section class="insp-section"><p class="sentence" data-sentence>${D.linkSentence(link, from, to)}</p></section>
            </div>
            <div data-issues></div>
            <div data-stats></div>`;
    }

    function linkIssues(link) {
        const r = results();
        return r ? issuesHtml(r.warnings.filter((w) => w.linkId === link.id)) : '';
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
        statsEl.innerHTML = html;
        if (issuesEl) {
            issuesEl.innerHTML = key.startsWith('node:') ? nodeIssues(Store.node(key.slice(5)))
                : key.startsWith('link:') ? linkIssues(Store.link(key.slice(5))) : '';
        }
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
        root.innerHTML = `<div class="insp-scroll scroll-y">${html}</div>`;
        if (key.startsWith('preset:')) {
            for (const el of root.querySelectorAll('[data-bind]')) el.disabled = true;
        }
        builtSig = structureSig();
        statsEl = root.querySelector('[data-stats]');
        issuesEl = root.querySelector('[data-issues]');
        sync();
        renderStats();
    }

    // ── Events ─────────────────────────────────────────────────────────────

    /** Group an amount field's digits as they are typed, keeping the caret
     *  after the same digit it was after. */
    function groupWhileTyping(el, spec) {
        const raw = el.value;
        const caret = el.selectionStart ?? raw.length;
        const next = Fmt.formatTyping(raw, {
            negative: (spec.min ?? -Infinity) < 0,
            decimals: spec.type !== 'number' || !!spec.decimals,
        });
        if (next === raw) return;
        const dec = Fmt.prefs.numberFormat === 'us' ? '.' : ',';
        const significant = (t) => { let n = 0; let seen = false; for (const ch of t) { if (/\d|-|\u2212/.test(ch)) n++; else if (ch === dec && !seen) { seen = true; n++; } } return n; };
        let keep = significant(raw.slice(0, caret));
        el.value = next;
        let pos = 0;
        while (pos < next.length && keep > 0) { if (/[\d-]/.test(next[pos]) || next[pos] === dec) keep--; pos++; }
        el.setSelectionRange(pos, pos);
    }

    root.addEventListener('input', (e) => {
        const el = e.target.closest('[data-bind]');
        if (!el) return;
        const spec = binds.get(el.dataset.bind);
        if (spec && (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number')) groupWhileTyping(el, spec);
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

    root.addEventListener('click', (e) => {
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
                clearLabel: spec.optional ? 'Clear' : null,
                onPick: (v) => {
                    Store.edit((pl) => spec.set(pl, v));
                    if (spec.rebuild) rebuild(); else sync();
                },
            });
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
                if (next === 'percent') l.value = Math.min(l.value || 25, 100) || 25;
                if (next === 'fixed' && l.mode === 'percent') l.value = 500;
                if (next === 'above') l.value = 10000;
                l.mode = next;
                P.fitRule(l, pl.nodes.find((n) => n.id === l.from));
                return true;
            });
            rebuild();
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const key = built;
        if (act.dataset.act === 'node-icon') {
            const id = key.slice(5);
            const node = Store.node(id);
            openIconPicker(act, C.preset(node.type), P.iconOf(node), (icon) => {
                Store.edit((pl) => {
                    const n = pl.nodes.find((x) => x.id === id);
                    if (icon === C.preset(n.type).icon) delete n.icon; else n.icon = icon;
                });
            });
        } else if (act.dataset.act === 'preview-icon') {
            const p = C.preset(Store.state.preview);
            openIconPicker(act, p, Store.state.previewIcon || p.icon, (icon) => {
                Store.setPreviewIcon(icon);
                refresh();
                root.querySelector('[data-act="preview-icon"]')?.focus();
            });
        } else if (act.dataset.act === 'link-delete') {
            Store.removeLink(key.slice(5));
        }
    });

    /** The icon grid for a module of preset `p`, in its role's colour. */
    function openIconPicker(anchor, p, value, onPick) {
        UI.iconPicker(anchor, { icons: C.iconChoices(p), value, role: p.role, onPick });
    }

    function toggle() {
        isOpenState = !isOpenState;
        Prefs.set(OPEN_KEY, isOpenState ? '1' : '0');
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
            // A card's cash back setting lists the plan's accounts.
            const accounts = n && n.params.cashBack != null
                ? p.nodes.filter((a) => D.roleOf(a) === 'account').map((a) => `${a.id}:${a.name}`).join(',') : '';
            return `${links.join('|')}#${n ? n.params.per : ''}#${n ? n.params.cashBack > 0 : ''}#${accounts}`;
        }
        if (built.startsWith('link:')) {
            const l = Store.link(built.slice(5));
            return l ? `${l.mode}|${l.basis}|${l.when}|${Store.node(l.from)?.params.start}` : '';
        }
        return '';
    }

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

    window.Inspector = { refresh, toggle, isOpen: () => isOpenState };
}());
