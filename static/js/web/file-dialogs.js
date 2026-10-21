'use strict';

// ─── file-dialogs.js ────────────────────────────────────────────────────────
// Saving and picking plan files in the browser:
//
//   save   a "save as" dialog where the browser has one (Chrome, Edge), else
//          an ordinary download
//   open   a file picker
//
// Both must run inside the click that asked for them or the browser refuses
// to show anything, so nothing here waits before it opens the dialog.

(function () {
    const { ApiError, PlanFiles } = window.PrismWeb;

    const PLAN_TYPES = [{ description: 'Aventurine Prism Plan', accept: { 'application/json': ['.json'] } }];
    const IMPORT_ACCEPT = '.json,.prism,.citrine-plan,application/json';

    function download({ name, text }) {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        // Revoke after the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /** Save a file. Resolves false if the user cancels the dialog. */
    async function save({ name, text }) {
        if (typeof window.showSaveFilePicker !== 'function') {
            download({ name, text });
            return true;
        }
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: name, types: PLAN_TYPES });
        } catch (e) {
            if (e && e.name === 'AbortError') return false;
            // The dialog was refused (embedded page, no recent click): a download still works.
            download({ name, text });
            return true;
        }
        const writable = await handle.createWritable();
        try {
            await writable.write(text);
        } finally {
            await writable.close();
        }
        return true;
    }

    /** Let the user pick a plan file. Resolves its text, or null if they cancel. */
    function open() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = IMPORT_ACCEPT;
            input.hidden = true;
            // Some browsers only fire events for inputs that are in the page.
            document.body.append(input);
            const done = (settle, value) => {
                input.remove();
                settle(value);
            };
            input.addEventListener('cancel', () => done(resolve, null));
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) return done(resolve, null);
                if (file.size > PlanFiles.MAX_IMPORT_BYTES) {
                    return done(reject, new ApiError('file is too large to be a plan', 422));
                }
                try {
                    return done(resolve, await file.text());
                } catch {
                    return done(reject, new ApiError('file could not be read', 422));
                }
            });
            input.click();
        });
    }

    window.PrismWeb = Object.assign(window.PrismWeb || {}, { fileDialogs: { save, open } });
}());
