# Open-Source and External Dependencies

This document describes which external libraries/services are used, why they are used, and where to find their official documentation.

## 1. Browser runtime dependencies

| Component | Version / Pin | Used for | Where in this repository | Official docs / source |
|---|---|---|---|---|
| `web-ifc` | `0.0.77` (pinned) | Browser-side IFC parsing (`IfcAPI`) before running rule checks | `app/vendor/web-ifc/web-ifc-api-iife.js`, `app/vendor/web-ifc/web-ifc.wasm`, `app/config/webIfcRuntime.js` | [npm package](https://www.npmjs.com/package/web-ifc), [GitHub repository](https://github.com/ThatOpen/engine_web-ifc) |
| Trimble Connect Workspace API script | Loaded from Trimble CDN at runtime | Extension-to-host communication (events, permissions, project context, UI menu/status) | Script tag in `index.html` | [Workspace API docs](https://developer.trimble.com/docs/connect/workspace-api/), [Workspace API reference](https://components.connect.trimble.com/trimble-connect-workspace-api/) |

## 2. Remote platform APIs used by the extension

These are not open-source libraries, but they are core external dependencies used by implementation code.

| API | Used for | Main code areas | Documentation |
|---|---|---|---|
| Trimble Connect Core API (`/tc/api/2.0`) | Project folder traversal, file listing, signed IFC download URL lookup | `app/projectFileIndex.js`, `app/workspace/trimbleFileService.js` | [Trimble Connect docs](https://developer.trimble.com/docs/connect) |
| Trimble Topics API (`/bcf/3.0`) | Optional BCF extension read/update and topic/viewpoint creation | `app/projectFileIndex.js` | [Trimble Connect docs](https://developer.trimble.com/docs/connect) |

## 3. Development and maintenance dependencies

| Tooling | Used for | Where |
|---|---|---|
| Node.js built-in test runner (`node --test`) | Unit/smoke test execution | `package.json`, `tests/` |
| Python 3 standard library scripts | Rule dataset extraction and parity verification | `scripts/extract-original-rule-dataset.py`, `scripts/verify-original-rule-parity.py` |
| `curl` + `perl` (shell script) | Vendored `web-ifc` runtime sync and version pin update | `scripts/sync-web-ifc-runtime.sh` |

## 4. License and attribution notes

- `web-ifc` is an external open-source project. Review its upstream package metadata and repository for current license terms.
- Trimble APIs and hosted scripts are provided by Trimble and follow Trimble's platform terms.
- This repository keeps original checker authorship explicit in [AUTHORS.md](../AUTHORS.md) and [README.md](../README.md).

## 5. Quick verification checklist for future updates

When dependencies are updated:

1. Confirm version pin updates in code (`app/config/webIfcRuntime.js`) and vendored files.
2. Run tests.
3. Re-check API endpoint compatibility for Workspace/Core/Topics usage.
4. Update this file with new versions, links, and rationale.
