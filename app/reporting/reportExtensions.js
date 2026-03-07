/*
Purpose:
Provide one dedicated reporting extension layer that converts checker output
into exportable payloads and browser-downloadable JSON files.

Logic:
- Keep report-export and BCF-draft building separate from UI workflow logic.
- Build deterministic metadata so exported files are traceable to project/model.
- Expose pure payload builders for testing and one browser helper for download.

Parameters:
This module exports helper functions documented below.

Returns:
Reporting extension utilities.

Possible side effects:
- `triggerJsonFileDownload` creates an in-browser file download.
*/

/*
Purpose:
Normalize any timestamp-like input into valid ISO string so exports use one
stable UTC timestamp format.

Logic:
If the incoming value is invalid, the function falls back to current time
instead of throwing, because export generation should remain reliable.

Parameters:
timestampCandidate (Date | string | number | null | undefined) - timestamp input

Returns:
string - ISO timestamp in UTC

Possible side effects:
None
*/
function normalizeTimestampToIsoString(timestampCandidate) {
  const candidateDate = timestampCandidate instanceof Date ? timestampCandidate : new Date(timestampCandidate || Date.now());
  if (Number.isNaN(candidateDate.getTime())) {
    return new Date().toISOString();
  }

  return candidateDate.toISOString();
}

/*
Purpose:
Convert a file-name segment into filesystem-safe slug so generated export file
names are readable and portable across operating systems.

Logic:
- Strip extension when present.
- Remove accents to keep output ASCII-only.
- Replace unsupported characters with hyphen separators.

Parameters:
segmentCandidate (unknown) - source text
fallbackValue (string) - fallback segment when source is empty

Returns:
string - sanitized slug segment

Possible side effects:
None
*/
function sanitizeFileNameSegment(segmentCandidate, fallbackValue) {
  const safeFallback = String(fallbackValue || "export").trim() || "export";
  const normalizedText = String(segmentCandidate ?? "").trim();
  const withoutExtension = normalizedText.replace(/\.[a-z0-9]+$/i, "");

  const asciiSlug = withoutExtension
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return asciiSlug || safeFallback;
}

