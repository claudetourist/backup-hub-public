# Security

## Reporting a problem

Please report security problems privately, not in a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") or contact the maintainers privately. Include what you did, what you expected and what happened. Do not include real files, tokens or keys.

## How secrets are handled

- **Google keys and sign-ins** (the OAuth client secret and each account's refresh token) are kept in an encrypted vault, never in plain text. Each secret is sealed with AES-256-GCM under a random key.
- That key is protected for this Windows user on this computer with Electron's `safeStorage` (Windows DPAPI). Nothing readable is left in the database or the settings file.
- An optional **recovery passphrase** (at least 12 characters, stretched with scrypt) lets you move the saved sign-ins to another computer. Without one, sign-ins are tied to this PC and you would sign in again elsewhere.
- **Tokens are never logged.** Every log line passes through a redaction step that removes access tokens, refresh tokens, authorisation codes, client secrets and email addresses. A Google upload's session address is treated as secret too and is never logged.
- Exported settings never include passwords or Google sign-ins.
- The sign-in uses a one-time address on `127.0.0.1` with PKCE and a random `state` check, and the app only talks to Google's own addresses.
- **Google Keep notes** are copied byte for byte but never read, logged or stored in the database: only names, sizes and checksums are.
- The window runs with Electron's protections on: no pop-ups, no navigation away from the app, a strict content security policy, every permission denied, and every message between window and engine checked against a schema.

## What the app never does

- It does not send your files or your catalogue anywhere except to the Google accounts you add yourself.
- It has no telemetry and no update check that sends data.
- It does not delete or overwrite backup copies.

## Things to know

- The repository contains no keys. You bring your own Google OAuth client.
- Anyone who can run programs as your Windows user can use the vault the way the app does; that is the limit of DPAPI protection.
- Fake keys that look like `GOCSPX-...` in the tests are obviously made up.

## Supported versions

Only the latest commit on the main branch.
