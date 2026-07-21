# Security Policy

## Reporting a vulnerability

Please do **not** file public issues for security vulnerabilities. Report them privately via GitHub Security Advisories:

https://github.com/AndresCarreonDiaz/capturia/security/advisories/new

We aim to acknowledge reports within 3 business days and triage within 7. Critical issues will be addressed as quickly as possible.

## In scope

- Code execution vulnerabilities in the Capturia desktop app (Electron main process, preload, IPC handlers).
- Key vault leaks: any path that could expose, leak, or weaken encryption of a BYOK API key stored via `electron/keychain.js`.
- Secrets handling: any code path that could log, transmit, or persist a user's API key in plaintext.
- Audio handling: any code path that would transmit raw mic audio off-device when local STT is selected.

## Out of scope

- Issues in transitive dependencies (please report upstream first; we will track via Dependabot).
- Attacks requiring physical access to the user's machine.
- Issues affecting only forks with custom modifications.
- Issues in the hosted Capturia Pro service (billing, entitlements, the LLM proxy): report those to **capturia@andresio.com**. The code lives in this repo, so an advisory through the link above works too; the email is the faster channel for anything involving the live service.

## After the fix

Once a fix is released, we'll credit reporters in the release notes with their permission.
