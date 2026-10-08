'use strict';

// ─── library.js ─────────────────────────────────────────────────────────────
// The module library in the sidebar: every preset from the catalog, shelved by
// category, each a tile in its role's colour. Tiles drag onto the canvas (the
// canvas handles the drop) or, double-clicked, land in the middle of the view.
// A single press only selects a tile and previews it in the inspector. The
// foot of the sidebar holds File and Settings, as in Aventurine.
//
// The pane collapses to a rail of category icons to give the canvas the room.
// Pressing an icon opens a panel listing that
// category's modules; a module there is selected, double-clicked or dragged
// like a tile.

(function () {
    const C = window.CitrineCatalog;
    const root = document.getElementById('library');
    if (!root) return;

    const RAIL_KEY = 'library-rail';
    const COLLAPSED_KEY = 'library-collapsed';
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { /* defaults */ }

    root.innerHTML = `
        <div class="library-head">
            <div class="library-head-row">
                <button class="button-icon" type="button" data-act="rail" aria-expanded="true" aria-label="Collapse modules" title="Collapse modules (Ctrl+B)">${iconSvg('sidebar-simple')}</button>
                <label class="library-search">${iconSvg('magnifying-glass')}
                    <input type="search" placeholder="Search modules" aria-label="Search modules" spellcheck="false" autocomplete="off">
                </label>
            </div>
        </div>
        <div class="library-scroll" role="list"></div>
        <nav class="library-rail" aria-label="Module categories">
            ${C.CATEGORIES.map((cat) => {
        const n = C.PRESETS.filter((p) => p.cat === cat.id).length;
        return `<button class="rail-cat" type="button" data-cat="${cat.id}" aria-haspopup="dialog" aria-expanded="false"
                    aria-label="${escapeHtml(cat.name)}, ${n} modules. Browse its modules." title="${escapeHtml(cat.name)} · browse">${iconSvg(cat.icon)}</button>`;
    }).join('')}
        </nav>
        <div class="library-foot">
            <button class="lib-foot-btn" type="button" data-act="file" aria-haspopup="menu" aria-expanded="false" aria-label="File" title="File">${iconSvg('folder')}<span class="lib-foot-label">File</span></button>
            <button class="lib-foot-btn" type="button" data-act="settings" aria-label="Settings" title="Settings">${iconSvg('gear-six')}<span class="lib-foot-label">Settings</span></button>
        </div>`;

    const search = root.querySelector('input');
    const scroll = root.querySelector('.library-scroll');

    function matches(p, q) {
        if (!q) return true;
        const hay = `${p.name} ${p.keywords || ''} ${C.ROLES[p.role].label} ${p.cat}`.toLowerCase();
        return q.split(/\s+/).every((word) => hay.includes(word));
    }

    function render() {
        const q = search.value.trim().toLowerCase();
        let html = '';
        for (const cat of C.CATEGORIES) {
            const items = C.PRESETS.filter((p) => p.cat === cat.id && matches(p, q));
            if (!items.length) continue;
            const open = q !== '' || !collapsed.has(cat.id);
            html += `<section class="lib-section" role="listitem">
                <button class="lib-section-head" type="button" aria-expanded="${open}" data-cat="${cat.id}">
                    ${iconSvg(cat.icon)}<span>${escapeHtml(cat.name)}</span>
                    <span class="lib-count">${items.length}</span>
                    ${iconSvg('caret-down', { cls: 'lib-section-caret' })}
                </button>
                <div class="lib-grid" ${open ? '' : 'hidden'}>
                    ${items.map((p) => `
                        <button class="lib-tile" type="button" draggable="true" data-preset="${p.id}" aria-pressed="${p.id === Store.state.preview}"
                                title="${escapeHtml(p.name)} · ${C.ROLES[p.role].label}">
                            <span class="role-tile" data-role="${p.role}">${iconSvg(p.icon)}</span>
                            <span class="lib-tile-name">${escapeHtml(p.name)}</span>
                        </button>`).join('')}
                </div>
            </section>`;
        }
        scroll.innerHTML = html || '<div class="lib-empty">No modules match</div>';
    }

    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
            e.stopPropagation();
            search.value = '';
            render();
        } else if (e.key === 'Enter') {
            const first = scroll.querySelector('.lib-tile');
            if (first) Store.previewPreset(first.dataset.preset);
        }
    });

    scroll.addEventListener('click', (e) => {
        const head = e.target.closest('.lib-section-head');
        if (head) {
            const id = head.dataset.cat;
            if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
            try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* not persisted */ }
            render();
            scroll.querySelector(`.lib-section-head[data-cat="${id}"]`)?.focus();
            return;
        }
        const tile = e.target.closest('.lib-tile');
        if (tile) Store.previewPreset(tile.dataset.preset);
    });

    scroll.addEventListener('dblclick', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (tile) Canvas.addAtCenter(tile.dataset.preset);
    });

    /** Mark the previewed module in the shelf and in an open category panel. */
    function markActive() {
        const id = Store.state.preview;
        for (const el of root.querySelectorAll('.lib-tile')) el.setAttribute('aria-pressed', String(el.dataset.preset === id));
        if (fly) for (const el of fly.el.querySelectorAll('.lib-flyout-item')) el.setAttribute('aria-pressed', String(el.dataset.preset === id));
    }
    Store.on((c) => { if (c.type === 'selection') markActive(); });

    scroll.addEventListener('dragstart', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (!tile) return;
        e.dataTransfer.setData('application/x-citrine-preset', tile.dataset.preset);
        e.dataTransfer.effectAllowed = 'copy';
        // Drag the coloured tile, not the whole button.
        const art = tile.querySelector('.role-tile');
        e.dataTransfer.setDragImage(art, 18, 18);
    });

    // ── Rail ───────────────────────────────────────────────────────────────

    const toggle = root.querySelector('[data-act="rail"]');
    const rail = root.querySelector('.library-rail');
    let railOn = false;
    try { railOn = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* default open */ }

    function setRail(on) {
        railOn = on;
        closeFlyout();
        root.classList.toggle('is-rail', on);
        document.documentElement.classList.toggle('has-rail', on);
        toggle.setAttribute('aria-expanded', String(!on));
        const label = on ? 'Expand modules' : 'Collapse modules';
        toggle.setAttribute('aria-label', label);
        toggle.title = `${label} (Ctrl+B)`;
        try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch { /* not persisted */ }
    }

    toggle.addEventListener('click', () => setRail(!railOn));
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
        if (e.target.closest('input, textarea, select')) return;
        e.preventDefault();
        setRail(!railOn);
    });

    // The panel for one category. It lives on the body so no pane clips it.
    let fly = null;

    function closeFlyout({ refocus = false } = {}) {
        if (!fly) return;
        const { el, btn } = fly;
        fly = null;
        el.remove();
        btn.setAttribute('aria-expanded', 'false');
        if (refocus) btn.focus();
    }

    function openFlyout(btn) {
        closeFlyout();
        const cat = C.CATEGORIES.find((c) => c.id === btn.dataset.cat);
        const items = C.PRESETS.filter((p) => p.cat === cat.id);
        const el = document.createElement('div');
        el.className = 'lib-flyout';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', `${cat.name} modules`);
        el.innerHTML = `
            <div class="lib-flyout-head">${iconSvg(cat.icon)}<span>${escapeHtml(cat.name)}</span><span class="lib-count">${items.length}</span></div>
            <div class="lib-flyout-list">${items.map((p) => `
                <button class="lib-flyout-item" type="button" draggable="true" data-preset="${p.id}" aria-pressed="${p.id === Store.state.preview}">
                    <span class="role-tile" data-role="${p.role}">${iconSvg(p.icon)}</span>
                    <span class="lib-flyout-name">${escapeHtml(p.name)}</span>
                    <span class="lib-flyout-role">${escapeHtml(C.ROLES[p.role].label)}</span>
                </button>`).join('')}</div>`;
        document.body.appendChild(el);
        const b = btn.getBoundingClientRect();
        const h = el.getBoundingClientRect().height;
        el.style.left = `${root.getBoundingClientRect().right + 8}px`;
        el.style.top = `${Math.max(8, Math.min(b.top - 8, window.innerHeight - h - 8))}px`;
        btn.setAttribute('aria-expanded', 'true');
        fly = { el, btn };
        el.querySelector('.lib-flyout-item')?.focus();

        el.addEventListener('click', (e) => {
            const item = e.target.closest('.lib-flyout-item');
            if (!item) return;
            Store.previewPreset(item.dataset.preset);
        });
        el.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.lib-flyout-item');
            if (!item) return;
            const id = item.dataset.preset;
            closeFlyout();
            Canvas.addAtCenter(id);
        });
        el.addEventListener('dragstart', (e) => {
            const item = e.target.closest('.lib-flyout-item');
            if (!item) return;
            e.dataTransfer.setData('application/x-citrine-preset', item.dataset.preset);
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setDragImage(item.querySelector('.role-tile'), 18, 18);
        });
        el.addEventListener('dragend', () => closeFlyout());
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeFlyout({ refocus: true }); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const all = [...el.querySelectorAll('.lib-flyout-item')];
            const i = all.indexOf(document.activeElement);
            all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus();
        });
    }

    rail.addEventListener('click', (e) => {
        const btn = e.target.closest('.rail-cat');
        if (!btn) return;
        if (fly && fly.btn === btn) closeFlyout(); else openFlyout(btn);
    });
    rail.addEventListener('keydown', (e) => {
        const btn = e.target.closest('.rail-cat');
        if (!btn) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); openFlyout(btn); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const all = [...rail.querySelectorAll('.rail-cat')];
        all[(all.indexOf(btn) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus();
    });
    document.addEventListener('pointerdown', (e) => {
        if (fly && !fly.el.contains(e.target) && !e.target.closest('.rail-cat')) closeFlyout();
    }, true);

    root.querySelector('[data-act="file"]').addEventListener('click', (e) => {
        const id = Store.state.activeId;
        UI.menu(e.currentTarget, [
            { label: 'New plan', icon: 'file-plus', onSelect: () => Store.newPlan() },
            { label: 'Import plan…', icon: 'download-simple', onSelect: () => Store.importPlan() },
            { label: 'Export plan…', icon: 'export', disabled: !id, onSelect: () => Store.exportPlan(id) },
        ]);
    });
    root.querySelector('[data-act="settings"]').addEventListener('click', () => Settings.open());

    render();
    if (railOn) setRail(true);

    window.Library = { focusSearch: () => { if (railOn) setRail(false); search.focus(); }, toggleRail: () => setRail(!railOn), isRail: () => railOn };
}());
