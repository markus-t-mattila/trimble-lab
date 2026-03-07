/*
Purpose:
Render checker report data in a hierarchical and table-oriented format so the
results are easier to read and drill down without repeated headings.

Logic:
- Keep top summary cards for quick totals.
- Render one top error summary table per scope.
- Render one scope section at a time (product/system).
- Inside each scope, group findings by level key so title appears once.
- Inside each group, render object rows with IFC GUID and direct error/warning modal actions.
- Provide search and severity filtering across object rows.

Parameters:
This module exports render helper functions documented below.

Returns:
DOM update helpers for report summary and report list.

Possible side effects:
- Mutates report summary/list elements.
- Attaches filter event listeners.
*/

/*
Purpose:
Escape model-provided text before using it in HTML templates.

Parameters:
unsafeText (unknown) - potentially unsafe text value

Returns:
string - HTML-safe text

Possible side effects:
None
*/
function escapeHtml(unsafeText) {
  return String(unsafeText ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/*
Purpose:
Encode dynamic values safely for HTML data attributes so modal metadata can be
transported through delegated click handlers without breaking markup.

Parameters:
rawValue (unknown) - attribute value candidate

Returns:
string - URI-encoded safe string

Possible side effects:
None
*/
function encodeDataAttributeValue(rawValue) {
  return encodeURIComponent(String(rawValue ?? ""));
}

/*
Purpose:
Decode values that were previously encoded for HTML data attributes.

Parameters:
encodedValue (string | null) - encoded attribute text

Returns:
string - decoded value, or empty string when input is missing/malformed

Possible side effects:
None
*/
function decodeDataAttributeValue(encodedValue) {
  if (!encodedValue) {
    return "";
  }

  try {
    return decodeURIComponent(encodedValue);
  } catch (error) {
    return "";
  }
}

const groupSeverityPayloadStore = new Map();
let groupSeverityPayloadCounter = 0;
const selectedBcfIssueKeys = new Set();

/*
Purpose:
Normalize incoming BCF selection severity values into explicit supported kinds.

Parameters:
rawSeverityKind (unknown) - severity candidate value

Returns:
"error" | "warning" | "" - normalized severity, empty when unsupported

Possible side effects:
None
*/
function normalizeBcfSeverityKind(rawSeverityKind) {
  const normalizedSeverity = String(rawSeverityKind || "")
    .trim()
    .toLowerCase();

  if (normalizedSeverity === "error" || normalizedSeverity === "warning") {
    return normalizedSeverity;
  }

  return "";
}

/*
Purpose:
Build deterministic selection key from IFC GUID and severity so selection state
can be shared between row-level controls and modal-level controls.

Parameters:
ifcGuid (unknown) - IFC GUID candidate
severityKind (unknown) - severity candidate

Returns:
string - stable key in `ifcGuid::severity` form, empty when invalid

Possible side effects:
None
*/
function buildBcfIssueSelectionKey(ifcGuid, severityKind) {
  const normalizedIfcGuid = String(ifcGuid || "").trim();
  const normalizedSeverityKind = normalizeBcfSeverityKind(severityKind);

  if (!normalizedIfcGuid || !normalizedSeverityKind) {
    return "";
  }

  return `${normalizedIfcGuid}::${normalizedSeverityKind}`;
}

/*
Purpose:
Return whether one IFC GUID + severity pair is currently selected for future
BCF creation.

Parameters:
ifcGuid (unknown) - IFC GUID candidate
severityKind (unknown) - severity candidate

Returns:
boolean - true when pair is selected

Possible side effects:
None
*/
function isBcfIssueSelectionActive(ifcGuid, severityKind) {
  const selectionKey = buildBcfIssueSelectionKey(ifcGuid, severityKind);
  if (!selectionKey) {
    return false;
  }

  return selectedBcfIssueKeys.has(selectionKey);
}

/*
Purpose:
Set selected state for one IFC GUID + severity pair.

Parameters:
ifcGuid (unknown) - IFC GUID candidate
severityKind (unknown) - severity candidate
nextSelectedState (boolean) - target selected state

Returns:
void

Possible side effects:
- Mutates in-memory BCF selection set.
*/
function setBcfIssueSelectionState(ifcGuid, severityKind, nextSelectedState) {
  const selectionKey = buildBcfIssueSelectionKey(ifcGuid, severityKind);
  if (!selectionKey) {
    return;
  }

  if (nextSelectedState) {
    selectedBcfIssueKeys.add(selectionKey);
    return;
  }

  selectedBcfIssueKeys.delete(selectionKey);
}

/*
Purpose:
Decode list of group-level IFC GUIDs from encoded HTML data attribute value.

Parameters:
encodedGuidListValue (string | null) - encoded JSON array payload

Returns:
Array<string> - normalized GUID list

Possible side effects:
None
*/
function parseEncodedGroupGuidList(encodedGuidListValue) {
  const decodedValue = decodeDataAttributeValue(encodedGuidListValue);
  if (!decodedValue) {
    return [];
  }

  try {
    const parsedList = JSON.parse(decodedValue);
    if (!Array.isArray(parsedList)) {
      return [];
    }

    return parsedList
      .map((listItem) => String(listItem || "").trim())
      .filter((listItem) => listItem !== "");
  } catch (error) {
    return [];
  }
}

/*
Purpose:
Reset in-memory payload store for group-level modal actions before each report
render so stale payload keys never leak across separate checker runs.

Parameters:
None

Returns:
void

Possible side effects:
- Clears group severity payload store.
*/
function resetGroupSeverityPayloadStore() {
  groupSeverityPayloadStore.clear();
  groupSeverityPayloadCounter = 0;
}

/*
Purpose:
Store one group-level modal payload and return deterministic lookup key so the
DOM can keep lightweight attributes instead of embedding huge JSON strings.

Parameters:
groupPayload (object) - payload used by grouped severity modal

Returns:
string - generated payload key

Possible side effects:
- Writes payload entry into module-level store.
*/
function registerGroupSeverityPayload(groupPayload) {
  groupSeverityPayloadCounter += 1;
  const payloadKey = `group-severity-${groupSeverityPayloadCounter}`;
  groupSeverityPayloadStore.set(payloadKey, groupPayload);
  return payloadKey;
}

/*
Purpose:
Read one stored group-level payload by key.

Parameters:
payloadKey (string | null) - payload lookup key from clicked badge button

Returns:
object | null - stored payload or null when missing

Possible side effects:
None
*/
function readGroupSeverityPayload(payloadKey) {
  if (!payloadKey) {
    return null;
  }

  return groupSeverityPayloadStore.get(payloadKey) || null;
}

/*
Purpose:
Create one compact summary card for top report metrics.

Parameters:
label (string) - metric label
value (string | number) - metric value

Returns:
string - summary card HTML

Possible side effects:
None
*/
function renderSummaryCard(label, value) {
  return `
    <article class="summary-card">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
    </article>
  `;
}

/*
Purpose:
Count error and warning severities for one finding/object row.

Parameters:
issues (Array<object>) - finding row list

Returns:
{ errorCount: number, warningCount: number }

Possible side effects:
None
*/
function countIssueSeverities(issues) {
  const safeIssues = Array.isArray(issues) ? issues : [];
  const errorCount = safeIssues.filter((issue) => normalizeIssueSeverity(issue?.severity) === "error").length;
  const warningCount = safeIssues.filter((issue) => normalizeIssueSeverity(issue?.severity) === "warning").length;

  return {
    errorCount,
    warningCount,
  };
}

/*
Purpose:
Normalize issue severity values so minor payload formatting differences
(for example casing or trailing spaces) cannot break error/warning mapping.

Parameters:
rawSeverity (unknown) - source severity value from issue payload

Returns:
"error" | "warning" | "unknown" - normalized severity bucket

Possible side effects:
None
*/
function normalizeIssueSeverity(rawSeverity) {
  const normalizedSeverity = String(rawSeverity || "")
    .trim()
    .toLowerCase();

  if (normalizedSeverity === "error") {
    return "error";
  }

  if (normalizedSeverity === "warning") {
    return "warning";
  }

  return "unknown";
}

/*
Purpose:
Resolve whether warning UI should be shown for this report payload.

Logic:
- New checker runs include explicit `executionProfile.display.showWarnings`.
- Legacy payloads may not include the flag, in which case warnings stay visible
  to preserve backward-compatible behavior for old exports/runs.

Parameters:
reportData (object | null) - full checker report payload

Returns:
boolean - true when warning UI should be shown

Possible side effects:
None
*/
function resolveShowWarningsFromReportData(reportData) {
  const explicitShowWarnings = reportData?.executionProfile?.display?.showWarnings;
  if (typeof explicitShowWarnings === "boolean") {
    return explicitShowWarnings;
  }

  return true;
}

/*
Purpose:
Render object pass/fail count badge content where pass means object has zero
errors and fail means object has one or more errors.

Logic:
The delimiter is intentionally `|` to communicate "correct | wrong" clearly.

Parameters:
passedObjectCount (number) - objects with zero errors
failedObjectCount (number) - objects with one or more errors

Returns:
string - HTML fragment for badge content

Possible side effects:
None
*/
function renderObjectPassFailCountMarkup(passedObjectCount, failedObjectCount) {
  const safePassedCount = Math.max(0, Number.isFinite(passedObjectCount) ? passedObjectCount : 0);
  const safeFailedCount = Math.max(0, Number.isFinite(failedObjectCount) ? failedObjectCount : 0);

  return `Objects: <span class="finding-pass-count">${safePassedCount}</span> <span class="finding-count-divider">|</span> <span class="finding-fail-count">${safeFailedCount}</span>`;
}

/*
Purpose:
Calculate percentage safely while avoiding divide-by-zero.

Parameters:
correctCount (number) - number of correct validations
totalCount (number) - number of validated items

Returns:
number - percentage in range 0..100

Possible side effects:
None
*/
function calculatePercentage(correctCount, totalCount) {
  if (!Number.isFinite(totalCount) || totalCount <= 0) {
    return 0;
  }

  const safeCorrectCount = Number.isFinite(correctCount) ? correctCount : 0;
  const safeIncorrectCount = Math.max(0, totalCount - safeCorrectCount);
  const metricTotal = safeCorrectCount + safeIncorrectCount;

  if (metricTotal === 0) {
    return 0;
  }

  let percentage = Math.round((safeCorrectCount / metricTotal) * 100);
  if (percentage === 100 && safeIncorrectCount > 0) {
    percentage = 99;
  }

  if (percentage === 0 && safeCorrectCount > 0) {
    percentage = 1;
  }

  return Math.max(0, Math.min(100, percentage));
}

/*
Purpose:
Build filterable search text from one finding so the list can be narrowed by
name, GUID, IFC type, group key, and finding messages.

Parameters:
finding (object) - one finding row
scopeKey ("product" | "system") - scope identifier
groupKey (string) - grouped heading key

Returns:
string - normalized lowercase search text

Possible side effects:
None
*/
function buildObjectSearchText(finding, scopeKey, groupKey) {
  const findingMessageText = Array.isArray(finding?.issues)
    ? finding.issues.map((issue) => issue?.message || "").join(" ")
    : "";

  return [
    scopeKey,
    groupKey,
    finding?.name,
    finding?.ifcEntity,
    finding?.globalId,
    finding?.expressId,
    findingMessageText,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

/*
Purpose:
Render one progress row with percentage bar and correct/incorrect counts.

Parameters:
label (string) - metric name
correctCount (number) - correctly validated count
incorrectCount (number) - incorrectly validated count
totalCount (number) - total checked count

Returns:
string - metric row HTML

Possible side effects:
None
*/
function renderBreakdownMetricRow(label, correctCount, incorrectCount, totalCount) {
  const percentage = calculatePercentage(correctCount, totalCount);

  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${correctCount}</td>
      <td>${incorrectCount}</td>
      <td>${totalCount}</td>
      <td>
        <div class="breakdown-progress-track" aria-hidden="true">
          <div class="breakdown-progress-fill" style="width:${percentage}%;"></div>
        </div>
        <span class="breakdown-progress-label">${percentage}%</span>
      </td>
    </tr>
  `;
}

/*
Purpose:
Render one explicit skipped row so users can see that a check phase was
intentionally excluded from execution.

Parameters:
label (string) - metric name

Returns:
string - skipped metric row HTML

Possible side effects:
None
*/
function renderSkippedBreakdownMetricRow(label) {
  return `
    <tr class="breakdown-row-skipped">
      <td>${escapeHtml(label)}</td>
      <td colspan="4">Not selected for this run.</td>
    </tr>
  `;
}

/*
Purpose:
Render one scope breakdown table that mirrors original check structure:
identification and content checks per scope.

Parameters:
cardTitle (string) - table title
descriptionItems (Array<string>) - scope description bullets
scopeBreakdown (object | null) - scope breakdown metrics

Returns:
string - scope breakdown HTML

Possible side effects:
None
*/
function renderScopeBreakdownTable(cardTitle, descriptionItems, scopeBreakdown) {
  const safeBreakdown = scopeBreakdown || {};
  const scopeEnabled = safeBreakdown.scopeEnabled !== false;
  const identificationEnabled = scopeEnabled && safeBreakdown.identificationEnabled !== false;
  const contentEnabled = scopeEnabled && safeBreakdown.contentEnabled !== false;
  const candidateCount = Number(safeBreakdown.candidateCount || 0);
  const matchedCount = Number(safeBreakdown.matchedCount || 0);
  const identifiedCount = Number(safeBreakdown.identifiedCount || 0);
  const unidentifiedCount = Number(safeBreakdown.unidentifiedCount || 0);
  const contentCorrectCount = Number(safeBreakdown.contentCorrectCount || 0);
  const contentIncorrectCount = Number(safeBreakdown.contentIncorrectCount || 0);

  const descriptionMarkup = (descriptionItems || [])
    .map((descriptionItem) => `<li>${escapeHtml(descriptionItem)}</li>`)
    .join("");

  const identificationRow = identificationEnabled
    ? renderBreakdownMetricRow("Identification", identifiedCount, unidentifiedCount, candidateCount)
    : renderSkippedBreakdownMetricRow("Identification");
  const contentRow = contentEnabled
    ? renderBreakdownMetricRow("Structure and content", contentCorrectCount, contentIncorrectCount, matchedCount)
    : renderSkippedBreakdownMetricRow("Structure and content");

  return `
    <article class="check-breakdown-card">
      <h4 class="check-breakdown-title">${escapeHtml(cardTitle)}</h4>
      <ul class="check-breakdown-description">${descriptionMarkup}</ul>
      <div class="table-scroll-shell">
        <table class="breakdown-table">
          <thead>
            <tr>
              <th>Check phase</th>
              <th>Correct</th>
              <th>Incorrect</th>
              <th>Total</th>
              <th>Success rate</th>
            </tr>
          </thead>
          <tbody>
            ${identificationRow}
            ${contentRow}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

/*
Purpose:
Calculate scope-level totals for error summary table.

Parameters:
findings (Array<object>) - scope findings

Returns:
{ objects: number, errors: number, warnings: number, unidentified: number }

Possible side effects:
None
*/
function calculateScopeTotals(findings) {
  const safeFindings = Array.isArray(findings) ? findings : [];

  return safeFindings.reduce(
    (accumulator, finding) => {
      const findingStats = countIssueSeverities(finding?.issues);
      return {
        objects: accumulator.objects + 1,
        errors: accumulator.errors + findingStats.errorCount,
        warnings: accumulator.warnings + findingStats.warningCount,
        unidentified: accumulator.unidentified + (finding?.isUnidentified ? 1 : 0),
      };
    },
    { objects: 0, errors: 0, warnings: 0, unidentified: 0 },
  );
}

/*
Purpose:
Render top summary table for errors/warnings per scope before detailed drill
levels, so user gets a quick consolidated overview immediately.

Parameters:
reportData (object) - full checker report data

Returns:
string - top overview table HTML

Possible side effects:
None
*/
function renderTopErrorSummaryTable(reportData, showWarnings) {
  const executionProfile = reportData?.executionProfile || {};
  const productScopeEnabled = executionProfile?.scopes?.product !== false;
  const systemScopeEnabled = executionProfile?.scopes?.system !== false;
  const productTotals = calculateScopeTotals(productScopeEnabled ? reportData?.productFindings : []);
  const systemTotals = calculateScopeTotals(systemScopeEnabled ? reportData?.systemFindings : []);
  const warningHeaderMarkup = showWarnings ? "<th>Warnings</th>" : "";
  const productWarningCellMarkup = showWarnings ? `<td>${productScopeEnabled ? productTotals.warnings : "-"}</td>` : "";
  const systemWarningCellMarkup = showWarnings ? `<td>${systemScopeEnabled ? systemTotals.warnings : "-"}</td>` : "";

  return `
    <section class="report-overview-section">
      <h3 class="report-overview-title">Koonti taulukko virheista</h3>
      <div class="table-scroll-shell">
        <table class="report-overview-table">
          <thead>
            <tr>
              <th>Kokonaisuus</th>
              <th>Tila</th>
              <th>Objekteja</th>
              <th>Errors</th>
              ${warningHeaderMarkup}
              <th>Unidentified</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Tuoteosien tarkastukset</td>
              <td>${productScopeEnabled ? "Valittu" : "Ei valittu"}</td>
              <td>${productScopeEnabled ? productTotals.objects : "-"}</td>
              <td>${productScopeEnabled ? productTotals.errors : "-"}</td>
              ${productWarningCellMarkup}
              <td>${productScopeEnabled ? productTotals.unidentified : "-"}</td>
            </tr>
            <tr>
              <td>Jarjestelmien tarkastukset</td>
              <td>${systemScopeEnabled ? "Valittu" : "Ei valittu"}</td>
              <td>${systemScopeEnabled ? systemTotals.objects : "-"}</td>
              <td>${systemScopeEnabled ? systemTotals.errors : "-"}</td>
              ${systemWarningCellMarkup}
              <td>${systemScopeEnabled ? systemTotals.unidentified : "-"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/*
Purpose:
Render top breakdown section with overview table and scope-specific percentage
breakdown tables.

Parameters:
reportData (object) - full checker report data

Returns:
string - full breakdown section HTML

Possible side effects:
None
*/
function renderCheckBreakdownSection(reportData, showWarnings) {
  const checkBreakdown = reportData?.checkBreakdown;
  if (!checkBreakdown || typeof checkBreakdown !== "object") {
    return "";
  }

  const productBreakdownTable = renderScopeBreakdownTable(
    "Tuoteosien tarkastukset",
    [
      "Tuoteosien tunnistaminen",
      "Tunnistettujen tuoteosien tietorakenteet ja sisallot",
    ],
    checkBreakdown.product,
  );

  const systemBreakdownTable = renderScopeBreakdownTable(
    "Jarjestelmien tarkastukset",
    [
      "Jarjestelmien tunnistaminen",
      "Tunnistettujen jarjestelmien tietorakenteet ja sisallot",
    ],
    checkBreakdown.system,
  );

  return `
    ${renderTopErrorSummaryTable(reportData, showWarnings)}
    <section class="check-breakdown-section">
      <h3 class="check-breakdown-section-title">Tarkastuksen kokonaisuudet</h3>
      <div class="check-breakdown-grid">
        ${productBreakdownTable}
        ${systemBreakdownTable}
      </div>
    </section>
  `;
}

/*
Purpose:
Render one severity-specific finding table used inside the modal so the user can
inspect only errors or only warnings without mixing both severities together.

Parameters:
findingsBySeverity (Array<object>) - filtered finding entries for one severity
severityKind ("error" | "warning") - rendered severity

Returns:
string - modal table HTML

Possible side effects:
None
*/
function renderSeverityFindingTable(findingsBySeverity, severityKind) {
  const safeFindings = Array.isArray(findingsBySeverity) ? findingsBySeverity : [];
  const severityTitle = severityKind === "error" ? "Errors" : "Warnings";

  if (safeFindings.length === 0) {
    return `<div class="finding-empty-state">No ${severityTitle.toLowerCase()} for this object.</div>`;
  }

  const findingRows = safeFindings
    .map((findingRow, rowIndex) => {
      return `
        <tr>
          <td class="number-cell">${rowIndex + 1}</td>
          <td>${escapeHtml(findingRow?.propertyGroup || "-")}</td>
          <td>${escapeHtml(findingRow?.propertyLabel || "-")}</td>
          <td>${escapeHtml(findingRow?.message || `No ${severityTitle.toLowerCase()} message provided.`)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="table-scroll-shell">
      <table class="finding-modal-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Property group</th>
            <th>Property label</th>
            <th>${severityTitle} message</th>
          </tr>
        </thead>
        <tbody>${findingRows}</tbody>
      </table>
    </div>
  `;
}

/*
Purpose:
Create one shared indicator button HTML for table cell actions that open either
error or warning modal content for the selected object row.

Parameters:
buttonKind ("error" | "warning") - indicator type
countValue (number) - amount shown in button
encodedPayload (string) - encoded modal payload
finding (object) - object-level finding metadata

Returns:
string - action button HTML, empty string when count is zero

Possible side effects:
None
*/
function renderSeverityIndicatorButton(buttonKind, countValue, encodedPayload, finding) {
  const safeCountValue = Number(countValue || 0);
  if (safeCountValue <= 0) {
    return "";
  }

  const severityLabel = buttonKind === "error" ? "Errors" : "Warnings";
  const buttonClassName = buttonKind === "error" ? "error-indicator-button" : "warning-indicator-button";
  const iconMarkup = buttonKind === "error"
    ? `<span class="error-dot" aria-hidden="true">●</span>`
    : `<span class="warning-triangle" aria-hidden="true">▲</span>`;

  return `
    <button
      type="button"
      class="${buttonClassName}"
      data-finding-modal-open="${buttonKind}"
      data-finding-modal-payload="${encodedPayload}"
      data-finding-object-name="${encodeDataAttributeValue(finding?.name || "Unnamed")}"
      data-finding-object-guid="${encodeDataAttributeValue(finding?.globalId || "-")}"
      data-finding-object-ifc="${encodeDataAttributeValue(finding?.ifcEntity || "-")}"
      data-finding-object-expressid="${encodeDataAttributeValue(finding?.expressId ?? "-")}"
      aria-label="Open ${severityLabel} table for ${escapeHtml(finding?.name || "Unnamed")}"
    >
      ${iconMarkup}
      <span class="warning-count">${safeCountValue}</span>
    </button>
  `;
}

/*
Purpose:
Render one error column cell content string so the Errors column is explicit:
- show clickable error indicator when error count is positive
- otherwise show "-" placeholder to indicate no errors

Parameters:
errorCount (number) - number of errors for current object row
errorPayload (string) - encoded payload for error modal rows
finding (object) - object-level finding metadata

Returns:
string - error column HTML content

Possible side effects:
None
*/
function renderErrorColumnContent(errorCount, errorPayload, finding) {
  const errorIndicatorMarkup = renderSeverityIndicatorButton("error", errorCount, errorPayload, finding);
  if (errorIndicatorMarkup !== "") {
    return errorIndicatorMarkup;
  }

  return '<span class="severity-empty-placeholder" aria-hidden="true">-</span>';
}

/*
Purpose:
Render one object row in group table with direct `Errors` and `Warnings` modal
actions so the UI stays compact and no separate details column is required.

Parameters:
finding (object) - finding object
scopeKey ("product" | "system") - scope id
groupKey (string) - group heading key
showWarnings (boolean) - true to render Warnings column content for row

Returns:
string - object table row HTML

Possible side effects:
None
*/
function renderObjectRow(finding, scopeKey, groupKey, showWarnings) {
  const identifyLabel = finding?.isUnidentified ? "UNIDENTIFIED" : "IDENTIFIED";
  const searchText = escapeHtml(buildObjectSearchText(finding, scopeKey, groupKey));
  const objectGlobalId = String(finding?.globalId || "-");
  const issueRows = Array.isArray(finding?.issues) ? finding.issues : [];
  const errorRows = issueRows.filter((item) => normalizeIssueSeverity(item?.severity) === "error");
  const warningRows = issueRows.filter((item) => normalizeIssueSeverity(item?.severity) === "warning");
  const errorCount = errorRows.length;
  const warningCount = warningRows.length;
  const errorPayload = encodeURIComponent(JSON.stringify(errorRows));
  const warningPayload = encodeURIComponent(JSON.stringify(warningRows));
  const rowSeverityClass = errorCount > 0 ? "row-has-error" : "row-has-ok";

  const errorColumnContent = renderErrorColumnContent(errorCount, errorPayload, finding);
  const warningColumnContent = showWarnings
    ? renderSeverityIndicatorButton("warning", warningCount, warningPayload, finding)
    : "";
  const warningColumnCellMarkup = showWarnings
    ? `<td class="number-cell warning-column-cell" data-column="warnings">${warningColumnContent}</td>`
    : "";
  const bcfErrorCheckboxMarkup = `
    <td class="bcf-selection-cell" data-column="bcf-selection">
      <label class="bcf-selection-toggle" aria-label="Select errors for BCF creation">
        <input
          type="checkbox"
          data-bcf-selection-toggle="true"
          data-bcf-selection-guid="${encodeDataAttributeValue(objectGlobalId)}"
          data-bcf-selection-severity="error"
          ${errorCount > 0 ? "" : "disabled"}
          ${errorCount > 0 && isBcfIssueSelectionActive(objectGlobalId, "error") ? "checked" : ""}
        />
      </label>
    </td>
  `;

  return `
    <tr
      class="object-row ${rowSeverityClass}"
      data-search="${searchText}"
      data-error-count="${errorCount}"
      data-warning-count="${warningCount}"
      data-unidentified="${finding?.isUnidentified ? "true" : "false"}"
      data-object-guid="${encodeDataAttributeValue(objectGlobalId)}"
    >
      <td>${escapeHtml(finding?.name || "Unnamed")}</td>
      <td>${escapeHtml(finding?.ifcEntity || "-")}</td>
      <td class="guid-cell">${escapeHtml(objectGlobalId)}</td>
      <td>${escapeHtml(finding?.expressId ?? "-")}</td>
      <td>${identifyLabel}</td>
      <td class="number-cell error-column-cell" data-column="errors">${errorColumnContent}</td>
      ${warningColumnCellMarkup}
      ${bcfErrorCheckboxMarkup}
    </tr>
  `;
}

/*
Purpose:
Normalize group heading key so repeated headings caused by casing or accidental
whitespace differences are merged under one display title.

Parameters:
rawGroupKey (unknown) - source grouping key from finding payload

Returns:
{ normalizedKey: string, displayKey: string }

Possible side effects:
None
*/
function normalizeLevelGroupKey(rawGroupKey) {
  const displayKey = String(rawGroupKey || "Not defined")
    .replace(/\s+/g, " ")
    .trim();
  const safeDisplayKey = displayKey === "" ? "Not defined" : displayKey;

  return {
    normalizedKey: safeDisplayKey.toLowerCase(),
    displayKey: safeDisplayKey,
  };
}

/*
Purpose:
Sort findings in a deterministic way so each group table is stable and easier to
scan between consecutive checker runs.

Parameters:
findings (Array<object>) - one group's finding list

Returns:
Array<object> - sorted finding list

Possible side effects:
None
*/
function sortFindingsForDisplay(findings) {
  return [...(findings || [])].sort((leftFinding, rightFinding) => {
    const leftName = String(leftFinding?.name || "Unnamed");
    const rightName = String(rightFinding?.name || "Unnamed");
    const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const leftGuid = String(leftFinding?.globalId || "");
    const rightGuid = String(rightFinding?.globalId || "");
    const guidCompare = leftGuid.localeCompare(rightGuid, undefined, { sensitivity: "base" });
    if (guidCompare !== 0) {
      return guidCompare;
    }

    const leftExpressId = Number(leftFinding?.expressId || 0);
    const rightExpressId = Number(rightFinding?.expressId || 0);
    return leftExpressId - rightExpressId;
  });
}

/*
Purpose:
Group findings by level key so each group heading appears only once and objects
are listed beneath that single heading.

Parameters:
findings (Array<object>) - findings in one scope

Returns:
Array<[string, Array<object>]> - grouped findings sorted by group size desc

Possible side effects:
None
*/
function groupFindingsByLevelKey(findings) {
  const groupMap = new Map();

  (findings || []).forEach((finding) => {
    const { normalizedKey, displayKey } = normalizeLevelGroupKey(finding?.level3Key);

    if (!groupMap.has(normalizedKey)) {
      groupMap.set(normalizedKey, {
        displayKey,
        items: [],
      });
    }

    groupMap.get(normalizedKey).items.push(finding);
  });

  return Array.from(groupMap.values())
    .map((groupValue) => [groupValue.displayKey, sortFindingsForDisplay(groupValue.items)])
    .sort((leftGroup, rightGroup) => {
      if (rightGroup[1].length !== leftGroup[1].length) {
        return rightGroup[1].length - leftGroup[1].length;
      }

      return String(leftGroup[0]).localeCompare(String(rightGroup[0]), undefined, { sensitivity: "base" });
    });
}

/*
Purpose:
Collect one group's issues for a single severity and keep them grouped by
object so group-level modal can display findings object-by-object.

Parameters:
groupFindings (Array<object>) - findings in one group
severityKind ("error" | "warning") - selected severity

Returns:
Array<object> - grouped object entries with severity-filtered issue lists

Possible side effects:
None
*/
function buildGroupedObjectSeverityRows(groupFindings, severityKind) {
  const safeSeverityKind = severityKind === "error" ? "error" : "warning";

  return (groupFindings || []).reduce((groupedRows, finding) => {
    const filteredIssues = Array.isArray(finding?.issues)
      ? finding.issues.filter((issue) => normalizeIssueSeverity(issue?.severity) === safeSeverityKind)
      : [];

    if (filteredIssues.length === 0) {
      return groupedRows;
    }

    groupedRows.push({
      objectName: finding?.name || "Unnamed",
      objectGlobalId: finding?.globalId || "-",
      objectIfcEntity: finding?.ifcEntity || "-",
      objectExpressId: finding?.expressId ?? "-",
      issues: filteredIssues,
    });

    return groupedRows;
  }, []);
}

/*
Purpose:
Render clickable severity badge in group summary that opens one grouped modal
for all errors or all warnings in that group.

Parameters:
severityKind ("error" | "warning") - selected severity
severityCount (number) - issue count shown in badge
payloadKey (string) - lookup key for stored modal payload

Returns:
string - button HTML, empty string when count is zero

Possible side effects:
None
*/
function renderGroupSeverityBadgeButton(severityKind, severityCount, payloadKey) {
  const safeSeverityKind = severityKind === "error" ? "error" : "warning";
  const safeSeverityCount = Number(severityCount || 0);
  if (safeSeverityCount <= 0 || !payloadKey) {
    return "";
  }

  const badgeLabel = safeSeverityKind === "error" ? "Errors" : "Warnings";
  const badgeClassName = safeSeverityKind === "error" ? "finding-badge-error" : "finding-badge-warning";

  return `
    <button
      type="button"
      class="finding-badge finding-badge-action ${badgeClassName}"
      data-group-finding-modal-open="${safeSeverityKind}"
      data-group-finding-modal-key="${payloadKey}"
      aria-label="Open ${badgeLabel.toLowerCase()} modal for this group"
    >
      ${badgeLabel}: ${safeSeverityCount}
    </button>
  `;
}

/*
Purpose:
Render one grouped block where group heading appears once and expands to one
object table.

Parameters:
scopeKey ("product" | "system") - scope id
groupKey (string) - group heading
groupFindings (Array<object>) - findings in this group
showWarnings (boolean) - true to render warning-specific group UI

Returns:
string - grouped details block HTML

Possible side effects:
None
*/
function renderGroupBlock(scopeKey, groupKey, groupFindings, showWarnings) {
  const groupTotals = groupFindings.reduce(
    (accumulator, finding) => {
      const findingStats = countIssueSeverities(finding?.issues);
      const objectHasErrors = findingStats.errorCount > 0;
      return {
        objectCount: accumulator.objectCount + 1,
        errorCount: accumulator.errorCount + findingStats.errorCount,
        warningCount: accumulator.warningCount + findingStats.warningCount,
        passedObjectCount: accumulator.passedObjectCount + (objectHasErrors ? 0 : 1),
        failedObjectCount: accumulator.failedObjectCount + (objectHasErrors ? 1 : 0),
      };
    },
    { objectCount: 0, errorCount: 0, warningCount: 0, passedObjectCount: 0, failedObjectCount: 0 },
  );
  const groupSeverityClass = groupTotals.failedObjectCount > 0 ? "finding-group-has-errors" : "finding-group-no-errors";
  const errorGroupedRows = buildGroupedObjectSeverityRows(groupFindings, "error");
  const warningGroupedRows = showWarnings ? buildGroupedObjectSeverityRows(groupFindings, "warning") : [];
  const errorPayloadKey = errorGroupedRows.length > 0
    ? registerGroupSeverityPayload({
      groupKey,
      severityKind: "error",
      groupedRows: errorGroupedRows,
      totalIssueCount: groupTotals.errorCount,
    })
    : "";
  const warningPayloadKey = showWarnings && warningGroupedRows.length > 0
    ? registerGroupSeverityPayload({
      groupKey,
      severityKind: "warning",
      groupedRows: warningGroupedRows,
      totalIssueCount: groupTotals.warningCount,
    })
    : "";
  const errorObjectGuidList = groupFindings.reduce((guidAccumulator, finding) => {
    const findingSeverityCounts = countIssueSeverities(finding?.issues);
    if (findingSeverityCounts.errorCount <= 0) {
      return guidAccumulator;
    }

    const normalizedGuid = String(finding?.globalId || "").trim();
    if (!normalizedGuid || guidAccumulator.includes(normalizedGuid)) {
      return guidAccumulator;
    }

    guidAccumulator.push(normalizedGuid);
    return guidAccumulator;
  }, []);
  const groupSelectedErrorObjectCount = errorObjectGuidList.filter((ifcGuid) => isBcfIssueSelectionActive(ifcGuid, "error")).length;
  const isGroupErrorSelectionChecked =
    errorObjectGuidList.length > 0 && groupSelectedErrorObjectCount === errorObjectGuidList.length;

  const objectRows = groupFindings
    .map((finding) => renderObjectRow(finding, scopeKey, groupKey, showWarnings))
    .join("");
  const warningGroupBadgeMarkup = showWarnings
    ? renderGroupSeverityBadgeButton("warning", groupTotals.warningCount, warningPayloadKey)
    : "";
  const warningHeaderMarkup = showWarnings ? "<th>Warnings</th>" : "";

  return `
    <details class="finding-group ${groupSeverityClass}">
      <summary class="finding-group-summary">
        <span class="finding-group-title">${escapeHtml(groupKey)}</span>
        <span class="finding-group-badges">
          <label class="finding-group-bcf-toggle" aria-label="Select all errors in group for BCF creation">
            <input
              type="checkbox"
              data-bcf-group-selection-toggle="errors"
              data-bcf-group-guids="${encodeDataAttributeValue(JSON.stringify(errorObjectGuidList))}"
              ${errorObjectGuidList.length > 0 ? "" : "disabled"}
              ${isGroupErrorSelectionChecked ? "checked" : ""}
            />
            <span>Create BCFs</span>
          </label>
          <span class="finding-badge finding-badge-neutral" data-object-pass-fail-count>${renderObjectPassFailCountMarkup(groupTotals.passedObjectCount, groupTotals.failedObjectCount)}</span>
          ${renderGroupSeverityBadgeButton("error", groupTotals.errorCount, errorPayloadKey)}
          ${warningGroupBadgeMarkup}
        </span>
      </summary>
      <div class="finding-group-body">
        <div class="table-scroll-shell table-scroll-shell-object" data-object-table-scroll-shell>
          <table class="object-table">
            <thead>
              <tr>
                <th>Object name</th>
                <th>IFC type</th>
                <th>IFC GUID</th>
                <th>ExpressId</th>
                <th>Status</th>
                <th>Errors</th>
                ${warningHeaderMarkup}
                <th class="bcf-selection-column">Create BCF</th>
              </tr>
            </thead>
            <tbody>${objectRows}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}

/*
Purpose:
Render one scope section using grouped blocks, where each heading appears once
and drill-down continues through object rows and finding modals.

Parameters:
sectionTitle (string) - visible scope title
scopeKey ("product" | "system") - scope id
findings (Array<object>) - scope findings
showWarnings (boolean) - true to render warning columns and warning badges

Returns:
string - scope section HTML

Possible side effects:
None
*/
function renderScopeSection(sectionTitle, scopeKey, findings, showWarnings) {
  const safeFindings = Array.isArray(findings) ? findings : [];

  if (safeFindings.length === 0) {
    return `
      <section class="report-scope-section" data-scope="${scopeKey}">
        <h3 class="report-section-title">${escapeHtml(sectionTitle)} (0)</h3>
        <div class="report-item">
          <p class="report-item-meta">No findings in this section.</p>
        </div>
      </section>
    `;
  }

  const groupedFindings = groupFindingsByLevelKey(safeFindings);
  const groupMarkup = groupedFindings
    .map(([groupKey, groupItems]) => renderGroupBlock(scopeKey, groupKey, groupItems, showWarnings))
    .join("");

  return `
    <section class="report-scope-section" data-scope="${scopeKey}">
      <h3 class="report-section-title">${escapeHtml(sectionTitle)} (${safeFindings.length})</h3>
      <div class="report-section-list">${groupMarkup}</div>
    </section>
  `;
}

/*
Purpose:
Render filter toolbar used for narrowing object rows in report drill-down.

Parameters:
showWarnings (boolean) - true to include warning filter mode

Returns:
string - filter toolbar HTML

Possible side effects:
None
*/
function renderFilterToolbar(showWarnings) {
  const warningFilterOptionMarkup = showWarnings ? '<option value="warnings">Warnings only</option>' : "";
  const searchPlaceholder = showWarnings
    ? "Name, IFC GUID, error/warning message..."
    : "Name, IFC GUID, error message...";

  return `
    <div class="report-toolbar">
      <label class="report-filter-field">
        <span>Search</span>
        <input type="search" data-report-filter="query" class="report-filter-input" placeholder="${searchPlaceholder}" />
      </label>
      <label class="report-filter-field">
        <span>Severity</span>
        <select data-report-filter="severity" class="report-filter-select">
          <option value="all">All</option>
          <option value="errors">Errors only</option>
          ${warningFilterOptionMarkup}
          <option value="unidentified">Unidentified only</option>
        </select>
      </label>
      <button type="button" class="report-filter-button" data-report-filter="clear">Clear filters</button>
      <div class="report-filter-result">Visible objects: <strong data-filter-result-count>0</strong></div>
    </div>
    <div class="report-filter-empty" data-report-filter="empty" hidden>
      No objects matched current filters.
    </div>
  `;
}

/*
Purpose:
Render shared finding modal shell that can display either warnings or errors for
the selected object row.

Parameters:
None

Returns:
string - finding modal HTML

Possible side effects:
None
*/
function renderFindingModalShell() {
  return `
    <div class="finding-modal" data-finding-modal hidden>
      <div class="finding-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="finding-modal-title" tabindex="-1">
        <div class="finding-modal-header">
          <h4 id="finding-modal-title" class="finding-modal-title">Errors and warnings</h4>
          <button type="button" class="finding-modal-close" data-finding-modal-close="true" aria-label="Close finding modal">
            Close
          </button>
        </div>
        <p class="finding-modal-subtitle" data-finding-modal-subtitle></p>
        <div class="finding-object-meta" data-finding-object-meta></div>
        <div class="finding-modal-content" data-finding-modal-content></div>
      </div>
    </div>
  `;
}

/*
Purpose:
Decode one modal payload and return array rows safely.

Parameters:
encodedPayload (string | null) - encoded payload stored in table action element

Returns:
Array<object> - parsed rows

Possible side effects:
None
*/
function parseFindingPayload(encodedPayload) {
  if (!encodedPayload) {
    return [];
  }

  try {
    const decodedPayload = decodeURIComponent(encodedPayload);
    const parsedPayload = JSON.parse(decodedPayload);
    return Array.isArray(parsedPayload) ? parsedPayload : [];
  } catch (error) {
    return [];
  }
}

/*
Purpose:
Render grouped modal content where one severity is split object-by-object so
reviewing large collapsed groups remains practical.

Parameters:
groupedRows (Array<object>) - grouped object entries
severityKind ("error" | "warning") - selected severity

Returns:
string - modal content HTML

Possible side effects:
None
*/
function renderGroupedSeverityFindingSections(groupedRows, severityKind) {
  const safeGroupedRows = Array.isArray(groupedRows) ? groupedRows : [];
  const safeSeverityKind = severityKind === "error" ? "error" : "warning";
  const severityLabel = safeSeverityKind === "error" ? "Errors" : "Warnings";

  if (safeGroupedRows.length === 0) {
    return `<div class="finding-empty-state">No ${severityLabel.toLowerCase()} were found for this group.</div>`;
  }

  return safeGroupedRows
    .map((groupedRow) => {
      const objectRows = Array.isArray(groupedRow?.issues) ? groupedRow.issues : [];
      const objectGlobalId = String(groupedRow?.objectGlobalId || "-");
      return `
        <section class="grouped-finding-section">
          <h5 class="grouped-finding-title">${escapeHtml(groupedRow?.objectName || "Unnamed")} | IFC GUID: ${escapeHtml(groupedRow?.objectGlobalId || "-")}</h5>
          <div class="grouped-finding-meta">
            <span><strong>IFC type:</strong> ${escapeHtml(groupedRow?.objectIfcEntity || "-")}</span>
            <span><strong>ExpressId:</strong> ${escapeHtml(groupedRow?.objectExpressId ?? "-")}</span>
            <label class="finding-bcf-toggle">
              <input
                type="checkbox"
                data-bcf-selection-toggle="true"
                data-bcf-selection-guid="${encodeDataAttributeValue(objectGlobalId)}"
                data-bcf-selection-severity="${safeSeverityKind}"
                ${isBcfIssueSelectionActive(objectGlobalId, safeSeverityKind) ? "checked" : ""}
              />
              <span>Create BCF</span>
            </label>
          </div>
          ${renderSeverityFindingTable(objectRows, safeSeverityKind)}
        </section>
      `;
    })
    .join("");
}

/*
Purpose:
Open finding modal for one row and one severity with object context metadata.

Parameters:
reportListElement (HTMLElement) - report root element
modalKind ("error" | "warning") - rendered severity kind
objectName (string) - object display name
objectGlobalId (string) - object IFC GUID
objectIfcEntity (string) - IFC entity label
objectExpressId (string) - expressId label
findingRows (Array<object>) - severity-specific rows

Returns:
void

Possible side effects:
- Shows modal.
- Replaces modal content.
*/
function openFindingModal(
  reportListElement,
  modalKind,
  objectName,
  objectGlobalId,
  objectIfcEntity,
  objectExpressId,
  findingRows,
) {
  const findingModalElement = reportListElement.querySelector("[data-finding-modal]");
  const findingModalDialogElement = reportListElement.querySelector(".finding-modal-dialog");
  const findingModalTitleElement = reportListElement.querySelector("#finding-modal-title");
  const findingModalSubtitleElement = reportListElement.querySelector("[data-finding-modal-subtitle]");
  const findingObjectMetaElement = reportListElement.querySelector("[data-finding-object-meta]");
  const findingModalContentElement = reportListElement.querySelector("[data-finding-modal-content]");

  if (
    !findingModalElement ||
    !findingModalDialogElement ||
    !findingModalTitleElement ||
    !findingModalSubtitleElement ||
    !findingObjectMetaElement ||
    !findingModalContentElement
  ) {
    return;
  }

  const safeModalKind = modalKind === "error" ? "error" : "warning";
  const severityLabel = safeModalKind === "error" ? "Errors" : "Warnings";
  const normalizedObjectGlobalId = String(objectGlobalId || "-");
  findingModalTitleElement.textContent = `${severityLabel} (${findingRows.length})`;
  findingModalSubtitleElement.textContent = `${objectName || "Unnamed"} | IFC GUID: ${objectGlobalId || "-"}`;
  findingObjectMetaElement.innerHTML = `
    <span><strong>IFC type:</strong> ${escapeHtml(objectIfcEntity || "-")}</span>
    <span><strong>ExpressId:</strong> ${escapeHtml(objectExpressId || "-")}</span>
    <label class="finding-bcf-toggle">
      <input
        type="checkbox"
        data-bcf-selection-toggle="true"
        data-bcf-selection-guid="${encodeDataAttributeValue(normalizedObjectGlobalId)}"
        data-bcf-selection-severity="${safeModalKind}"
        ${isBcfIssueSelectionActive(normalizedObjectGlobalId, safeModalKind) ? "checked" : ""}
      />
      <span>Create BCF</span>
    </label>
  `;
  findingModalContentElement.innerHTML = renderSeverityFindingTable(findingRows, safeModalKind);
  findingModalElement.hidden = false;
  document.body.classList.add("modal-open");
  syncBcfSelectionControls(reportListElement);
  findingModalDialogElement.focus();
}

/*
Purpose:
Open one grouped severity modal for collapsed/expanded group summary badges.

Parameters:
reportListElement (HTMLElement) - report root element
groupPayload (object) - stored group-level modal payload

Returns:
void

Possible side effects:
- Shows modal with grouped object sections.
*/
function openGroupFindingModal(reportListElement, groupPayload) {
  const findingModalElement = reportListElement.querySelector("[data-finding-modal]");
  const findingModalDialogElement = reportListElement.querySelector(".finding-modal-dialog");
  const findingModalTitleElement = reportListElement.querySelector("#finding-modal-title");
  const findingModalSubtitleElement = reportListElement.querySelector("[data-finding-modal-subtitle]");
  const findingObjectMetaElement = reportListElement.querySelector("[data-finding-object-meta]");
  const findingModalContentElement = reportListElement.querySelector("[data-finding-modal-content]");

  if (
    !findingModalElement ||
    !findingModalDialogElement ||
    !findingModalTitleElement ||
    !findingModalSubtitleElement ||
    !findingObjectMetaElement ||
    !findingModalContentElement
  ) {
    return;
  }

  const safeSeverityKind = groupPayload?.severityKind === "error" ? "error" : "warning";
  const severityLabel = safeSeverityKind === "error" ? "Errors" : "Warnings";
  const groupedRows = Array.isArray(groupPayload?.groupedRows) ? groupPayload.groupedRows : [];
  const totalIssueCount = Number(groupPayload?.totalIssueCount || 0);

  findingModalTitleElement.textContent = `${severityLabel} (${totalIssueCount})`;
  findingModalSubtitleElement.textContent = `Group: ${groupPayload?.groupKey || "Unknown group"}`;
  findingObjectMetaElement.innerHTML = `
    <span><strong>Mode:</strong> Grouped by object</span>
    <span><strong>Objects:</strong> ${groupedRows.length}</span>
  `;
  findingModalContentElement.innerHTML = renderGroupedSeverityFindingSections(groupedRows, safeSeverityKind);
  findingModalElement.hidden = false;
  document.body.classList.add("modal-open");
  syncBcfSelectionControls(reportListElement);
  findingModalDialogElement.focus();
}

/*
Purpose:
Close finding modal.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Hides modal.
*/
function closeFindingModal(reportListElement) {
  const findingModalElement = reportListElement.querySelector("[data-finding-modal]");
  if (findingModalElement) {
    findingModalElement.hidden = true;
  }
  document.body.classList.remove("modal-open");
}

/*
Purpose:
Collect all currently selectable IFC GUID + severity pairs from rendered object
rows so stale selections can be removed when report content changes.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
Set<string> - selection keys that are valid for currently rendered report

Possible side effects:
None
*/
function collectRenderedSelectableBcfIssueKeys(reportListElement) {
  const renderedKeys = new Set();
  if (!reportListElement) {
    return renderedKeys;
  }

  const objectRows = Array.from(reportListElement.querySelectorAll(".object-row"));
  objectRows.forEach((objectRow) => {
    const rowIfcGuid = decodeDataAttributeValue(objectRow.getAttribute("data-object-guid"));
    if (!rowIfcGuid) {
      return;
    }

    const rowErrorCount = Number(objectRow.getAttribute("data-error-count") || "0");
    const rowWarningCount = Number(objectRow.getAttribute("data-warning-count") || "0");
    const warningSelectionVisible = objectRow.querySelector(".warning-indicator-button") !== null;

    if (rowErrorCount > 0) {
      const errorSelectionKey = buildBcfIssueSelectionKey(rowIfcGuid, "error");
      if (errorSelectionKey) {
        renderedKeys.add(errorSelectionKey);
      }
    }

    if (rowWarningCount > 0 && warningSelectionVisible) {
      const warningSelectionKey = buildBcfIssueSelectionKey(rowIfcGuid, "warning");
      if (warningSelectionKey) {
        renderedKeys.add(warningSelectionKey);
      }
    }
  });

  return renderedKeys;
}

/*
Purpose:
Prune selection state against currently rendered report content so stale keys
from older checker runs cannot leak into the next BCF creation batch.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Removes obsolete keys from in-memory BCF selection set.
*/
function pruneBcfIssueSelectionsForRenderedReport(reportListElement) {
  const renderedSelectableKeys = collectRenderedSelectableBcfIssueKeys(reportListElement);
  Array.from(selectedBcfIssueKeys).forEach((selectedKey) => {
    if (!renderedSelectableKeys.has(selectedKey)) {
      selectedBcfIssueKeys.delete(selectedKey);
    }
  });
}

/*
Purpose:
Synchronize all visible BCF selection controls with current in-memory selection
state, including group-level indeterminate behavior for error mass-selection.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Mutates checkbox checked/indeterminate states.
*/
function syncBcfSelectionControls(reportListElement) {
  if (!reportListElement) {
    return;
  }

  const directSelectionCheckboxes = Array.from(reportListElement.querySelectorAll('[data-bcf-selection-toggle="true"]'));
  directSelectionCheckboxes.forEach((selectionCheckbox) => {
    if (!(selectionCheckbox instanceof HTMLInputElement)) {
      return;
    }

    const ifcGuid = decodeDataAttributeValue(selectionCheckbox.getAttribute("data-bcf-selection-guid"));
    const severityKind = normalizeBcfSeverityKind(selectionCheckbox.getAttribute("data-bcf-selection-severity"));
    const selectionKey = buildBcfIssueSelectionKey(ifcGuid, severityKind);

    if (!selectionKey) {
      selectionCheckbox.checked = false;
      selectionCheckbox.disabled = true;
      return;
    }

    selectionCheckbox.checked = selectedBcfIssueKeys.has(selectionKey);
  });

  const groupErrorSelectionCheckboxes = Array.from(
    reportListElement.querySelectorAll('[data-bcf-group-selection-toggle="errors"]'),
  );
  groupErrorSelectionCheckboxes.forEach((groupSelectionCheckbox) => {
    if (!(groupSelectionCheckbox instanceof HTMLInputElement)) {
      return;
    }

    const groupGuidList = parseEncodedGroupGuidList(groupSelectionCheckbox.getAttribute("data-bcf-group-guids"));
    const normalizedGuidList = Array.from(new Set(groupGuidList));
    if (normalizedGuidList.length === 0) {
      groupSelectionCheckbox.checked = false;
      groupSelectionCheckbox.indeterminate = false;
      groupSelectionCheckbox.disabled = true;
      return;
    }

    const selectedCount = normalizedGuidList.filter((ifcGuid) => isBcfIssueSelectionActive(ifcGuid, "error")).length;
    groupSelectionCheckbox.disabled = false;
    groupSelectionCheckbox.checked = selectedCount === normalizedGuidList.length;
    groupSelectionCheckbox.indeterminate = selectedCount > 0 && selectedCount < normalizedGuidList.length;
  });
}

/*
Purpose:
Bind modal interactions for both warning and error indicators in report table.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Attaches click/keyboard handlers.
*/
function bindFindingModalControls(reportListElement) {
  if (!reportListElement) {
    return;
  }

  if (reportListElement.dataset.findingModalBound === "true") {
    return;
  }

  reportListElement.dataset.findingModalBound = "true";

  reportListElement.addEventListener("click", (clickEvent) => {
    const selectionClickTarget = clickEvent.target instanceof Element
      ? clickEvent.target.closest('[data-bcf-selection-toggle="true"], [data-bcf-group-selection-toggle]')
      : null;

    if (selectionClickTarget) {
      clickEvent.stopPropagation();
    }

    const groupOpenTrigger = clickEvent.target instanceof Element
      ? clickEvent.target.closest("[data-group-finding-modal-open]")
      : null;

    if (groupOpenTrigger) {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();

      const payloadKey = groupOpenTrigger.getAttribute("data-group-finding-modal-key");
      const groupPayload = readGroupSeverityPayload(payloadKey);
      if (!groupPayload) {
        return;
      }

      openGroupFindingModal(reportListElement, groupPayload);
      return;
    }

    const openTrigger = clickEvent.target instanceof Element
      ? clickEvent.target.closest("[data-finding-modal-open]")
      : null;

    if (openTrigger) {
      const findingRows = parseFindingPayload(openTrigger.getAttribute("data-finding-modal-payload"));
      const modalKind = openTrigger.getAttribute("data-finding-modal-open") === "error" ? "error" : "warning";
      const objectName = decodeDataAttributeValue(openTrigger.getAttribute("data-finding-object-name")) || "Unnamed";
      const objectGlobalId = decodeDataAttributeValue(openTrigger.getAttribute("data-finding-object-guid")) || "-";
      const objectIfcEntity = decodeDataAttributeValue(openTrigger.getAttribute("data-finding-object-ifc")) || "-";
      const objectExpressId = decodeDataAttributeValue(openTrigger.getAttribute("data-finding-object-expressid")) || "-";

      openFindingModal(
        reportListElement,
        modalKind,
        objectName,
        objectGlobalId,
        objectIfcEntity,
        objectExpressId,
        findingRows,
      );
      return;
    }

    const closeTrigger = clickEvent.target instanceof Element
      ? clickEvent.target.closest("[data-finding-modal-close]")
      : null;

    if (closeTrigger) {
      closeFindingModal(reportListElement);
      return;
    }

    const findingModalElement = reportListElement.querySelector("[data-finding-modal]");
    if (findingModalElement && clickEvent.target === findingModalElement) {
      closeFindingModal(reportListElement);
    }
  });

  reportListElement.addEventListener("change", (changeEvent) => {
    const directSelectionCheckbox = changeEvent.target instanceof Element
      ? changeEvent.target.closest('[data-bcf-selection-toggle="true"]')
      : null;

    if (directSelectionCheckbox instanceof HTMLInputElement) {
      const ifcGuid = decodeDataAttributeValue(directSelectionCheckbox.getAttribute("data-bcf-selection-guid"));
      const severityKind = directSelectionCheckbox.getAttribute("data-bcf-selection-severity");
      setBcfIssueSelectionState(ifcGuid, severityKind, directSelectionCheckbox.checked);
      syncBcfSelectionControls(reportListElement);
      return;
    }

    const groupSelectionCheckbox = changeEvent.target instanceof Element
      ? changeEvent.target.closest('[data-bcf-group-selection-toggle="errors"]')
      : null;

    if (groupSelectionCheckbox instanceof HTMLInputElement) {
      const groupGuidList = parseEncodedGroupGuidList(groupSelectionCheckbox.getAttribute("data-bcf-group-guids"));
      const selectAllErrors = groupSelectionCheckbox.checked;
      groupGuidList.forEach((ifcGuid) => {
        setBcfIssueSelectionState(ifcGuid, "error", selectAllErrors);
      });
      syncBcfSelectionControls(reportListElement);
    }
  });

  reportListElement.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      closeFindingModal(reportListElement);
    }
  });
}

/*
Purpose:
Capture wheel scrolling inside object-table containers so scrolling first advances
the table body while header stays visible. When top/bottom is reached, wheel
events are released back to normal page scrolling.

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Attaches non-passive wheel listener on report area.
- Mutates scrollTop for object table wrappers.
*/
function bindObjectTableScrollCapture(reportListElement) {
  if (!reportListElement) {
    return;
  }

  if (reportListElement.dataset.objectTableScrollBound === "true") {
    return;
  }

  reportListElement.dataset.objectTableScrollBound = "true";

  reportListElement.addEventListener(
    "wheel",
    (wheelEvent) => {
      if (!(wheelEvent.target instanceof Element)) {
        return;
      }

      const tableScrollShell = wheelEvent.target.closest("[data-object-table-scroll-shell]");
      if (!(tableScrollShell instanceof HTMLElement)) {
        return;
      }

      const deltaY = Number(wheelEvent.deltaY || 0);
      if (deltaY === 0) {
        return;
      }

      const canScrollDown = tableScrollShell.scrollTop + tableScrollShell.clientHeight < tableScrollShell.scrollHeight - 1;
      const canScrollUp = tableScrollShell.scrollTop > 0;
      const shouldConsumeWheel = (deltaY > 0 && canScrollDown) || (deltaY < 0 && canScrollUp);

      if (!shouldConsumeWheel) {
        return;
      }

      wheelEvent.preventDefault();
      tableScrollShell.scrollTop += deltaY;
    },
    { passive: false },
  );
}

/*
Purpose:
Normalize object-row severity cells so warning indicators always live in
Warnings column and error indicators always live in Errors column.

Logic:
- Collect error and warning indicator buttons from the full row.
- Resolve or create dedicated Errors and Warnings cells.
- Rebuild those two cells deterministically:
  - Errors: error button or "-" placeholder
  - Warnings: warning button only

Parameters:
reportListElement (HTMLElement) - report root element

Returns:
void

Possible side effects:
- Mutates object-row cell content to enforce column mapping.
*/
function normalizeObjectSeverityColumns(reportListElement, showWarnings) {
  if (!reportListElement) {
    return;
  }

  const objectRows = Array.from(reportListElement.querySelectorAll(".object-row"));
  objectRows.forEach((objectRow) => {
    if (!(objectRow instanceof HTMLElement)) {
      return;
    }

    const firstErrorButton = objectRow.querySelector(".error-indicator-button");
    const firstWarningButton = objectRow.querySelector(".warning-indicator-button");

    const directCellsBeforeNormalization = Array.from(objectRow.children).filter(
      (childElement) => childElement instanceof HTMLTableCellElement,
    );
    directCellsBeforeNormalization
      .filter((tableCellElement) => {
        const columnName = tableCellElement.getAttribute("data-column");
        return (
          columnName === "errors" ||
          columnName === "warnings" ||
          tableCellElement.classList.contains("error-column-cell") ||
          tableCellElement.classList.contains("warning-column-cell")
        );
      })
      .forEach((existingSeverityCell) => {
        existingSeverityCell.remove();
      });

    const errorCell = document.createElement("td");
    errorCell.className = "number-cell error-column-cell";
    errorCell.setAttribute("data-column", "errors");

    if (firstErrorButton instanceof HTMLElement) {
      errorCell.append(firstErrorButton);
    } else {
      errorCell.innerHTML = '<span class="severity-empty-placeholder" aria-hidden="true">-</span>';
    }

    let warningCell = null;
    if (showWarnings) {
      warningCell = document.createElement("td");
      warningCell.className = "number-cell warning-column-cell";
      warningCell.setAttribute("data-column", "warnings");

      if (firstWarningButton instanceof HTMLElement) {
        warningCell.append(firstWarningButton);
      }
    }

    const rowCells = Array.from(objectRow.children).filter((childElement) => childElement instanceof HTMLTableCellElement);
    const statusCell = rowCells[4] || null;
    if (statusCell instanceof HTMLElement) {
      statusCell.insertAdjacentElement("afterend", errorCell);
      if (warningCell) {
        errorCell.insertAdjacentElement("afterend", warningCell);
      }
    } else {
      objectRow.append(errorCell);
      if (warningCell) {
        objectRow.append(warningCell);
      }
    }

    if (!showWarnings && firstWarningButton instanceof HTMLElement) {
      firstWarningButton.remove();
    }
  });
}

/*
Purpose:
Apply current filter controls to object rows and then hide or show group/scope
containers based on remaining visible rows.

Parameters:
reportListElement (HTMLElement) - report list root element

Returns:
void

Possible side effects:
- Mutates hidden state for rows/groups/sections.
- Updates visible object counters.
*/
function applyReportFilters(reportListElement) {
  if (!reportListElement) {
    return;
  }

  const queryInput = reportListElement.querySelector('[data-report-filter="query"]');
  const severitySelect = reportListElement.querySelector('[data-report-filter="severity"]');
  const resultCountElement = reportListElement.querySelector('[data-filter-result-count]');
  const emptyStateElement = reportListElement.querySelector('[data-report-filter="empty"]');

  const normalizedQuery = String(queryInput?.value || "").trim().toLowerCase();
  const severityMode = String(severitySelect?.value || "all");

  const objectRows = Array.from(reportListElement.querySelectorAll(".object-row"));

  objectRows.forEach((objectRow) => {
    const rowSearchText = String(objectRow.getAttribute("data-search") || "").toLowerCase();
    const rowErrorCount = Number(objectRow.getAttribute("data-error-count") || "0");
    const rowWarningCount = Number(objectRow.getAttribute("data-warning-count") || "0");
    const rowIsUnidentified = objectRow.getAttribute("data-unidentified") === "true";

    const queryMatch = normalizedQuery === "" || rowSearchText.includes(normalizedQuery);

    let severityMatch = true;
    if (severityMode === "errors") {
      severityMatch = rowErrorCount > 0;
    } else if (severityMode === "warnings") {
      severityMatch = rowWarningCount > 0;
    } else if (severityMode === "unidentified") {
      severityMatch = rowIsUnidentified;
    }

    objectRow.hidden = !(queryMatch && severityMatch);
  });

  const findingGroups = Array.from(reportListElement.querySelectorAll(".finding-group"));
  findingGroups.forEach((findingGroup) => {
    const allRowsInGroup = Array.from(findingGroup.querySelectorAll(".object-row"));
    const visibleRowsInGroup = allRowsInGroup.filter((objectRow) => !objectRow.hidden);
    const visiblePassedObjects = visibleRowsInGroup.filter(
      (objectRow) => Number(objectRow.getAttribute("data-error-count") || "0") === 0,
    ).length;
    const visibleFailedObjects = visibleRowsInGroup.length - visiblePassedObjects;

    findingGroup.hidden = visibleRowsInGroup.length === 0;
    findingGroup.classList.toggle("finding-group-no-errors", visibleRowsInGroup.length > 0 && visibleFailedObjects === 0);
    findingGroup.classList.toggle("finding-group-has-errors", visibleFailedObjects > 0);

    const objectPassFailBadge = findingGroup.querySelector("[data-object-pass-fail-count]");
    if (objectPassFailBadge) {
      objectPassFailBadge.innerHTML = renderObjectPassFailCountMarkup(visiblePassedObjects, visibleFailedObjects);
    }
  });

  const scopeSections = Array.from(reportListElement.querySelectorAll(".report-scope-section"));
  scopeSections.forEach((scopeSection) => {
    const hasVisibleGroup = scopeSection.querySelector(".finding-group:not([hidden])") !== null;
    const hasStandaloneItem = scopeSection.querySelector(".report-item") !== null;

    scopeSection.hidden = !hasVisibleGroup && !hasStandaloneItem;
  });

  const visibleObjectCount = objectRows.filter((objectRow) => !objectRow.hidden).length;
  if (resultCountElement) {
    resultCountElement.textContent = String(visibleObjectCount);
  }

  if (emptyStateElement) {
    emptyStateElement.hidden = visibleObjectCount !== 0;
  }
}

/*
Purpose:
Bind toolbar controls to filter logic after report list HTML is rendered.

Parameters:
reportListElement (HTMLElement) - report list root element

Returns:
void

Possible side effects:
- Attaches event listeners to toolbar controls.
*/
function bindReportFilterControls(reportListElement) {
  if (!reportListElement) {
    return;
  }

  const queryInput = reportListElement.querySelector('[data-report-filter="query"]');
  const severitySelect = reportListElement.querySelector('[data-report-filter="severity"]');
  const clearButton = reportListElement.querySelector('[data-report-filter="clear"]');

  queryInput?.addEventListener("input", () => {
    applyReportFilters(reportListElement);
  });

  severitySelect?.addEventListener("change", () => {
    applyReportFilters(reportListElement);
  });

  clearButton?.addEventListener("click", () => {
    if (queryInput) {
      queryInput.value = "";
    }

    if (severitySelect) {
      severitySelect.value = "all";
    }

    applyReportFilters(reportListElement);
  });

  applyReportFilters(reportListElement);
}

/*
Purpose:
Render top summary cards using checker summary payload.

Parameters:
summaryElement (HTMLElement) - summary container
summary (object | null) - checker summary payload
renderOptions (object) - rendering flags, for example warning visibility

Returns:
void

Possible side effects:
- Replaces summary container HTML.
*/
export function renderReportSummary(summaryElement, summary, renderOptions = {}) {
  if (!summaryElement) {
    return;
  }

  if (!summary) {
    summaryElement.innerHTML = "";
    return;
  }

  const showWarnings = renderOptions?.showWarnings !== false;
  const summaryCards = [
    renderSummaryCard("Checked objects", summary.checkedObjects),
    renderSummaryCard("Product rows", summary.productFindings),
    renderSummaryCard("System rows", summary.systemFindings),
    renderSummaryCard("Errors", summary.errorCount),
    renderSummaryCard("Unidentified", summary.unidentifiedFindings),
  ];
  if (showWarnings) {
    summaryCards.splice(4, 0, renderSummaryCard("Warnings", summary.warningCount));
  }

  summaryElement.innerHTML = summaryCards.join("");
}

/*
Purpose:
Render full findings area with hierarchy:
1) top overview tables,
2) grouped scope sections,
3) object table rows,
4) error/warning modal drill-down.

Parameters:
reportListElement (HTMLElement) - report list container
reportData (object | null) - checker result payload

Returns:
void

Possible side effects:
- Replaces report list HTML.
- Attaches filter handlers.
*/
export function renderReportFindings(reportListElement, reportData) {
  if (!reportListElement) {
    return;
  }

  document.body.classList.remove("modal-open");
  resetGroupSeverityPayloadStore();

  const executionProfile = reportData?.executionProfile || {};
  const showWarnings = resolveShowWarningsFromReportData(reportData);
  const productScopeEnabled = executionProfile?.scopes?.product !== false;
  const systemScopeEnabled = executionProfile?.scopes?.system !== false;
  const productFindings = productScopeEnabled ? reportData?.productFindings || [] : [];
  const systemFindings = systemScopeEnabled ? reportData?.systemFindings || [] : [];
  const hasProductFindings = Array.isArray(productFindings) && productFindings.length > 0;
  const hasSystemFindings = Array.isArray(systemFindings) && systemFindings.length > 0;

  if (!reportData) {
    selectedBcfIssueKeys.clear();
    reportListElement.innerHTML = `
      <div class="empty-state">
        No deviations were found during the check run.
      </div>
    `;
    return;
  }

  if (!hasProductFindings && !hasSystemFindings) {
    selectedBcfIssueKeys.clear();
    reportListElement.innerHTML = `
      ${renderCheckBreakdownSection(reportData, showWarnings)}
      <div class="empty-state">
        No deviations were found during the check run.
      </div>
    `;
    return;
  }

  const scopeSections = [];
  if (productScopeEnabled) {
    scopeSections.push(renderScopeSection("Tuoteosien tarkastusten loydokset", "product", productFindings, showWarnings));
  }

  if (systemScopeEnabled) {
    scopeSections.push(renderScopeSection("Jarjestelmien tarkastusten loydokset", "system", systemFindings, showWarnings));
  }

  reportListElement.innerHTML = `
    ${renderCheckBreakdownSection(reportData, showWarnings)}
    ${renderFilterToolbar(showWarnings)}
    ${scopeSections.join("")}
    ${renderFindingModalShell()}
  `;

  normalizeObjectSeverityColumns(reportListElement, showWarnings);
  pruneBcfIssueSelectionsForRenderedReport(reportListElement);
  syncBcfSelectionControls(reportListElement);
  bindReportFilterControls(reportListElement);
  bindFindingModalControls(reportListElement);
  bindObjectTableScrollCapture(reportListElement);
}

/*
Purpose:
Reset report rendering to idle placeholder state.

Parameters:
summaryElement (HTMLElement) - summary container
reportListElement (HTMLElement) - list container

Returns:
void

Possible side effects:
- Clears summary/list content.
*/
export function clearRenderedReport(summaryElement, reportListElement) {
  document.body.classList.remove("modal-open");
  resetGroupSeverityPayloadStore();
  selectedBcfIssueKeys.clear();

  if (summaryElement) {
    summaryElement.innerHTML = "";
  }

  if (reportListElement) {
    reportListElement.innerHTML = `
      <div class="empty-state">
        Select an IFC model and start validation.
      </div>
    `;
  }
}

/*
Purpose:
Expose currently selected IFC GUID + severity pairs so page-level workflow can
create BCF drafts only from user-selected issues.

Parameters:
None

Returns:
Array<{ ifcGuid: string, severity: "error" | "warning" }> - active selections

Possible side effects:
None
*/
export function getSelectedBcfIssueSelectors() {
  return Array.from(selectedBcfIssueKeys).reduce((selectorAccumulator, selectionKey) => {
    const keySegments = selectionKey.split("::");
    if (keySegments.length < 2) {
      return selectorAccumulator;
    }

    const severitySegment = keySegments.pop();
    const ifcGuidSegment = keySegments.join("::").trim();
    const normalizedSeverity = normalizeBcfSeverityKind(severitySegment);
    if (!ifcGuidSegment || !normalizedSeverity) {
      return selectorAccumulator;
    }

    selectorAccumulator.push({
      ifcGuid: ifcGuidSegment,
      severity: normalizedSeverity,
    });
    return selectorAccumulator;
  }, []);
}
