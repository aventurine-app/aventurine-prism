# Aventurine Prism

A private financial outlook simulator that runs in your browser, from the makers
of Aventurine.

Build a plan on a canvas: drop in modules for income, accounts, spending, debts
and the things that change money on the way through (an employer match, a
tax), link them together, pick a time horizon, and see where the money ends up
month by month.

Your plans stay in your browser. They are stored on your own device and never
sent to a server, and Prism does not connect to your bank. Export a plan to a
plain JSON file to keep a copy or move it to another browser.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:5174, no build step; reload to see edits
```

## Check it

```bash
npm test           # simulator, plan rules, browser backend, build (node --test)
npm run lint
npm run build      # writes the deployable app to dist/
npm run verify     # drives a real Chromium through the whole app
```

`npm run verify` uses Electron only as a Chromium to drive; it is not part of
the app. It checks storage in IndexedDB, a reload, a save made as the page
closes, the one-editing-tab rule, export and import, and the Storage
preferences.

## How it fits together

The app is plain HTML, CSS and JavaScript served as written, with no bundler.
It never asks a server for anything about your plans: everything it reads or
saves goes through `window.citrineApi.request(method, url, body)`, which
`static/js/web/` answers from IndexedDB.

| File (`static/js/web/`) | Job |
|---|---|
| `api-error.js` | The error type a handler throws; becomes `{ status, body }` |
| `plan-files.js` | The exported plan file: format, parsing, file names (pure) |
| `session.js` | One editing tab at a time, using a Web Lock |
| `storage.js` | IndexedDB: one record per plan, plus the tab order, written atomically |
| `workspace.js` | The plans in memory, mirrored to storage; validation and limits |
| `backend.js` | The URL map: routes requests to the workspace |
| `file-dialogs.js` | Save and open a plan file with the browser's dialogs |
| `boot.js` | Wires the above together and installs `window.citrineApi` |

`api-error`, `plan-files`, `session`, `workspace` and `backend` also `require()`
under Node, which is how they are tested without a browser. `storage`,
`file-dialogs` and `boot` need browser APIs and are covered by `npm run verify`.

### Decisions worth knowing

- **Writes start in the same tick as the request.** A save made while the page
  is closing cannot be awaited, but a started IndexedDB transaction still
  commits. Nothing in `backend.js` or `workspace.js` may `await` before it
  starts a write or opens a file picker (a picker needs the click that asked).
- **One editing tab.** Each tab loads every plan and writes back what it
  changes, so two tabs would overwrite each other. A second tab waits, then
  loads the plans only after the first closes, so it sees the final saves.
- **No encryption at rest.** Anyone who can read the browser profile can read
  the plans, as with any web app's local data.
- **Unreadable stored plans are left alone.** A plan that fails validation
  (saved by a newer build) is counted but never rewritten or deleted.
- **Bodies are copied** (`structuredClone`) at the backend boundary, so the page
  and the workspace never share an object.
- **Legacy names.** The plan file format is `citrine-plan` and the data bridge is
  `citrineApi`, from before the product was named Prism. Plan files exported
  from the earlier desktop app still import.

## Not built yet

Accounts and billing (a paid subscription), hosting (security headers,
caching), and a reminder to export plans.

## License

GPL-3.0-or-later. Icons: [Phosphor](https://phosphoricons.com) (MIT). Fonts:
Manrope and IBM Plex Mono (SIL Open Font License).
