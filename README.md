# Aventurine Prism

A private, offline financial outlook simulator from the makers of Aventurine.

Build a plan on a canvas: drop in modules for income, accounts, spending, debts
and the things that change money on the way through (an employer match, a
tax), link them together, pick a time horizon, and see where
the money ends up month by month.

Every plan lives in one local file on your computer, optionally encrypted with a
password. Aventurine Prism makes no network calls.

## Run it

```bash
cd electron
npm install
npm start
```

## Check it

```bash
npm test          # simulator, plan rules, plans file, encryption (node --test)
npm run lint
npm run smoke     # backend under the real Electron runtime
npm run verify    # boots the app and asserts from inside the window
```

## License

GPL-3.0-or-later. Icons: [Phosphor](https://phosphoricons.com) (MIT). Fonts:
Manrope and IBM Plex Mono (SIL Open Font License).