/*
Purpose:
Format ISO timestamp into compact file-name segment to keep exported filenames
chronological and easy to sort in file explorers.

Parameters:
isoTimestamp (string) - ISO timestamp string

Returns:
string - timestamp segment in YYYYMMDD-HHMMSS form

Possible side effects:
None
*/
function buildFileNameTimestampSegment(isoTimestamp) {
  const parsedDate = new Date(isoTimestamp);
  if (Number.isNaN(parsedDate.getTime())) {
    return "00000000-000000";
  }

  const padTwoDigits = (value) => String(value).padStart(2, "0");
  const year = parsedDate.getUTCFullYear();
  const month = padTwoDigits(parsedDate.getUTCMonth() + 1);
  const day = padTwoDigits(parsedDate.getUTCDate());
  const hour = padTwoDigits(parsedDate.getUTCHours());
  const minute = padTwoDigits(parsedDate.getUTCMinutes());
  const second = padTwoDigits(parsedDate.getUTCSeconds());

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

/*
Purpose:
Build deterministic export file name for checker outputs so users can quickly
identify project-model context and export time from the file name itself.

Parameters:
selectedFile (object | null) - selected file metadata
fileKindSuffix (string) - suffix that describes export kind
generatedAt (Date | string | number | null | undefined) - generation time

Returns:
string - generated JSON file name

Possible side effects:
None
*/
export function buildExportFileName(selectedFile, fileKindSuffix, generatedAt) {
  const generatedAtIso = normalizeTimestampToIsoString(generatedAt);
  const fileSegment = sanitizeFileNameSegment(selectedFile?.name, "ifc-model");
  const suffixSegment = sanitizeFileNameSegment(fileKindSuffix, "report");
  const timeSegment = buildFileNameTimestampSegment(generatedAtIso);

  return `${fileSegment}-${suffixSegment}-${timeSegment}.json`;
}

/*
Purpose:
Collect issue rows from checker report into one flat list so BCF draft
construction can treat errors and warnings uniformly.

Logic:
Unidentified findings without explicit issue rows are converted into synthetic
warning rows, because BCF discussions still need one explicit topic message.

Parameters:
reportData (object | null) - checker result payload

Returns:
Array<object> - normalized issue rows

Possible side effects:
None
*/
function collectIssueRowsFromReport(reportData, selectedIssueLookup = null) {
  const normalizedFindings = [
    ...(Array.isArray(reportData?.productFindings) ? reportData.productFindings.map((finding) => ({ scope: "product", finding })) : []),
    ...(Array.isArray(reportData?.systemFindings) ? reportData.systemFindings.map((finding) => ({ scope: "system", finding })) : []),
  ];

  const issueRows = [];
  normalizedFindings.forEach(({ scope, finding }) => {
    const findingIssues = Array.isArray(finding?.issues) ? finding.issues : [];
    const findingGlobalId = String(finding?.globalId || "-");

    if (findingIssues.length === 0 && finding?.isUnidentified) {
      const syntheticSelectionKey = `${findingGlobalId}::warning`;
      if (selectedIssueLookup && !selectedIssueLookup.has(syntheticSelectionKey)) {
        return;
      }

      issueRows.push({
        scope,
        severity: "warning",
        message: "Object could not be identified against code definitions.",
        propertyGroup: "Identification",
        propertyLabel: "Code-list matching",
        objectName: finding?.name || "Unnamed",
        globalId: findingGlobalId,
        ifcEntity: finding?.ifcEntity || "-",
        expressId: finding?.expressId ?? null,
        placementPoint: normalizePlacementPointForBcf(finding?.placementPoint),
      });
      return;
    }

    findingIssues.forEach((issue) => {
      const normalizedSeverity = issue?.severity === "error" ? "error" : "warning";
      const issueSelectionKey = `${findingGlobalId}::${normalizedSeverity}`;
      if (selectedIssueLookup && !selectedIssueLookup.has(issueSelectionKey)) {
        return;
      }

      issueRows.push({
        scope,
        severity: normalizedSeverity,
        message: issue?.message || "Missing issue message.",
        propertyGroup: issue?.propertyGroup || "-",
        propertyLabel: issue?.propertyLabel || "-",
        objectName: finding?.name || "Unnamed",
        globalId: findingGlobalId,
        ifcEntity: finding?.ifcEntity || "-",
        expressId: finding?.expressId ?? null,
        placementPoint: normalizePlacementPointForBcf(finding?.placementPoint),
      });
    });
  });

  return issueRows;
}

/*
Purpose:
Build one fast lookup set from selected BCF selectors so issue filtering during
payload construction can stay simple and deterministic.

Logic:
Each selector is normalized into `ifcGuid::severity` key. Invalid selectors are
ignored because export should not fail on malformed UI payloads.

Parameters:
selectedIssueSelectors (Array<object> | null) - selected IFC GUID + severity pairs

Returns:
Set<string> | null - selection key lookup, or null when all issues should be exported

Possible side effects:
None
*/
function buildSelectedIssueLookup(selectedIssueSelectors) {
  if (!Array.isArray(selectedIssueSelectors)) {
    return null;
  }

  const selectionLookup = new Set();
  selectedIssueSelectors.forEach((selector) => {
    const normalizedGuid = String(selector?.ifcGuid || "").trim();
    const normalizedSeverity = selector?.severity === "error" ? "error" : selector?.severity === "warning" ? "warning" : "";

    if (!normalizedGuid || !normalizedSeverity) {
      return;
    }

    selectionLookup.add(`${normalizedGuid}::${normalizedSeverity}`);
  });

  return selectionLookup;
}

/*
Purpose:
Normalize optional placement-point payload into stable numeric XYZ structure so
BCF integration can safely build marker and camera data when coordinates exist.

Parameters:
placementPointCandidate (unknown) - placement point candidate from checker finding

Returns:
{ x: number, y: number, z: number } | null - normalized point or null when invalid

Possible side effects:
None
*/
function normalizePlacementPointForBcf(placementPointCandidate) {
  if (!placementPointCandidate || typeof placementPointCandidate !== "object") {
    return null;
  }

  const normalizedX = Number(placementPointCandidate.x);
  const normalizedY = Number(placementPointCandidate.y);
  const normalizedZ = Number(placementPointCandidate.z);
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY) || !Number.isFinite(normalizedZ)) {
    return null;
  }

  return {
    x: normalizedX,
    y: normalizedY,
    z: normalizedZ,
  };
}

