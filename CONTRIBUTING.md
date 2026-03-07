# Contributing Guide

Thank you for contributing to this repository.

## Development prerequisites

- Node.js `18+`
- Python `3+`

## Local quality gates

Run these commands before opening a pull request:

```bash
npm run verify:release
npm run verify:dataset
```

What these commands validate:

- Node.js test suite is passing.
- Rule parity extraction checks are passing.
- Rule dataset extraction stays deterministic and does not create unexpected diffs.

## Pull request expectations

1. Keep changes focused and reviewable.
2. Add or update tests for behavior changes.
3. Update documentation when runtime behavior, setup, or commands change.
4. Keep authorship and attribution records up to date when required (`AUTHORS.md`, `README.md`).

## Documentation references

- Main overview: `README.md`
- Installation and setup: `docs/installation-and-trimble-connect-setup.md`
- Data/API boundaries: `docs/data-handling-and-trimble-api-boundaries.md`
- Dependency references: `docs/open-source-dependencies.md`
- Release checklist: `docs/release-readiness-checklist.md`
