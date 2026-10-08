'use strict';

// ─── escape.js ──────────────────────────────────────────────────────────────
// The one HTML escaper, loaded before every other script. Every string a user
// typed (plan names, module names) or a file supplied (an imported plan) MUST
// pass through it before reaching innerHTML. It escapes quotes as well, so it
// is safe inside attribute values too. The CSP is the backstop, not the
// defence.

(function () {
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    window.escapeHtml = escapeHtml;
}());
