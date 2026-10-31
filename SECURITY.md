# Security Policy

## Supported

This repo is in early build, test mode only. Security reports are
welcome at any time, even before a release.

## Reporting

Open a GitHub issue describing the problem without including a
real secret, a real credential, or an exploit that would harm a
tenant. If a report needs a private channel, say so in the issue
and the owner will provide one.

## What this project promises, and what it does not

Full layered design: provisioning/SECURITY.md. In short, tenant
isolation, Sigil on every tool call, egress allowlists, per-tenant
secrets, audit ledgers, and human gates on spend, money moves,
and destructive actions are the design.

What it does not promise yet: PII never leaves a business, Sealbox
is shipped, or a badge proves competence. Those claims must not
appear in sales text until the relevant layer is wired and tested.
