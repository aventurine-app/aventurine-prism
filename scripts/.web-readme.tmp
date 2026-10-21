# Web build

Runs Aventurine Prism in a browser. Plans are stored in the visitor's own
browser (IndexedDB); no server ever sees them. This folder is the Node tooling;
the code that runs in the browser is `static/js/web/`.

## Commands

Run from `electron/` (that is where Node's dev dependencies are), or call the
files directly with `node web/<file>` from the repo root.

```
npm run web          dev server on http://127.0.0.1:5174, no build step
npm run web:build    writes the deployable app to web/dist/
npm run web:test     unit tests for the browser backend and the build
npm run web:verify   drives a real Chromium through the whole app
```

## How it fits together

The app never talked to a server, only to `window.citrineApi.request(method,
url, body)`. On the desktop that went over IPC to a Node backend; in the
browser `static/js/web/` answers it instead, with the same URLs, bodies and
status codes. The rest of the app is unchanged.

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

`api-error`, `plan-files`, `session`, `workspace` and `backend` are
dual-environment (they also `require()` under Node), which is how they are
tested without a browser. `storage`, `file-dialogs` and `boot` need browser
APIs and are covered by `web:verify`.

## Decisions worth knowing

- **Writes start in the same tick as the request.** A save made while the page
  is closing cannot be awaited, but a started IndexedDB transaction still
  commits. Nothing in `backend.js` or `workspace.js` may `await` before it
  starts a write or opens a file picker (a picker needs the click that asked).
- **One editing tab.** Each tab loads every plan and writes back what it
  changes, so two tabs would overwrite each other. A second tab waits, then
  loads the plans only after the first closes, so it sees the final saves.
- **No encryption at rest in the browser.** The desktop vault uses scrypt, which
  WebCrypto does not provide. Anyone who can read the browser profile can read
  the plans, as with any web app's local data.
- **Unreadable stored plans are left alone.** A plan that fails validation
  (saved by a newer build) is counted but never rewritten or deleted.
- **Bodies are copied** (`structuredClone`) at the backend boundary, as IPC did,
  so the page and the workspace never share an object.

## Not done yet

Accounts and billing, hosting (security headers, caching), an "export your
plans" reminder, and removing the Electron shell (`electron/`, still used by
the desktop build and by the shared tests).
