# Contributing

Thanks for looking. This is a small personal project, so keep changes small and say why.

## Setup

```
npm ci
npm test
npm run typecheck
npm run lint
```

Run all three of the last commands before you open a pull request; CI runs the same ones on Windows.

## Ground rules

- Read `CLAUDE.md` first. Each line is a mistake that already cost real time (a frozen window, a slow query, a lost file).
- The safety rules are not negotiable: never overwrite, never delete without three checked copies, nothing starts by itself. A change that weakens one needs a very good reason and a test.
- Never freeze the window. A database read over a few hundred rows, a folder walk or a hash does not belong on the main thread. New screens and IPC calls get a main-thread block test (see `CLAUDE.md`).
- Tests use fake worlds and temporary folders. A test must never touch your real data, drives, phone or Google account. Development runs need `BACKUPHUB_DATA_DIR` set to a temporary folder.
- Keep the plain words. The window uses everyday language; `src/renderer/plainWords.test.ts` checks it.
- No personal data in the repository: no real names, device serials, email addresses, paths under a user profile, or keys. `src/publicReady.test.ts` fails if one slips in. Use obviously fake values such as `alice@example.com` and `SERIAL0001`.
- Follow the style that is already there. Do not rename or tidy code outside the change.

## Pull requests

One topic per pull request. Describe what changed, how you tested it, and anything you are unsure about.

Security problems: do not open a public issue; see SECURITY.md.
