import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

/*
Purpose:
Ensure rewritten runtime ships with required files and no legacy iframe
dependency in active entry point.
*/
test("rewritten runtime files are present", () => {
  const requiredPaths = [
    "index.html",
    "styles.css",
    "app/main.js",
    "app/checker/checkerEngine.js",
    "app/checker/webIfcModelParser.js",
    "app/checker/rules/ruleIdentityConstants.js",
    "app/checker/rules/originalRuleDataset.json",
    "app/checker/rules/originalRuleDatasetLoader.js",
    "app/reporting/reportExtensions.js",
    "app/config/webIfcRuntime.js",
    "app/vendor/web-ifc/web-ifc-api-iife.js",
    "app/vendor/web-ifc/web-ifc.wasm",
  ];

  requiredPaths.forEach((relativePath) => {
    assert.equal(existsSync(path.join(projectRoot, relativePath)), true, `Missing file: ${relativePath}`);
  });
});

/*
Purpose:
Verify active HTML entry point no longer mounts legacy iframe.
*/
test("index.html does not reference legacy iframe runtime", () => {
  const htmlContent = readFileSync(path.join(projectRoot, "index.html"), "utf8");
  assert.equal(htmlContent.includes("legacy-frame"), false);
  assert.equal(htmlContent.includes("legacy-app/index.html"), false);
});

/*
Purpose:
Verify vendored wasm artifact is not empty and has wasm signature.
*/
test("vendored wasm is valid non-empty binary", () => {
  const wasmPath = path.join(projectRoot, "app/vendor/web-ifc/web-ifc.wasm");
  const wasmBytes = readFileSync(wasmPath);

  assert.equal(statSync(wasmPath).size > 0, true, "web-ifc.wasm is empty.");
  assert.equal(wasmBytes[0], 0x00);
  assert.equal(wasmBytes[1], 0x61);
  assert.equal(wasmBytes[2], 0x73);
  assert.equal(wasmBytes[3], 0x6d);
});
