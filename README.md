# Backup Hub

A Windows desktop app that keeps your family's files safe and tells you plainly whether they are.

Backup Hub backs up **Android phones (over adb)**, **laptop folders** and **OneDrive** to **two backup drives** and to **Google accounts**. It checks every copy by **checksum**, and it offers to **free phone space only when three checked copies exist** (the first drive, the second drive and Google).

> Status: a personal project. It works on its author's own data. Windows only. Read the safety rules below before pointing it at anything you care about, and keep your own second backup while you try it.

## Safety rules

These are enforced in code and covered by tests, not just promised here.

- **Never overwrite.** A backup only adds new files and new dated folders. A file that would land on an existing one is a decision for you, not a replacement.
- **Never delete without three proofs.** A file leaves your phone only after the same bytes (same SHA-256) are confirmed on the first drive, on the second drive and in Google, and you confirmed the exact number on screen. Every removal goes through one reviewed place (`src/main/danger/`).
- **Nothing starts by itself.** No background copy, no timer-started job. Every copy, check and removal starts from a button you pressed.
- **Never freeze the window.** Heavy work runs off the window's thread, and tests fail if a screen blocks it.
- **Private things stay private.** Google sign-ins are kept encrypted and are never written to logs. Google Keep notes are copied but never read or logged.

## Features

- Phone backup over adb: look at the phone, preview exactly what will be copied, copy with a checksum for every file, report what was left out and why. Read-only on the phone.
- Folder backup for laptop folders and OneDrive (OneDrive files that are online only are never downloaded behind your back).
- Second drive: bring the second backup drive up to date from the first, then check old copies by reading them again.
- Google accounts: upload to several Drive accounts, with a free-space line kept per account; the copy is accepted only when Google's own checksum matches.
- Free up phone space: lists only files that are already safe in three places.
- Files search over every place at once, with "where are the copies of this file".
- Restore: copy files back into a new folder, verified, never replacing anything.
- Renamed or moved files are recognised, so nothing is copied twice.
- Pause everything, a plain activity list, and one "needs your decision" list for anything unusual.

## Screenshots

Screenshots are taken from the built-in mock, which uses fake data only. To see a screen yourself:

```
npx vite --config vite.renderer.config.ts
```

then open `http://localhost:5173/#/<screen>?mock` (for example `#/home?mock`, `#/backups?mock`, `#/devices?mock`, `#/files?mock`, `#/free-up-space?mock`, `#/activity?mock`, `#/settings?mock`).

## Requirements

- Windows 10 or 11.
- Node.js 22 or newer (see `engines` in `package.json`) and npm, to build and run from source.
- For phone backups: **adb** from Android's [platform-tools](https://developer.android.com/tools/releases/platform-tools). Backup Hub looks for it in this order: the `BACKUPHUB_ADB` environment variable (the full path to `adb.exe`), your `PATH`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT` / Android Studio's default folder. On the phone, turn on USB debugging and accept the computer's key when asked.
- For the Google features: your own **Google Cloud OAuth client** (below). Backup Hub ships with no Google keys.

### Setting up the Google OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project, and enable the **Google Drive API**.
2. Under **APIs and Services, OAuth consent screen**, set up the app (External is fine) and add your own Google accounts as test users.
3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**.
4. In Backup Hub, open **Devices**, and paste the client ID and client secret into the Google app key box. They are stored encrypted on this PC (see SECURITY.md).
5. Press **Add a Google account** and sign in in your browser. Sign-in uses a one-time local address (`127.0.0.1`, random port); tick every permission box.

Note: while the OAuth consent screen is in the **Testing** state, Google expires each sign-in after **7 days**. For long-term use, publish the app (set it to **In production**; for your own use it can stay unverified) so the sign-ins last.

## Getting started

```
npm ci
npm start           # run the app from source
npm test            # the test suite
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint
npm run package     # build BackupHub.exe into out/
```

Where things live:

- Data and logs: `%APPDATA%\Backup Hub\data` and `...\logs`. To use other folders, put `{"dataDir": "...", "logsDir": "..."}` in `%APPDATA%\BackupHub\location.json`.
- Development runs (`npm start`) refuse to open the real data folder: set `BACKUPHUB_DATA_DIR` to a temporary folder first.
- Drives are told apart by a small ID file on the drive, not by their letter. You name each backup drive once in the app.

Other settings, all optional environment variables: `BACKUPHUB_ADB`, `BACKUPHUB_FIRST_FOLDER` (an extra folder the laptop lists first), `BACKUPHUB_PHONEBACKUP_CONFIG` (an older tool's settings file to import).

## Project layout

- `src/main/`: the app's engine (Electron main process): database and migrations, jobs, listing, hashing, adb, Google, copies, clean-up, the safety guards.
- `src/renderer/`: the window (React). `src/renderer/dev/` holds the fake-data mock used for screenshots and the dev gallery.
- `src/shared/`: types and pure rules shared by both sides, including the IPC contract.
- `src/preload/`: the narrow bridge between window and engine.
- `scripts/`: the benchmark on a generated 2-million-row database and a few read-only preview tools.
- `docs/CODEMAP.md`: a file-by-file map. `CLAUDE.md`: lessons learned, worth reading before you change code.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
