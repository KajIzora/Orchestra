# Security

Orchestra is a **local-only** macOS app. It is designed to run on one machine,
for one person, and to keep your data on that machine.

## What Orchestra does and does not do

- **No telemetry.** Orchestra does not phone home, send analytics, or make any
  outbound network requests. You can verify this in `server.js`.
- **Localhost by default.** The server binds to `127.0.0.1` unless you set
  `HOST` yourself. It has **no built-in authentication** — anyone who can reach
  the port can use the API. Do not bind it to `0.0.0.0` or expose it through a
  tunnel on a network you do not fully trust.
- **It runs shell commands you configure.** The *Open Workspace*, task *Focus*,
  and watcher features execute shell commands and scripts — including over SSH —
  that **you** author. Orchestra does not sandbox or validate them. Only enter
  commands you trust, and only run Orchestra on a machine you trust.
- **Your data stays local.** Tasks live in a JSON file under your home
  directory. There is no Orchestra account or hosted backend.

## Tokens

Hook and browser-extension tokens are generated at runtime and stored outside
the repository (under your data directory). No token is hardcoded in the code.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the **Security** tab) rather than opening a public
issue. We aim to respond within a few days.

## Supported versions

Only the latest version on the default branch is supported.
