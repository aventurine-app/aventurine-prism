'use strict';

// ─── goals-board.js ─────────────────────────────────────────────────────────
// The Goals workspace: the goals every plan is measured against, each written
// as one rule. A rule is a sentence whose parts are buttons:
//
//   [Net worth] [is at least] [25 ×] [yearly expenses] [by age 65]
//
// The measure, the comparison, the "of" measure and the deadline each open a
// menu of their choices; the target opens a small panel (an amount, a
// multiple, or a percentage, and its figure), and so does an age deadline.
// Every change applies at once, and Ctrl+Z steps back through them. A card
// also holds the goal's name and how every plan does against it. Each card is
// a solid colour of the user's choosing, with a target drawn faintly at its left.
//
// A goal starts from a preset (a rule filled in) or as a custom one to write.
// Analyze's Net worth chart flags the month a plan meets each.
//
// Cards are kept per goal and updated in place, never rebuilt while a goal
// lives, so a name being typed or a menu's button keeps its focus.

(function () {
    const G = window.CitrineGoals;
    const P = window.CitrinePlan;
    const D = window.Describe;
    const root = document.getElementById('goals-board');
    if (!root) return;

    const esc = escapeHtml;
    // A status's tone shows in its icon as well as its words.
    const TONE_ICON = { positive: 'check-circle', warning: 'warning-circle', muted: 'hourglass' };
    // The kinds of target, and the figure each starts at when picked.
    const UNITS = [['amount', 'Amount'], ['times', 'Times'], ['percent', 'Percent']];
    const UNIT_START = { amount: 100000, times: 25, percent: 40 };

    /** A preset's rule, as the goal it would add. */
    const presetGoal = ({ id: _id, label: _label, ...fields }) => P.createGoal(fields);

    root.innerHTML = `
        <div class="board-head">
            <div class="board-titles">
                <h1 class="board-title">Goals</h1>
                <p class="board-sub">Write each goal as a rule. Every plan is measured against them.</p>
            </div>
            <button class="button-primary" type="button" data-act="custom">${iconSvg('plus')}<span>Custom goal</span></button>
        </div>
        <div class="board-body scroll-y">
            <ul class="board-goals" aria-label="Your goals"></ul>
            <div class="board-empty" hidden>
                <p class="board-empty-title">No goals yet</p>
                <p class="board-empty-text">Start from a preset below, or write your own with Custom goal.</p>
            </div>
            <section class="board-presets" aria-labelledby="board-presets-title">
                <h2 class="eyebrow" id="board-presets-title">Start from a preset</h2>
                <div class="board-preset-grid"></div>
            </section>
        </div>`;

    const list = root.querySelector('.board-goals');
    const emptyEl = root.querySelector('.board-empty');
    const presetGrid = root.querySelector('.board-preset-grid');
    const showing = () => Store.state.workspace === 'goals';

    /** The presets, each saying the rule it starts with (in the current number format). */
    function renderPresets() {
        presetGrid.innerHTML = G.PRESETS.map((p) => `
            <button class="board-preset" type="button" data-preset="${esc(p.id)}">
                <span class="role-tile role-tile--accent">${iconSvg(D.GOAL_METRICS[p.metric].icon)}</span>
                <span class="board-preset-text">
                    <span class="board-preset-name">${esc(p.label)}</span>
                    <span class="board-preset-hint">${esc(D.goalSentence(presetGoal(p)))}</span>
                </span>
            </button>`).join('');
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    const cards = new Map();   // goal id → { el, parts }

    const tok = (name, popup) => `<button class="rule-tok" type="button" data-tok="${name}" aria-haspopup="${popup}" aria-expanded="false">
        <span class="rule-tok-text"></span>${iconSvg('caret-down', { cls: 'rule-tok-caret' })}</button>`;

    function buildCard(id) {
        const el = document.createElement('li');
        el.className = 'goal-card';
        el.dataset.goal = id;
        el.innerHTML = `
            <span class="goal-wm" aria-hidden="true">${iconSvg('target')}</span>
            <div class="goal-card-head">
                <input class="goal-name" type="text" maxlength="${P.LIMITS.name}" aria-label="Goal name" spellcheck="false" autocomplete="off">
                <button class="goal-tool" type="button" data-act="color" aria-haspopup="dialog" aria-expanded="false" title="Card colour">${iconSvg('palette')}</button>
                <button class="goal-tool" type="button" data-act="delete" aria-label="Delete goal" title="Delete goal">${iconSvg('trash')}</button>
            </div>
            <p class="rule">${tok('metric', 'menu')}${tok('op', 'menu')}${tok('value', 'dialog')}<span class="rule-word" data-part="of-word">of</span>${tok('of', 'menu')}${tok('due', 'menu')}</p>
            <div class="board-plans" data-part="plans"></div>`;
        const part = (name) => el.querySelector(`[data-part="${name}"]`);
        const toks = Object.fromEntries([...el.querySelectorAll('[data-tok]')].map((b) => [b.dataset.tok, b]));
        return {
            el, name: el.querySelector('.goal-name'), color: el.querySelector('[data-act="color"]'),
            ofWord: part('of-word'), plans: part('plans'), toks, drawn: {},
        };
    }

    /** Set a rule part's words (and its accessible name) if they changed. */
    function setTok(c, name, label, text, hidden = false) {
        const b = c.toks[name];
        b.hidden = hidden;
        if (c.drawn[name] === text) return;
        c.drawn[name] = text;
        b.querySelector('.rule-tok-text').textContent = text;
        b.setAttribute('aria-label', `${label}: ${text}`);
    }

    /** The target's figure, as its button shows it: '$20,000', '25 ×', '40%'. */
    function valueText(g) {
        if (g.unit === 'amount') return Fmt.money(g.value);
        return g.unit === 'percent' ? `${Fmt.number(g.value, 2)}%` : `${Fmt.number(g.value, 2)} ×`;
    }

    /** How each plan does against `g`, as a row of chips. */
    function plansHtml(g, runs) {
        return runs.map(({ plan, results }) => {
            if (!results) return '';
            const [ev] = G.evaluate(plan, results, [g]);
            const status = D.goalStatus(ev, plan, results.months);
            const full = status.detail ? `${status.text}, ${status.detail}` : status.text;
            return `<span class="board-plan is-${status.tone}" title="${esc(`${plan.name}: ${full}`)}">
                ${iconSvg(TONE_ICON[status.tone])}<span class="board-plan-name">${esc(plan.name)}</span><span class="board-plan-when">${esc(status.text)}</span></span>`;
        }).join('');
    }

    function fillCard(c, g, runs) {
        if (document.activeElement !== c.name && c.name.value !== g.name) c.name.value = g.name;
        if (c.drawn.color !== g.color) {
            c.drawn.color = g.color;
            c.el.dataset.color = g.color;
            c.color.setAttribute('aria-label', `Card colour: ${D.GOAL_COLORS[g.color]}`);
        }
        const hasOf = g.unit !== 'amount';
        setTok(c, 'metric', 'Measure', D.GOAL_METRICS[g.metric].label);
        setTok(c, 'op', 'Comparison', D.goalOp(g));
        setTok(c, 'value', 'Target', valueText(g));
        c.ofWord.hidden = g.unit !== 'percent';
        setTok(c, 'of', 'Of', D.GOAL_METRICS[g.of].of, !hasOf);
        setTok(c, 'due', 'Deadline', D.goalDue(g));
        c.toks.due.classList.toggle('is-quiet', g.due === 'none');
        const plans = plansHtml(g, runs);
        if (c.drawn.plans !== plans) { c.drawn.plans = plans; c.plans.innerHTML = plans; }
    }

    function render() {
        if (!showing()) return;
        const goals = Store.state.goals;
        const runs = Runs.all();
        emptyEl.hidden = goals.length > 0;
        // Cards of goals that are gone go; the rest follow the list's order.
        for (const [id, c] of cards) {
            if (!goals.some((g) => g.id === id)) { c.el.remove(); cards.delete(id); }
        }
        goals.forEach((g, i) => {
            let c = cards.get(g.id);
            if (!c) { c = buildCard(g.id); cards.set(g.id, c); }
            if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] || null);
            fillCard(c, g, runs);
        });
    }

    // ── Editing a rule ─────────────────────────────────────────────────────

    /** Change goal `id` with `fn(goal)`. `key` merges a run of edits to one
     *  part (typing a figure) into one undo step. */
    function change(id, fn, key = null) {
        Store.editGoals((goals) => {
            const g = goals.find((x) => x.id === id);
            if (!g) return false;
            fn(g);
            return true;
        }, { key });
    }

    /** A menu item that picks a choice, ticked when it is the one set. */
    const choice = (on, label, icon, pick) => ({ label, icon: on ? 'check' : icon, onSelect: pick });

    /** Open the editor for one part of goal `id`'s rule, by its button. Picking
     *  from a menu hands the focus back to the button, for the keyboard. */
    function editPart(id, part, btn) {
        const g = Store.goal(id);
        if (!g) return;
        const pick = (fn) => () => { change(id, fn); btn.focus(); };
        const metrics = Object.entries(D.GOAL_METRICS);
        switch (part) {
            case 'metric':
                UI.menu(btn, metrics.map(([m, d]) => choice(g.metric === m, d.label, d.icon, pick((x) => {
                    x.metric = m;
                    // A measure is not compared with itself.
                    if (x.of === m) x.of = m === 'expenses' ? 'income' : 'expenses';
                }))));
                break;
            case 'op':
                UI.menu(btn, Object.entries(D.GOAL_OPS).map(([op, d]) => choice(g.op === op, D.goalOp({ ...g, op }), d.icon, pick((x) => { x.op = op; }))));
                break;
            case 'of':
                UI.menu(btn, metrics.filter(([m]) => m !== g.metric)
                    .map(([m, d]) => choice(g.of === m, d.of, d.icon, pick((x) => { x.of = m; }))));
                break;
            case 'value':
                valuePanel(id, btn);
                break;
            case 'due':
                UI.menu(btn, [
                    choice(g.due === 'none', 'Any time', 'infinity', pick((x) => { x.due = 'none'; })),
                    choice(g.due === 'date', 'By a date…', 'calendar-blank', () => pickDate(id, btn)),
                    choice(g.due === 'age', 'By an age…', 'user', () => agePanel(id, btn)),
                ]);
                break;
        }
    }

    /** A number field with its unit beside it: the currency symbol by an amount
     *  (before or after, as the currency is set), '×', '%' or 'yrs' after. */
    function numberField(unit, value, label) {
        const sym = Fmt.symbolParts();
        const affix = { amount: sym.symbol, times: '×', percent: '%', age: 'yrs' }[unit];
        const before = unit === 'amount' && !sym.suffix;
        const input = `<input class="field-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
            aria-label="${esc(label)}" value="${esc(Fmt.number(value, 2))}">`;
        const text = `<span class="field-affix-text">${esc(affix)}</span>`;
        return `<span class="field-affix">${before ? text + input : input + text}</span>`;
    }

    /** Typing a figure: read it, keep it in range, and set it with `set`. Enter closes the panel. */
    function onFigure(input, min, max, set) {
        input.addEventListener('input', () => {
            const v = Fmt.parseNumber(input.value);
            if (!Number.isFinite(v)) { input.setAttribute('aria-invalid', 'true'); return; }
            input.removeAttribute('aria-invalid');
            set(Math.min(max, Math.max(min, v)));
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); UI.closePop(); }
        });
    }

    /** The target: an amount, a multiple or a percentage, and its figure. */
    function valuePanel(id, btn) {
        const el = document.createElement('div');
        el.className = 'rule-pop';
        el.setAttribute('aria-label', 'Target');
        const draw = () => {
            const g = Store.goal(id);
            el.innerHTML = `
                <div class="segctl rule-units" role="group" aria-label="Kind of target">${UNITS.map(([u, name]) =>
                    `<button class="segctl-btn" type="button" data-unit="${u}" aria-pressed="${g.unit === u}">${esc(name)}</button>`).join('')}</div>
                <label class="rule-pop-field">${numberField(g.unit, g.value, 'Target figure')}</label>
                <p class="rule-pop-hint">${g.unit === 'amount' ? 'A fixed amount.'
                    : g.unit === 'times' ? 'A multiple of the measure picked next in the rule.'
                        : 'A share of the measure picked next in the rule.'}</p>`;
            const input = el.querySelector('input');
            onFigure(input, 0, P.GOAL_VALUE[g.unit], (v) => change(id, (x) => { x.value = v; }, `goal:${id}:value`));
            return input;
        };
        el.addEventListener('click', (e) => {
            const u = e.target.closest('[data-unit]');
            const g = Store.goal(id);
            if (!u || !g || g.unit === u.dataset.unit) return;
            change(id, (x) => { x.unit = u.dataset.unit; x.value = UNIT_START[x.unit]; });
            const input = draw();
            input.focus();
            input.select();
        });
        draw();
        UI.popover(btn, el);
        el.querySelector('input').select();
    }

    /** An age deadline: picking it sets one (65, or the age it had), then the age. */
    function agePanel(id, btn) {
        change(id, (x) => { x.due = 'age'; if (x.age == null) x.age = 65; });
        const g = Store.goal(id);
        const el = document.createElement('div');
        el.className = 'rule-pop';
        el.setAttribute('aria-label', 'Deadline age');
        el.innerHTML = `<label class="rule-pop-field">By age ${numberField('age', g.age, 'Age')}</label>
            <p class="rule-pop-hint">The month each plan's Person turns this age.</p>`;
        onFigure(el.querySelector('input'), P.GOAL_AGE.min, P.GOAL_AGE.max, (v) => change(id, (x) => { x.age = v; }, `goal:${id}:age`));
        UI.popover(btn, el);
        el.querySelector('input').select();
    }

    /** The card's colour: a swatch for each, the current one ticked. Picking
     *  one closes the panel back onto the colour button. */
    function colorPanel(id, btn) {
        const g = Store.goal(id);
        if (!g) return;
        const el = document.createElement('div');
        el.className = 'rule-pop color-pop';
        el.setAttribute('aria-label', 'Card colour');
        el.innerHTML = `<div class="swatches">${P.GOAL_COLORS.map((color) => `
            <button class="swatch" type="button" data-color="${color}" aria-pressed="${g.color === color}"
                aria-label="${esc(D.GOAL_COLORS[color])}" title="${esc(D.GOAL_COLORS[color])}">${iconSvg('check')}</button>`).join('')}</div>`;
        el.addEventListener('click', (e) => {
            const s = e.target.closest('[data-color]');
            if (!s) return;
            change(id, (x) => { x.color = s.dataset.color; });
            UI.closePop();
            btn.focus();
        });
        UI.popover(btn, el);
        el.querySelector('[aria-pressed="true"]')?.focus();
    }

    /** A date deadline, picked by month. */
    function pickDate(id, btn) {
        const g = Store.goal(id);
        if (!g) return;
        UI.monthPicker(btn, {
            value: g.by,
            fallback: g.by || P.ymAdd(P.ymNow(), 120),
            onPick: (v) => {
                if (v) change(id, (x) => { x.due = 'date'; x.by = v; });
                btn.focus();
            },
        });
    }

    // ── Adding and removing ────────────────────────────────────────────────

    /** Add a goal from a preset (or a custom one, with none) and bring it into
     *  view; a custom goal's name is ready to type. */
    function add(presetId = null) {
        const g = Store.addGoal(presetId);
        const c = g && cards.get(g.id);
        if (!c) return;
        c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        c.el.classList.add('is-new');
        setTimeout(() => c.el.classList.remove('is-new'), 1600);
        if (!presetId) { c.name.focus(); c.name.select(); }
    }

    function remove(id) {
        const g = Store.goal(id);
        if (!g) return;
        Store.removeGoal(id);
        UI.toast(`Deleted ${g.name}.`, { action: { label: 'Undo', onClick: () => Store.undo() } });
    }

    // ── Input ──────────────────────────────────────────────────────────────

    root.addEventListener('click', (e) => {
        const card = e.target.closest('[data-goal]');
        const partBtn = e.target.closest('[data-tok]');
        if (card && partBtn) { editPart(card.dataset.goal, partBtn.dataset.tok, partBtn); return; }
        if (card && e.target.closest('[data-act="delete"]')) { remove(card.dataset.goal); return; }
        const colorBtn = card && e.target.closest('[data-act="color"]');
        if (colorBtn) { colorPanel(card.dataset.goal, colorBtn); return; }
        const preset = e.target.closest('[data-preset]');
        if (preset) { add(preset.dataset.preset); return; }
        if (e.target.closest('[data-act="custom"]')) add();
    });

    // The name: each keystroke is kept (one undo step for the run of them);
    // left empty, it goes back to "Goal".
    list.addEventListener('input', (e) => {
        if (!e.target.classList.contains('goal-name')) return;
        const id = e.target.closest('[data-goal]').dataset.goal;
        const name = e.target.value.slice(0, P.LIMITS.name);
        change(id, (x) => { x.name = name; }, `goal:${id}:name`);
    });
    list.addEventListener('focusout', (e) => {
        if (!e.target.classList.contains('goal-name') || e.target.value.trim()) return;
        const id = e.target.closest('[data-goal]').dataset.goal;
        change(id, (x) => { x.name = 'Goal'; });
        e.target.value = 'Goal';
    });
    list.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('goal-name') && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur();
    });

    Store.on((c) => {
        if (['goals', 'workspace', 'tabs', 'results'].includes(c.type)) render();
    });
    // A Format change (Preferences) rewrites every figure.
    window.addEventListener('citrine:format', () => {
        renderPresets();
        for (const c of cards.values()) c.drawn = {};
        render();
    });

    renderPresets();
}());
