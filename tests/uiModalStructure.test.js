import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

/*
Purpose:
Read one project file as UTF-8 text from repository root so structural smoke
tests can validate HTML/CSS contracts without browser runtime dependencies.

Parameters:
relativePath (string) - project-relative file path

Returns:
string - file content

Possible side effects:
None
*/
function readProjectFile(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

/*
Purpose:
Verify that settings controls required by the workflow exist in markup:
- check selection modal starts hidden
- dedicated settings edit button is present in checker header
- report export and BCF creation actions are present for post-check workflow
- status region exposes aria-live for screen-reader announcements
*/
test("index.html contains check settings controls with hidden default modal", () => {
  const htmlContent = readProjectFile("index.html");

  assert.equal(
    htmlContent.includes('<div id="check-selection-modal" class="check-selection-modal" hidden>'),
    true,
    "Check-selection modal should start hidden in HTML.",
  );
  assert.equal(
    htmlContent.includes('<div id="bcf-create-modal" class="bcf-create-modal" hidden>'),
    true,
    "BCF-create modal should start hidden in HTML.",
  );
  assert.equal(
    htmlContent.includes('id="edit-check-settings-button"'),
    true,
    "Checker header should include edit-check-settings button.",
  );
  assert.equal(
    htmlContent.includes('id="download-report-button"'),
    true,
    "Checker header should include report JSON export button.",
  );
  assert.equal(
    htmlContent.includes('id="export-bcf-draft-button"'),
    true,
    "Checker header should include Create BCFs button.",
  );
  assert.equal(
    htmlContent.includes("Create BCFs"),
    true,
    "BCF action button label should be Create BCFs.",
  );
  assert.equal(
    htmlContent.includes('id="status" class="status status-info" role="status" aria-live="polite"'),
    true,
    "Status element should expose polite aria-live updates.",
  );
});

/*
Purpose:
Ensure modal visibility respects the HTML `hidden` attribute even though modal
base classes define `display: grid`.
*/
test("styles.css enforces hidden-state display overrides for both modal types", () => {
  const cssContent = readProjectFile("styles.css");

  assert.equal(
    cssContent.includes(".check-selection-modal[hidden]"),
    true,
    "Check-selection hidden override is missing.",
  );
  assert.equal(
    cssContent.includes(".bcf-create-modal[hidden]"),
    true,
    "BCF-create hidden override is missing.",
  );
  assert.equal(
    cssContent.includes(".finding-modal[hidden]"),
    true,
    "Finding modal hidden override is missing.",
  );
  assert.equal(
    cssContent.includes("display: none !important;"),
    true,
    "Hidden modal override should force display none.",
  );
});

/*
Purpose:
Guard layout and table rendering contracts that affect usability:
- severity cells must keep table semantics (no flex on td)
- large-screen layout must remain single-column so file browser stays above checker
*/
test("styles keep severity cells as table cells and preserve single-column wide layout", () => {
  const cssContent = readProjectFile("styles.css");

  assert.equal(
    cssContent.includes(".object-table .number-cell {\n  display: flex;"),
    false,
    "Severity table cells must not switch to flex display because that can break column alignment.",
  );
  assert.equal(
    cssContent.includes("grid-template-columns: minmax(360px, 430px) minmax(0, 1fr);"),
    false,
    "Large-screen layout should not switch to side-by-side file browser and checker columns.",
  );
  assert.equal(
    cssContent.includes("body {\n    overflow: hidden;\n  }"),
    false,
    "Wide-screen media query should not lock body scrolling.",
  );
});

/*
Purpose:
Protect report table semantics so error indicators and warning indicators stay
in their correct columns, and object pass/fail badge keeps `|` delimiter.
*/
test("report view keeps error/warning column mapping and pass-fail delimiter", () => {
  const reportViewSource = readProjectFile("app/ui/reportView.js");

  assert.equal(
    reportViewSource.includes("<th>Errors</th>") && reportViewSource.includes("<th>Warnings</th>"),
    true,
    "Report table headers should include Errors and Warnings columns.",
  );
  assert.equal(
    reportViewSource.includes('data-column="errors">${errorColumnContent}</td>') &&
      reportViewSource.includes('data-column="warnings">${warningColumnContent}</td>'),
    true,
    "Object rows should render error and warning indicators in matching columns.",
  );
  assert.equal(
    reportViewSource.includes("finding-count-divider") && reportViewSource.includes(">|<"),
    true,
    "Group-level object badge should use `|` delimiter for correct | wrong counts.",
  );
  assert.equal(
    reportViewSource.includes("renderErrorColumnContent") &&
      reportViewSource.includes('severity-empty-placeholder" aria-hidden="true">-</span>'),
    true,
    "Errors column should show '-' placeholder when the object has zero errors.",
  );
  assert.equal(
    reportViewSource.includes("const warningColumnContent = showWarnings") &&
      reportViewSource.includes('renderSeverityIndicatorButton("warning", warningCount, warningPayload, finding)') &&
      reportViewSource.includes('data-column="warnings">${warningColumnContent}</td>'),
    true,
    "Warning indicator should be rendered into the Warnings column content.",
  );
  assert.equal(
    reportViewSource.includes("function normalizeObjectSeverityColumns(reportListElement, showWarnings)") &&
      reportViewSource.includes("normalizeObjectSeverityColumns(reportListElement, showWarnings);"),
    true,
    "Report rendering should normalize severity cells so warnings and errors stay in dedicated columns.",
  );
  assert.equal(
    reportViewSource.includes("directCellsBeforeNormalization") &&
      reportViewSource.includes('tableCellElement.getAttribute("data-column")'),
    true,
    "Normalization should rebuild severity columns from direct row cells instead of reusing possibly malformed mappings.",
  );
  assert.equal(
    reportViewSource.includes('statusCell.insertAdjacentElement("afterend", errorCell)') &&
      reportViewSource.includes('errorCell.insertAdjacentElement("afterend", warningCell)'),
    true,
    "Normalization should always restore severity cell order after Status as Errors first and Warnings second.",
  );
  assert.equal(
    reportViewSource.includes('data-bcf-group-selection-toggle="errors"') &&
      reportViewSource.includes('data-bcf-selection-toggle="true"') &&
      reportViewSource.includes('<th class="bcf-selection-column">Create BCF</th>'),
    true,
    "Report view should expose hierarchical BCF selection controls for group-level and row/modal-level selection.",
  );
  assert.equal(
    reportViewSource.includes("<th>Correct</th>") &&
      reportViewSource.includes("<th>Incorrect</th>") &&
      reportViewSource.includes("<th>Total</th>") &&
      reportViewSource.includes("<th>Success rate</th>"),
    true,
    "Breakdown table headers should be rendered in English.",
  );
  assert.equal(
    reportViewSource.includes("<th>Oikein</th>") ||
      reportViewSource.includes("<th>Vaarin</th>") ||
      reportViewSource.includes("<th>Yhteensa</th>") ||
      reportViewSource.includes("<th>Onnistuminen</th>"),
    false,
    "Legacy Finnish breakdown table headers should not remain in the report view source.",
  );
});

/*
Purpose:
Ensure check-selection settings expose explicit warning-visibility toggle with
unchecked default so users can hide warning UI from report output.
*/
test("check settings include warning-visibility toggle defaulting to unchecked", () => {
  const projectFileIndexSource = readProjectFile("app/projectFileIndex.js");
  const reportViewSource = readProjectFile("app/ui/reportView.js");

  assert.equal(
    projectFileIndexSource.includes("showWarnings: false"),
    true,
    "Default check-execution options should keep warning visibility unchecked.",
  );
  assert.equal(
    projectFileIndexSource.includes('data-check-show-warnings="true"'),
    true,
    "Check-selection modal should include warning-visibility checkbox.",
  );
  assert.equal(
    projectFileIndexSource.includes("draftExecutionOptions.showWarnings = eventTarget.checked"),
    true,
    "Modal change handler should persist warning-visibility toggle.",
  );
  assert.equal(
    reportViewSource.includes("resolveShowWarningsFromReportData(reportData)") &&
      reportViewSource.includes("renderFilterToolbar(showWarnings)") &&
      reportViewSource.includes("normalizeObjectSeverityColumns(reportListElement, showWarnings)"),
    true,
    "Report rendering should conditionally hide warning UI when warning visibility is disabled.",
  );
});

/*
Purpose:
Ensure Create BCFs flow is wired to explicit selection state and modal-based
topic creation flow so users can configure generic + per-topic data.
*/
test("projectFileIndex uses selected issue selectors for Create BCFs modal flow", () => {
  const projectFileIndexSource = readProjectFile("app/projectFileIndex.js");

  assert.equal(
    projectFileIndexSource.includes("getSelectedBcfIssueSelectors"),
    true,
    "Create BCFs flow should import selected issue selectors from report view.",
  );
  assert.equal(
    projectFileIndexSource.includes("const selectedIssueSelectors = getSelectedBcfIssueSelectors();") &&
      projectFileIndexSource.includes("buildSelectedIssueRowsForBcfCreation"),
    true,
    "Create BCFs flow should forward selected IFC GUID + severity pairs into issue-row builder.",
  );
  assert.equal(
    projectFileIndexSource.includes("selectedIssueSelectors.length === 0"),
    true,
    "Create BCFs flow should block when user has not selected any findings.",
  );
  assert.equal(
    projectFileIndexSource.includes("openBcfInformationModal") &&
      projectFileIndexSource.includes("openBcfTopicCreationModal") &&
      projectFileIndexSource.includes("createBcfTopicsFromModalRequest"),
    true,
    "Create BCFs flow should use modal-guided topic creation and Topics API execution.",
  );
  assert.equal(
    projectFileIndexSource.includes('const IFC_CHECKER_TOPIC_LABEL = "IFC-checker";') &&
      projectFileIndexSource.includes("ensureProjectTopicLabelExists") &&
      projectFileIndexSource.includes("topic_label: updatedTopicLabels"),
    true,
    "Create BCFs flow should guarantee IFC-checker label exists in project extensions before topic creation.",
  );
  assert.equal(
    projectFileIndexSource.includes("labels: collectUniqueTrimmedStringValues([...selectedProjectLabels, ...requiredLabels])"),
    true,
    "Create BCFs modal confirmation should always include required IFC-checker label in topic labels.",
  );
  assert.equal(
    projectFileIndexSource.includes('data-bcf-generic-field="extra-labels"'),
    false,
    "Create BCFs modal should not allow free-form labels that are not part of project extensions.",
  );
  assert.equal(
    projectFileIndexSource.includes("String(normalizedTopic.severity || \"\").trim().toLowerCase(),"),
    false,
    "Topic payload labels should not be auto-derived from error/warning severity.",
  );
});

/*
Purpose:
Ensure Create BCFs flow links every created topic to the checked IFC model file
through official BCF file-header endpoints so topic context contains both model
project and model file references.
*/
test("projectFileIndex links created topics to selected IFC model file via BCF files endpoints", () => {
  const projectFileIndexSource = readProjectFile("app/projectFileIndex.js");

  assert.equal(
    projectFileIndexSource.includes("/files_information") &&
      projectFileIndexSource.includes("resolveTopicFileReferenceForCurrentModel"),
    true,
    "Create BCFs flow should resolve model file mapping from Topics API files_information endpoint.",
  );
  assert.equal(
    projectFileIndexSource.includes("updateSingleBcfTopicFiles") &&
      projectFileIndexSource.includes("/topics/${encodeURIComponent(topicGuid)}/files"),
    true,
    "Create BCFs flow should link each created topic with PUT /topics/{topic_id}/files.",
  );
  assert.equal(
    projectFileIndexSource.includes('topicActions.includes("updateFiles")') &&
      projectFileIndexSource.includes("linkedTopicFileCount"),
    true,
    "Create BCFs flow should enforce updateFiles authorization and track linked model-file count.",
  );
  assert.equal(
    projectFileIndexSource.includes("buildTopicFileReferenceFromSelectedModel") &&
      projectFileIndexSource.includes("checkReportData?.modelContext?.ifcProjectGlobalId") &&
      projectFileIndexSource.includes("localTopicFileReference.ifc_project"),
    true,
    "Create BCFs flow should build topic file links primarily from selected model + IFCPROJECT context before API fallback.",
  );
  assert.equal(
    projectFileIndexSource.includes("runtimeState.latestCheckResult") &&
      projectFileIndexSource.includes("resolveTopicFileReferenceForCurrentModel("),
    true,
    "Create BCFs flow should pass latest check result model context into topic file-link resolution.",
  );
});
