# Release Readiness Checklist

This checklist defines the minimum quality gate before publishing a new public version.

## 1. Automated quality gates

Run all required checks in a clean working tree:

```bash
npm run verify:release
npm run verify:dataset
```

Expected result:

- Node.js test suite passes.
- Rule parity script passes.
- Dataset extraction script does not produce uncommitted changes.

In GitHub, verify workflow **Quality Gates** is green for the final commit.

## 2. Manual runtime verification in Trimble Connect

Before release, validate one full end-to-end user flow in real Trimble host context:

1. Extension connects successfully and shows current project metadata.
2. IFC file table loads and selection works.
3. Selected IFC downloads to memory without fallback errors.
4. Check execution completes and report UI renders.
5. Report JSON export downloads and opens as valid JSON.
6. BCF creation flow completes for at least one selected finding.
7. Created BCF topic includes model file linking.

## 3. Documentation quality gate

Confirm these files are aligned with the actual implementation:

- `README.md`
- `AUTHORS.md`
- `docs/installation-and-trimble-connect-setup.md`
- `docs/data-handling-and-trimble-api-boundaries.md`
- `docs/open-source-dependencies.md`

If any behavior or command changed, update docs in the same pull request.

## 4. Repository hygiene gate

Verify repository does not contain generated cache or local-only files:

- No `__pycache__/` directories
- No `.pyc` files
- No local secret files (`.env*`)

Confirm `.gitignore` still covers local artifacts introduced by tooling changes.

## 5. Manifest and deployment gate

Before publishing:

1. Confirm `manifest.json` points to the correct hosted `index.html` URL.
2. Confirm icon URL is public and stable.
3. Confirm hosted assets include `index.html`, `styles.css`, `app/**`, and `manifest.json`.

## 6. Public release confidence gate

Only release when all conditions below are true:

- Automated checks pass locally and in CI.
- Manual Trimble host validation passes.
- No unresolved high-severity bugs are open.
- Documentation reflects current behavior.
