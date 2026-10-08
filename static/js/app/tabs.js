'use strict';

// ─── tabs.js ────────────────────────────────────────────────────────────────
// The plan tabs in the title bar. Each plan is a tab: click to open, double-
// click to rename, drag to reorder, and a menu for rename, duplicate, export
// and delete. The + button starts a blank plan.

(function () {
    const nav = document.getElementById('tabs');
    const saveEl = document.getElementById('save-state');
    if (!nav) return;

    nav.innerHTML = `
        <div class="tabs-list" role="tablist" aria-label="Plans"></div>
        <button class="tab-new" type="button" aria-label="New plan" title="New plan (Ctrl+T)">${iconSvg('plus')}</button>`;
    const list = nav.querySelector('.tabs-list');
    nav.querySelector('.tab-new').addEventListener('click', () => Store.newPlan());

    let renaming = null;

    function render() {
        if (renaming) return;
        const { tabs, activeId } = Store.state;
        list.innerHTML = tabs.map((id) => {
            const on = id === activeId;
            return `<div class="tab" role="tab" tabindex="${on ? 0 : -1}" aria-selected="${on}" data-id="${escapeHtml(id)}"
                         title="${escapeHtml(Store.planName(id))}">
                <span class="tab-name">${escapeHtml(Store.planName(id))}</span>
                <button class="tab-menu" type="button" tabindex="-1" aria-label="Plan options" aria-haspopup="menu">${iconSvg('dots-three')}</button>
            </div>`;
        }).join('');
    }

    function revealActive() {
        list.querySelector('.tab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // A mouse wheel scrolls the strip sideways when it overflows.
    list.addEventListener('wheel', (e) => {
        if (list.scrollWidth <= list.clientWidth) return;
        e.preventDefault();
        list.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: false });

    function openMenu(id, anchor) {
        UI.menu(anchor, [
            { label: 'Rename', icon: 'pencil-simple', onSelect: () => startRename(id) },
            { label: 'Duplicate', icon: 'copy', onSelect: () => Store.duplicatePlan(id) },
            { label: 'Export…', icon: 'export', onSelect: () => Store.exportPlan(id) },
            'sep',
            { label: 'Delete', icon: 'trash', danger: true, onSelect: () => confirmDelete(id) },
        ]);
    }

    async function confirmDelete(id) {
        const ok = await UI.confirm({
            title: 'Delete Plan',
            message: `${Store.planName(id)} and everything on its canvas will be deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
        });
        if (ok) Store.deletePlan(id);
    }

    function startRename(id) {
        const tab = list.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
        if (!tab) return;
        renaming = id;
        const nameEl = tab.querySelector('.tab-name');
        const input = document.createElement('input');
        input.className = 'tab-rename';
        input.value = Store.planName(id);
        input.maxLength = window.CitrinePlan.LIMITS.name;
        input.setAttribute('aria-label', 'Plan name');
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            renaming = null;
            if (save && input.value.trim()) Store.renamePlan(id, input.value);
            render();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    // ── Pointer: open, menu, drag to reorder ───────────────────────────────
    let drag = null;

    list.addEventListener('pointerdown', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab || e.button !== 0 || renaming) return;
        if (e.target.closest('.tab-menu')) return;
        drag = { id: tab.dataset.id, x0: e.clientX, active: false, tab };
        tab.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.active && Math.abs(e.clientX - drag.x0) < 5) return;
        drag.active = true;
        drag.tab.classList.add('is-dragging');
        const tabs = [...list.querySelectorAll('.tab')];
        tabs.forEach((t) => t.classList.remove('is-drop-before', 'is-drop-after'));
        const over = tabs.find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX < r.right;
        });
        if (over && over !== drag.tab) {
            const r = over.getBoundingClientRect();
            const before = e.clientX < r.left + r.width / 2;
            over.classList.add(before ? 'is-drop-before' : 'is-drop-after');
            drag.target = { id: over.dataset.id, before };
        } else {
            drag.target = null;
        }
    });

    function endDrag(e) {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!d.active) {
            if (e.type === 'pointerup') Store.openPlan(d.id);
            return;
        }
        if (d.target) {
            const order = Store.state.tabs.filter((x) => x !== d.id);
            let i = order.indexOf(d.target.id);
            if (!d.target.before) i += 1;
            order.splice(i, 0, d.id);
            Store.reorderTabs(order);
        }
        render();
    }
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);

    list.addEventListener('click', (e) => {
        const menuBtn = e.target.closest('.tab-menu');
        if (menuBtn) openMenu(menuBtn.closest('.tab').dataset.id, menuBtn);
    });

    list.addEventListener('dblclick', (e) => {
        const tab = e.target.closest('.tab');
        if (tab && !e.target.closest('.tab-menu')) startRename(tab.dataset.id);
    });

    list.addEventListener('contextmenu', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        e.preventDefault();
        openMenu(tab.dataset.id, { x: e.clientX, y: e.clientY });
    });

    // Keyboard: arrows move along the strip, Enter opens, F2 renames.
    list.addEventListener('keydown', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab || e.target !== tab) return;
        const tabs = [...list.querySelectorAll('.tab')];
        const i = tabs.indexOf(tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
            next.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            Store.openPlan(tab.dataset.id);
        } else if (e.key === 'F2') {
            e.preventDefault();
            startRename(tab.dataset.id);
        }
    });

    // ── Save state ─────────────────────────────────────────────────────────
    const SAVE_TEXT = { saved: 'Saved', saving: 'Saving…', error: 'Not saved' };

    function renderSave() {
        if (!saveEl) return;
        saveEl.hidden = false;
        saveEl.dataset.state = Store.state.save;
        saveEl.textContent = SAVE_TEXT[Store.state.save];
    }

    function renderTitle() {
        const plan = Store.state.plan;
        document.title = plan ? `${plan.name} | Aventurine Prism` : 'Aventurine Prism';
    }

    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan') renderTitle();
        if (c.type === 'tabs') { render(); revealActive(); }
        else if (c.type === 'plan') {
            // A rename of the active plan arrives as a plan edit.
            const el = list.querySelector('.tab[aria-selected="true"] .tab-name');
            if (el && Store.state.plan && el.textContent !== Store.state.plan.name) render();
        } else if (c.type === 'save') renderSave();
    });

    window.Tabs = { render, startRename };
}());
