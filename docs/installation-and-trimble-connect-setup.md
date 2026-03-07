# Installation and Trimble Connect Setup

This guide explains how to run the extension locally, publish it, and install it into Trimble Connect.

## 1. Prerequisites

- Node.js (recommended: 18+)
- Python 3
- HTTPS-capable static hosting target (for example GitHub Pages)
- Access rights to add/use extensions in your Trimble Connect environment

## 2. Local verification before publishing

### 2.1 Run tests

```bash
npm test
```

### 2.2 Run release verification gates

```bash
npm run verify:release
npm run verify:dataset
```

### 2.3 Serve static files locally

```bash
python3 -m http.server 8080
```

Open:

- `http://localhost:8080/index.html`

Important: local host mode is only for UI and static checks. Full API behavior requires Trimble Connect host context.

## 3. Prepare hosted deployment

The extension is static and should be hosted as plain web assets:

- `index.html`
- `styles.css`
- `app/**`
- `manifest.json`

### 3.1 Verify manifest values

`manifest.json` must point to the final hosted URL:

- `url`: full HTTPS URL to `index.html`
- `title`: extension display name
- `icon`: publicly reachable icon URL
- `enabled`: `true`

Example:

```json
{
  "icon": "https://example.com/icon.png",
  "title": "IFC Checker",
  "url": "https://example.com/trimble-lab/index.html",
  "description": "Trimble Connect IFC content validation extension",
  "enabled": true
}
```

## 4. Install into Trimble Connect

UI labels may vary slightly by Trimble Connect version/tenant, but the flow is generally:

1. Open Trimble Connect in browser.
2. Navigate to the Extensions management area.
3. Choose to add/register an extension via manifest URL.
4. Provide the public HTTPS URL to your `manifest.json`.
5. Save and enable the extension.
6. Open a project and launch the extension.

## 5. First-run permission and runtime checks

On first use, the extension requests access token permission via Workspace API.

Expected behavior:

1. Permission request is shown by Trimble Connect.
2. IFC files from current project load into the extension table.
3. You can select and download one IFC file to browser memory.
4. You can run checks and export report JSON / BCF draft.
5. You can optionally create BCF topics if project/API permissions allow it.

## 6. Troubleshooting

### Extension UI loads, but no files are listed

- Confirm project context is open in Trimble Connect.
- Confirm access token permission is granted.
- Confirm user has project file read permissions.

### IFC download fails

- Confirm selected row is an IFC file.
- Confirm file has valid `fileId` and `versionId` in source payload.
- Confirm Core API endpoint access is allowed for current user/project.

### BCF topic creation fails

- Confirm user has Topics API permissions for the project.
- Confirm extension can resolve project BCF extensions.
- Confirm selected findings exist and modal has at least one enabled topic row.

## 7. Developer handover checklist

Before handing over to next developer:

1. Verify hosted URL in `manifest.json` is still valid.
2. Verify runtime pin in `app/config/webIfcRuntime.js` matches vendored files.
3. Run release gates (`npm run verify:release` and `npm run verify:dataset`).
4. Verify GitHub workflow `.github/workflows/quality-gates.yml` is green.
5. Verify docs are aligned:
   - `README.md`
   - `AUTHORS.md`
   - `docs/open-source-dependencies.md`
   - `docs/data-handling-and-trimble-api-boundaries.md`