/*
Purpose:
Build normalized issue rows for BCF topic creation flow so UI can apply generic
and per-topic input settings before sending payloads to Topics API.

Logic:
- Reuse same selector filtering rules as draft export.
- Keep one deterministic row id for stable UI form rendering.

Parameters:
options (object) - issue-row builder inputs
options.reportData (object | null) - checker result payload
options.selectedIssueSelectors (Array<object> | null) - optional IFC GUID + severity filter list

Returns:
Array<object> - normalized BCF issue rows

Possible side effects:
None
*/
export function buildSelectedIssueRowsForBcfCreation({
  reportData,
  selectedIssueSelectors = null,
}) {
  const selectedIssueLookup = buildSelectedIssueLookup(selectedIssueSelectors);
  const issueRows = collectIssueRowsFromReport(reportData, selectedIssueLookup);

  return issueRows.map((issueRow, issueRowIndex) => ({
    ...issueRow,
    rowId: `${issueRow.globalId}::${issueRow.severity}::${issueRowIndex + 1}`,
  }));
}

/*
Purpose:
Create one normalized metadata object reused by both report and BCF exports.

Parameters:
projectContext (object | null) - current project metadata
selectedFile (object | null) - selected IFC metadata
generatedAtIso (string) - generation timestamp in ISO format

Returns:
object - normalized metadata payload

Possible side effects:
None
*/
function buildSharedMetadata(projectContext, selectedFile, generatedAtIso) {
  return {
    generatedAtUtc: generatedAtIso,
    project: {
      id: String(projectContext?.id || ""),
      name: String(projectContext?.name || ""),
    },
    model: {
      fileId: String(selectedFile?.fileId || ""),
      versionId: String(selectedFile?.versionId || ""),
      name: String(selectedFile?.name || ""),
      path: String(selectedFile?.path || ""),
    },
  };
}

/*
Purpose:
Build canonical checker-report export payload that can be saved locally or sent
to future APIs without coupling to current UI structure.

Parameters:
options (object) - report export inputs
options.reportData (object | null) - checker result payload
options.projectContext (object | null) - project metadata
options.selectedFile (object | null) - selected file metadata
options.checkExecutionOptions (object | null) - selected check configuration
options.generatedAt (Date | string | number | null | undefined) - generation time

Returns:
object - export payload

Possible side effects:
None
*/
export function buildCheckerReportExportPayload({
  reportData,
  projectContext,
  selectedFile,
  checkExecutionOptions,
  generatedAt,
}) {
  const generatedAtIso = normalizeTimestampToIsoString(generatedAt);
  const productFindings = Array.isArray(reportData?.productFindings) ? reportData.productFindings : [];
  const systemFindings = Array.isArray(reportData?.systemFindings) ? reportData.systemFindings : [];
  const unknownFindings = Array.isArray(reportData?.unknownFindings) ? reportData.unknownFindings : [];

  return {
    schema: "trimble-lab-check-report",
    schemaVersion: "1.0.0",
    ...buildSharedMetadata(projectContext, selectedFile, generatedAtIso),
    summary: reportData?.summary || {},
    checkBreakdown: reportData?.checkBreakdown || {},
    executionProfile: reportData?.executionProfile || {},
    checkExecutionOptions: checkExecutionOptions || null,
    findings: {
      product: productFindings,
      system: systemFindings,
      unknown: unknownFindings,
    },
  };
}

