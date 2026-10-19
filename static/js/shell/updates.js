'use strict';

// ─── updates.js ─────────────────────────────────────────────────────────────
// Software updates (Preferences → About). Draws the update state the main
// process holds (electron/updater.js) and sends the user's choices back over
// the electronUpdater bridge (preload.js). Every decision is made in the main
// process; this file only renders what it's told.
//
// Two surfaces:
//   • The Updates section of the About tab: the Automatic Updates switch, a
//     status line, a progress bar and one action button at a time.
//   • A toast when a background check turns something up while Preferences is
//     closed, so a ready update isn't left unseen behind the modal.
//
// State arrives two ways: getState() once when the page loads, then every
// change as an 'update:status' push. Both carry the same snapshot, and they
// arrive in the order the main process sent them, so the latest one to arrive
// is always the one to draw. The action calls' own return values are ignored
// for that reason, since each change they cause is pushed anyway.
//
// In a plain browser the bridge is absent and the section stays hidden.
//
// Same behaviour as Aventurine Manage's updates.js, in Prism's controls.

(function () {
    const updater = window.electronUpdater;
    const section = document.querySelector('[data-updates-section]');
    if (!updater || !section) return;

    const autoDesc   = section.querySelector('[data-update-auto-desc]');
    const autoSwitch = section.querySelector('[data-update-auto]');
    const statusEl   = section.querySelector('[data-update-status]');
    const errorEl    = section.querySelector('[data-update-error]');
    const progressEl = section.querySelector('[data-update-progress]');
    const barEl      = section.querySelector('[data-update-progress-bar]');
    const buttons = {
        check:            section.querySelector('[data-update-action="check"]'),
        download:         section.querySelector('[data-update-action="download"]'),
        install:          section.querySelector('[data-update-action="install"]'),
        openDownloadPage: section.querySelector('[data-update-action="open-download-page"]'),
    };
    const prefsModal = document.getElementById('prefs');

    const PRIVACY_NOTE = 'Checks only ask GitHub for the latest version number. Nothing about you or your plans is sent.';

    // What "automatic" does depends on what this install can do
    // (updatePolicy.js, resolveUpdateMode).
    const AUTO_DESCRIPTIONS = {
        replace: 'Checks for a new version when Aventurine Prism starts and every few hours, downloads it in the background, and installs it the next time you quit.',
        package: 'Checks for a new version when Aventurine Prism starts and every few hours and downloads it in the background. Installing needs your administrator password, so it waits for you to choose Restart & Install.',
        notify:  'Checks for a new version when Aventurine Prism starts and every few hours. This copy can’t install updates itself, so you’ll get a link to the download page.',
    };

    let current = null;

    function statusText(s) {
        const version = `version ${s.newVersion}`;
        switch (s.state) {
            case 'checking':    return 'Checking for updates…';
            case 'up-to-date':  return `You have the latest version, ${s.currentVersion}.`;
            case 'available':   return `Aventurine Prism ${s.newVersion} is available.`;
            case 'downloading': return `Downloading ${version} (${Math.floor(s.percent || 0)}%)…`;
            case 'downloaded':  return s.mode === 'package'
                ? `Aventurine Prism ${s.newVersion} is ready. Installing asks for your administrator password.`
                : `Aventurine Prism ${s.newVersion} is ready. It installs when you quit, or you can restart now.`;
            case 'installing':  return `Installing ${version}…`;
            // idle, and error (whose message shows on its own line below)
            default:            return `You have version ${s.currentVersion}.`;
        }
    }

    // The single action each state offers. Downloading offers none: there is
    // nothing to do but wait. Installing keeps its button, busy, so the row
    // doesn't jump in the moment before the app quits.
    function actionFor(s) {
        switch (s.state) {
            case 'available':   return s.mode === 'notify' ? 'openDownloadPage' : 'download';
            case 'downloaded':
            case 'installing':  return 'install';
            case 'downloading': return null;
            default:            return 'check';
        }
    }

    function markSwitch(autoUpdate) {
        autoSwitch.querySelectorAll('.seg-switch-btn').forEach((b) => {
            b.setAttribute('aria-pressed', String((b.dataset.value === 'on') === autoUpdate));
        });
    }

    function setBusy(button, busy) {
        button.disabled = busy;
        button.classList.toggle('is-busy', busy);
    }

    function render(s) {
        current = s;
        section.hidden = false;

        autoDesc.textContent = `${AUTO_DESCRIPTIONS[s.mode] || AUTO_DESCRIPTIONS.notify} ${PRIVACY_NOTE}`;
        markSwitch(s.autoUpdate);

        statusEl.textContent = statusText(s);
        errorEl.textContent = s.error || '';
        errorEl.hidden = !s.error;

        const downloading = s.state === 'downloading';
        progressEl.hidden = !downloading;
        if (downloading) {
            const pct = Math.max(0, Math.min(100, Number(s.percent) || 0));
            barEl.style.transform = `scaleX(${pct / 100})`;
            progressEl.setAttribute('aria-valuenow', String(Math.round(pct)));
        }

        const action = actionFor(s);
        for (const [name, btn] of Object.entries(buttons)) btn.hidden = name !== action;
        // Busy buttons stay where they are, disabled, so the row doesn't jump
        // and a second click can't queue another check or install.
        const checking = s.state === 'checking';
        setBusy(buttons.check, checking);
        buttons.check.textContent = checking ? 'Checking…' : 'Check for Updates';
        setBusy(buttons.install, s.state === 'installing');
    }

    // Toast only when a background check changes something the user can act on,
    // and only while Preferences is closed. With it open, the status row is
    // already in view.
    function announce(prev, s) {
        if (prefsModal && !prefsModal.hidden) return;
        if (prev && prev.state === s.state) return;
        if (s.state === 'downloaded') {
            UI.toast(s.mode === 'package'
                ? `Aventurine Prism ${s.newVersion} is ready to install.`
                : `Aventurine Prism ${s.newVersion} is ready. It installs when you quit.`, {
                duration: 10000,
                action: { label: 'Restart & Install', onClick: restartAndInstall },
            });
        } else if (s.state === 'available' && s.mode === 'notify') {
            UI.toast(`Aventurine Prism ${s.newVersion} is available.`, {
                duration: 10000,
                action: { label: 'Download', onClick: openDownloadPage },
            });
        }
    }

    // The main process turns every update failure into an 'error' state, so a
    // rejected call here means the bridge itself failed. Log it for debugging.
    function call(fn) {
        return fn().catch((err) => console.error('[updates]', err));
    }

    // The app quits to install, so pending plan edits are saved first. A save
    // that fails keeps the app open: Store has already said why, with a Retry.
    // Saving here also lets the window close at once on the way out, which
    // updater.js's install() relies on.
    async function restartAndInstall() {
        try {
            if (window.Store && !(await Store.flush())) return;
        } catch (err) {
            console.error('[updates] saving before the install failed:', err);
            UI.toast('Your changes couldn’t be saved, so the update wasn’t installed.', { type: 'error' });
            return;
        }
        call(updater.install);
    }

    function openDownloadPage() {
        updater.openDownloadPage().catch((err) => {
            console.error('[updates] opening the download page failed:', err);
            UI.toast('Couldn’t open the download page.', { type: 'error' });
        });
    }

    buttons.check.addEventListener('click', () => call(updater.check));
    buttons.download.addEventListener('click', () => call(updater.download));
    buttons.install.addEventListener('click', restartAndInstall);
    buttons.openDownloadPage.addEventListener('click', openDownloadPage);

    // The switch is the one control whose answer isn't pushed (it changes a
    // preference, not the update state), so its reply is drawn directly. If the
    // save fails, the switch goes back to what is actually stored.
    autoSwitch.addEventListener('click', async (e) => {
        const b = e.target.closest('.seg-switch-btn');
        if (!b || !current) return;
        const enabled = b.dataset.value === 'on';
        if (enabled === current.autoUpdate) return;
        markSwitch(enabled);
        try {
            render(await updater.setAutoUpdate(enabled));
        } catch (err) {
            console.error('[updates] saving Automatic Updates failed:', err);
            markSwitch(current.autoUpdate);
            UI.toast('Couldn’t save the Automatic Updates setting.', { type: 'error' });
        }
    });

    updater.onStatus((s) => {
        const prev = current;
        render(s);
        announce(prev, s);
    });

    updater.getState()
        .then(render)
        .catch((err) => console.error('[updates] reading the update state failed:', err));
}());
