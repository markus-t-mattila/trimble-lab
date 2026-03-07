# Rewrite Notes (No Legacy Runtime)

This project has been rewritten so the active app no longer depends on:

- `_orginalApp/`

Those folders can be retained as historical reference, but runtime logic now
lives in `app/`.

## Active Flow

1. Connect to Trimble Workspace API.
2. Read current project context and traverse project folder tree via Core API.
3. Render IFC file table and let user select one model.
4. Open check-selection modal and persist selected scope/phase/property states.
5. Download selected IFC file to browser memory.
6. Parse model with `web-ifc` (`IfcAPI`) directly in browser.
7. Apply extracted original rules from `app/checker/rules/originalRuleDataset.json`.
8. Render summary + object-level findings in shell UI.
9. Export checker report JSON and/or BCF draft JSON via reporting extension layer.

Identity label constants used by parser + checker are centralized in:

- `app/checker/rules/ruleIdentityConstants.js`

Reporting export builders are centralized in:

- `app/reporting/reportExtensions.js`

## Rule Maintenance Workflow

1. `python3 scripts/extract-original-rule-dataset.py`
2. `python3 scripts/verify-original-rule-parity.py`
3. Keep shared extraction helpers in `scripts/original_rule_dataset_utils.py`
   unchanged unless both scripts are updated together.

## Runtime Pin

- `web-ifc` version: `0.0.77`
- Vendored files:
  - `app/vendor/web-ifc/web-ifc-api-iife.js`
  - `app/vendor/web-ifc/web-ifc.wasm`

Reference used for latest runtime availability:

- https://www.jsdelivr.com/package/npm/web-ifc
- https://data.jsdelivr.com/v1/package/npm/web-ifc@0.0.77
