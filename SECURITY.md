# Security Policy

## Supported versions

This repository currently maintains only the latest `main` branch state.

## Reporting a vulnerability

If you discover a security issue:

1. Do not open a public issue with exploit details.
2. Contact the maintainer directly using repository owner contact details.
3. Include:
   - Reproduction steps
   - Impact assessment
   - Suggested remediation (if available)

We will acknowledge the report and evaluate mitigation as soon as possible.

## Scope notes

This project runs as a Trimble Connect browser extension and depends on:

- Trimble Workspace API
- Trimble Core API
- Trimble Topics API
- Vendored `web-ifc` runtime

Security posture therefore depends on both repository code and upstream platform behavior.