/*
Purpose:
Build future-facing BCF draft payload from checker issues so integration with
Trimble Connect BCF endpoints can be added without changing checker internals.

Logic:
Each issue row becomes one topic entry with simple priority mapping. This keeps
the draft deterministic and easy to transform into provider-specific payloads.

Parameters:
options (object) - BCF draft inputs
options.reportData (object | null) - checker result payload
options.projectContext (object | null) - project metadata
options.selectedFile (object | null) - selected file metadata
options.generatedAt (Date | string | number | null | undefined) - generation time
options.selectedIssueSelectors (Array<object> | null) - optional IFC GUID + severity filter list

Returns:
object - BCF draft payload

Possible side effects:
None
*/
export function buildBcfDraftPayload({
  reportData,
  projectContext,
  selectedFile,
  generatedAt,
  selectedIssueSelectors = null,
}) {
  const generatedAtIso = normalizeTimestampToIsoString(generatedAt);
  const selectedIssueLookup = buildSelectedIssueLookup(selectedIssueSelectors);
  const issueRows = collectIssueRowsFromReport(reportData, selectedIssueLookup);

  const topics = issueRows.map((issueRow, issueIndex) => {
    const priority = issueRow.severity === "error" ? "High" : "Medium";
    const topicId = `${issueRow.scope}-${issueIndex + 1}`;

    return {
      topicId,
      title: `${issueRow.scope.toUpperCase()} - ${issueRow.objectName}`,
      description: issueRow.message,
      priority,
      status: "Open",
      labels: [issueRow.scope, issueRow.severity],
      referenceObject: {
        ifcGuid: issueRow.globalId,
        ifcEntity: issueRow.ifcEntity,
        expressId: issueRow.expressId,
      },
      relatedProperty: {
        group: issueRow.propertyGroup,
        label: issueRow.propertyLabel,
      },
    };
  });

  const errorTopics = topics.filter((topic) => topic.labels.includes("error")).length;
  const warningTopics = topics.filter((topic) => topic.labels.includes("warning")).length;

  return {
    schema: "trimble-lab-bcf-draft",
    schemaVersion: "0.1.0",
    ...buildSharedMetadata(projectContext, selectedFile, generatedAtIso),
    note: "BCF draft export. Upload integration to Trimble Connect can map these topics to official BCF API payloads.",
    statistics: {
      totalTopics: topics.length,
      errorTopics,
      warningTopics,
    },
    topics,
  };
}

/*
Purpose:
Trigger JSON file download in browser so users can save report artifacts
directly from extension UI without server-side roundtrip.

Parameters:
fileName (string) - download file name
payload (object) - JSON-serializable payload

Returns:
void

Possible side effects:
- Creates temporary Blob URL.
- Programmatically clicks hidden anchor element.
*/
export function triggerJsonFileDownload(fileName, payload) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("JSON download is only available in browser runtime.");
  }

  const rawFileName = String(fileName || "").trim();
  const rawBaseName = rawFileName.toLowerCase().endsWith(".json") ? rawFileName.slice(0, -5) : rawFileName;
  const normalizedFileName = `${sanitizeFileNameSegment(rawBaseName, "export")}.json`;
  const serializedPayload = `${JSON.stringify(payload, null, 2)}\n`;
  const payloadBlob = new Blob([serializedPayload], {
    type: "application/json;charset=utf-8",
  });

  const objectUrl = URL.createObjectURL(payloadBlob);
  const downloadAnchor = document.createElement("a");
  downloadAnchor.href = objectUrl;
  downloadAnchor.download = normalizedFileName;
  downloadAnchor.style.display = "none";

  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);
}
