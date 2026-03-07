# Talotekniikka IFC Checker for Trimble Connect

A Trimble Connect embedded IFC quality-checking extension that preserves the original Talotekniikka checker rule behavior while running fully in the browser.

## Authorship and Credit

This repository intentionally separates original checker authorship from rewrite/extension work.

- **Original checker concept, domain logic, and rule content**: Markus Järvenpää / [tietomallintaja.fi](https://talotekniikka-tarkastaja.tietomallintaja.fi/)
- **Trimble Connect extension architecture and implementation in this repository**: Markus Mattila and contributors to this repository
- **Third-party runtimes/libraries**: their respective authors and license holders

See [AUTHORS.md](AUTHORS.md) for a dedicated ownership and attribution record.
Contribution workflow is documented in [CONTRIBUTING.md](CONTRIBUTING.md).
Security reporting process is documented in [SECURITY.md](SECURITY.md).

## Runtime Status and Entry Points

The repository currently contains two large bootstrap modules:

- **Active entry point used by `index.html`**: `app/projectFileIndex.js`
- **Legacy-compatible bootstrap retained for compatibility/reference**: `app/main.js`

Active runtime behavior is driven by `app/projectFileIndex.js`. The archived upstream bundle stays in `_orginalApp/` only for traceability and rule-parity extraction.

## What This Extension Does

- Connects to Trimble Connect Workspace API
- Detects the current Trimble project context
- Traverses project folders and lists IFC files
- Downloads selected IFC bytes directly into browser memory
- Parses IFC content with pinned `web-ifc` runtime (`0.0.77`)
- Runs rule checks using dataset extracted from the original checker
- Renders summary and object-level findings in the extension UI
- Exports checker report JSON and BCF draft JSON
- Optionally creates BCF topics through Trimble Topics API

## Repository Structure

```text
/
├─ app/
│  ├─ projectFileIndex.js           # active runtime bootstrap
│  ├─ main.js                       # legacy-compatible bootstrap
│  ├─ checker/
│  ├─ config/
│  ├─ reporting/
│  ├─ ui/
│  ├─ workspace/
│  └─ vendor/web-ifc/
├─ docs/
├─ scripts/
├─ tests/
├─ _orginalApp/                     # archived upstream reference bundle
├─ index.html
├─ styles.css
└─ manifest.json
```

## Documentation Index

- Installation and Trimble Connect onboarding:
  - [docs/installation-and-trimble-connect-setup.md](docs/installation-and-trimble-connect-setup.md)
- Data handling, API boundaries, and browser-vs-Trimble responsibilities:
  - [docs/data-handling-and-trimble-api-boundaries.md](docs/data-handling-and-trimble-api-boundaries.md)
- Open-source libraries, external dependencies, and documentation links:
  - [docs/open-source-dependencies.md](docs/open-source-dependencies.md)
- Trimble API integration notes:
  - [docs/trimble-connect-api-notes.md](docs/trimble-connect-api-notes.md)
- Rewrite and parity maintenance notes:
  - [docs/rewrite-notes.md](docs/rewrite-notes.md)
- Release readiness checklist:
  - [docs/release-readiness-checklist.md](docs/release-readiness-checklist.md)

## Development Quick Start

### Prerequisites

- Node.js with built-in `node --test` runner (Node 18+ recommended)
- Python 3 (for rule extraction/parity scripts)
- Static hosting capability (local or remote HTTPS)

### Run tests

```bash
npm test
```

### Run full release verification gates

```bash
npm run verify:release
npm run verify:dataset
```

This project also runs the same gates in GitHub Actions workflow:

- `.github/workflows/quality-gates.yml`

### Local static run example

```bash
python3 -m http.server 8080
```

Open: `http://localhost:8080/index.html`

Note: full extension behavior (Workspace events, access token, project APIs) requires Trimble Connect host context.

## Rule Dataset Maintenance Workflow

The rule dataset is extracted from archived upstream bundle:

- Source bundle: `_orginalApp/assets/index-DeuYOVjW.js`
- Generated dataset: `app/checker/rules/originalRuleDataset.json`

Update workflow:

```bash
python3 scripts/extract-original-rule-dataset.py
python3 scripts/verify-original-rule-parity.py
```

## External Documentation Links

- Trimble Connect developer documentation:
  - [https://developer.trimble.com/docs/connect](https://developer.trimble.com/docs/connect)
- Trimble Connect Workspace API reference:
  - [https://components.connect.trimble.com/trimble-connect-workspace-api/](https://components.connect.trimble.com/trimble-connect-workspace-api/)
- web-ifc package:
  - [https://www.npmjs.com/package/web-ifc](https://www.npmjs.com/package/web-ifc)
- web-ifc source repository:
  - [https://github.com/ThatOpen/engine_web-ifc](https://github.com/ThatOpen/engine_web-ifc)
- BCF API reference (buildingSMART):
  - [https://github.com/buildingSMART/BCF-API](https://github.com/buildingSMART/BCF-API)
