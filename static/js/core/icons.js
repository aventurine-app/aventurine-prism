'use strict';

// ─── icons.js ───────────────────────────────────────────────────────────────
// Inline SVG for a Phosphor icon by name. The markup comes from the generated
// core/icon-data.js (electron/scripts/make-ui-icons.js), never from user input,
// so it can go straight into innerHTML.
//
//   iconSvg('piggy-bank')

(function () {
    const DATA = window.CITRINE_ICON_DATA || { regular: {} };

    function iconSvg(name, { cls = '' } = {}) {
        const inner = DATA.regular[name] || DATA.regular['squares-four'] || '';
        const klass = cls ? `icon ${cls}` : 'icon';
        return `<svg class="${klass}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
    }

    window.iconSvg = iconSvg;
}());
