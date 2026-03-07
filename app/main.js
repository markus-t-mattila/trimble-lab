/*
Purpose:
Provide a legacy-compatible bootstrap module for the checker runtime that can
still be used during transition/debug scenarios, while the default hosted
extension entry point uses `app/projectFileIndex.js`.

Logic:
- Mirrors core checker orchestration helpers used by the active runtime.
- Preserved to avoid abrupt breakage in older references and smoke tests that
  still assert the file presence.

Parameters:
None

Returns:
None (module side-effect entry point)

Possible side effects:
- Registers UI event listeners.
- Updates DOM state and runtime caches.
*/

import { runModelChecks } from "./checker/checkerEngine.js";
import { getInitializedWebIfcRuntime, parseIfcModelForChecking, verifyIfcModelReadable } from "./checker/webIfcModelParser.js";
import { WEB_IFC_VERSION } from "./config/webIfcRuntime.js";
import { loadOriginalRuleDataset } from "./checker/rules/originalRuleDatasetLoader.js";
import {
  WORKSPACE_EVENT_ACCESS_TOKEN,
  WORKSPACE_EVENT_EXTENSION_COMMAND,
  WORKSPACE_EVENT_FILE_SELECTED,
  WORKSPACE_EVENT_FILE_VIEW_CLICKED,
} from "./config/workspaceEvents.js";
import {
  downloadSelectedIfcAsArrayBuffer,
  isIfcFileSelection,
  normalizeSelectedFile,
} from "./workspace/trimbleFileService.js";
import {
  connectWorkspaceApi,
  getCurrentProject,
  registerMainMenu,
  requestAccessTokenPermission,
  setExtensionStatusMessage,
} from "./workspace/workspaceClient.js";
import { clearRenderedReport, renderReportFindings, renderReportSummary } from "./ui/reportView.js";
import { renderSelectedFile, renderStatus } from "./ui/statusView.js";

const ui = {
  status: document.getElementById("status"),
  selectedFileName: document.getElementById("selected-file-name"),
  selectedFileSource: document.getElementById("selected-file-source"),
  checkerRuntimeVersion: document.getElementById("checker-runtime-version"),
  selectIfcButton: document.getElementById("select-ifc-button"),
  runCheckButton: document.getElementById("run-check-button"),
  clearReportButton: document.getElementById("clear-report-button"),
  reportSummary: document.getElementById("report-summary"),
  reportList: document.getElementById("report-list"),
  phaseCaption: document.getElementById("phase-caption"),
  phaseSteps: Array.from(document.querySelectorAll("[data-phase-step]")),
  ifcPickerModal: document.getElementById("ifc-picker-modal"),
  ifcPickerStatus: document.getElementById("ifc-picker-status"),
  ifcPickerList: document.getElementById("ifc-picker-list"),
  ifcPickerSelection: document.getElementById("ifc-picker-selection"),
  confirmIfcPickerButton: document.getElementById("confirm-ifc-picker-button"),
  cancelIfcPickerButton: document.getElementById("cancel-ifc-picker-button"),
  closeIfcPickerButton: document.getElementById("close-ifc-picker-button"),
};

const runtimeState = {
  workspaceApi: null,
  accessToken: null,
  accessTokenWaiters: new Set(),
  currentProjectId: "",
  currentProjectName: "",
  embeddedViewerApi: null,
  embeddedViewerFrame: null,
  embeddedViewerInitPromise: null,
  projectIfcFiles: [],
  projectIfcFilesLoadedProjectId: "",
  projectIfcFilesLoadPromise: null,
  projectIfcFilesLoadError: "",
  pickerSelectedIfcFile: null,
  preloadedIfcModel: null,
  selectedIfcFile: null,
  isRunningCheck: false,
  originalRuleDataset: null,
};

const WORKFLOW_STEP_SEQUENCE = ["connect", "select", "process", "report"];
const WORKFLOW_STEP_CAPTIONS = {
  connect: "Step: Connection",
  select: "Step: Model Selection",
  process: "Step: Validation Running",
  report: "Step: Report",
};

/*
Purpose:
Render workflow step highlight so user can immediately see which part of the
checking flow is active and which parts have already been completed.

Parameters:
activeStep (string) - one of: connect, select, process, report

Returns:
void

Possible side effects:
- Mutates workflow step classes and caption text.
*/
function setWorkflowStep(activeStep) {
  if (!ui.phaseSteps || ui.phaseSteps.length === 0) {
    return;
  }

  const activeStepIndex = WORKFLOW_STEP_SEQUENCE.indexOf(activeStep);
  if (activeStepIndex === -1) {
    return;
  }

  ui.phaseSteps.forEach((stepElement) => {
    const stepKey = stepElement.getAttribute("data-phase-step");
    const stepIndex = WORKFLOW_STEP_SEQUENCE.indexOf(stepKey);
    const isComplete = stepIndex !== -1 && stepIndex < activeStepIndex;
    const isActive = stepIndex === activeStepIndex;

    stepElement.classList.toggle("is-complete", isComplete);
    stepElement.classList.toggle("is-active", isActive);
  });

  if (ui.phaseCaption) {
    ui.phaseCaption.textContent = WORKFLOW_STEP_CAPTIONS[activeStep] || WORKFLOW_STEP_CAPTIONS.connect;
  }
}

/*
Purpose:
Update status banner and workflow step in a single call so textual and visual
state remain synchronized during asynchronous checker operations.

Parameters:
message (string) - user-visible status line
severity ("info" | "success" | "warning" | "error") - status banner style
workflowStep (string) - active workflow step key

Returns:
void

Possible side effects:
- Updates status banner text/style.
- Updates workflow step indicator.
*/
function renderAppState(message, severity, workflowStep) {
  renderStatus(ui.status, message, severity);
  setWorkflowStep(workflowStep);
}

/*
Purpose:
Lock or unlock secondary action controls while heavy processing is running.

Logic:
During check execution we disable model switching and report clearing to avoid
mid-run UI state races and accidental user actions.

Parameters:
isBusy (boolean) - true to lock controls, false to unlock

Returns:
void

Possible side effects:
- Mutates disabled state of select and clear buttons.
*/
function setActionControlsBusy(isBusy) {
  if (ui.selectIfcButton) {
    ui.selectIfcButton.disabled = isBusy;
  }

  if (ui.clearReportButton) {
    ui.clearReportButton.disabled = isBusy;
  }
}

/*
Purpose:
Create one stable cache key for selected IFC file so preloaded ArrayBuffer can
be reused only for the exact same file and link combination.

Parameters:
fileDescriptor (object | null) - normalized selected file object

Returns:
string - deterministic key, empty string when descriptor is invalid

Possible side effects:
None
*/
function buildSelectedFileCacheKey(fileDescriptor) {
  if (!fileDescriptor || typeof fileDescriptor !== "object") {
    return "";
  }

  const fileId = typeof fileDescriptor.id === "string" ? fileDescriptor.id : "";
  const fileVersionId = typeof fileDescriptor.versionId === "string" ? fileDescriptor.versionId : "";
  const fileName = typeof fileDescriptor.name === "string" ? fileDescriptor.name : "";
  const fileLink = typeof fileDescriptor.link === "string" ? fileDescriptor.link : "";

  return `${fileId}::${fileVersionId}::${fileName}::${fileLink}`;
}

/*
Purpose:
Keep preloaded IFC cache aligned with the currently selected model.

Logic:
When selection changes to another file, previous preloaded bytes must be
discarded so checker never uses stale model content by mistake.

Parameters:
nextSelectedFile (object | null) - incoming selected file candidate

Returns:
void

Possible side effects:
- Clears cached IFC bytes when selected file changes.
*/
function invalidatePreloadedModelIfSelectionChanged(nextSelectedFile) {
  const nextFileKey = buildSelectedFileCacheKey(nextSelectedFile);
  const cachedFileKey = runtimeState.preloadedIfcModel?.fileKey || "";

  if (!nextFileKey || !cachedFileKey || nextFileKey === cachedFileKey) {
    return;
  }

  runtimeState.preloadedIfcModel = null;
}

/*
Purpose:
Update run button state based on current selection and execution state.

Logic:
The check can run only when:
- no check is currently running
- selected file exists
- selected file resolves as IFC by name or file-type hint

Parameters:
None

Returns:
void

Possible side effects:
- Mutates run button disabled state.
*/
function updateRunButtonState() {
  const hasRunnableIfc = runtimeState.selectedIfcFile && isIfcFileSelection(runtimeState.selectedIfcFile);
  const runButtonEnabled = !runtimeState.isRunningCheck && hasRunnableIfc;
  ui.runCheckButton.disabled = !runButtonEnabled;

  if (ui.runCheckButton) {
    ui.runCheckButton.classList.toggle("primary-button", runButtonEnabled);
    ui.runCheckButton.classList.toggle("secondary-button", !runButtonEnabled);
  }
}

/*
Purpose:
Open the IFC picker modal and lock background interaction while file discovery
is in progress.

Parameters:
None

Returns:
void

Possible side effects:
- Toggles modal visibility classes.
*/
function openIfcPickerModal() {
  if (!ui.ifcPickerModal) {
    return;
  }

  ui.ifcPickerModal.classList.remove("hidden");
}

/*
Purpose:
Close the IFC picker modal and return focus to the main action button to keep
keyboard flow predictable after one file has been selected.

Parameters:
None

Returns:
void

Possible side effects:
- Toggles modal visibility classes.
- Moves focus to the picker trigger button.
*/
function closeIfcPickerModal() {
  if (!ui.ifcPickerModal) {
    return;
  }

  ui.ifcPickerModal.classList.add("hidden");
  resetPickerSelection();
  ui.selectIfcButton?.focus();
}

/*
Purpose:
Render staged picker selection and toggle confirmation button state.

Logic:
File selection in embedded explorer is staged first, then committed by explicit
OK action so user flow is predictable and matches expected modal behavior.

Parameters:
selectedFile (object | null) - staged IFC file selection

Returns:
void

Possible side effects:
- Updates modal footer selection text.
- Enables or disables picker OK button.
*/
function renderPickerSelectionState(selectedFile) {
  if (ui.ifcPickerSelection) {
    ui.ifcPickerSelection.textContent = selectedFile?.name
      ? `Selected: ${selectedFile.name}`
      : "No IFC model selected.";
  }

  if (ui.confirmIfcPickerButton) {
    ui.confirmIfcPickerButton.disabled = !selectedFile;
  }
}

/*
Purpose:
Reset staged picker selection each time modal opens or gets closed.

Parameters:
None

Returns:
void

Possible side effects:
- Clears staged file in runtime state.
- Resets modal footer selection UI.
*/
function resetPickerSelection() {
  runtimeState.pickerSelectedIfcFile = null;
  renderPickerSelectionState(null);
}

/*
Purpose:
Normalize access token payload shape from Workspace API so downstream code can
always rely on one plain string value.

Logic:
- Accept direct token string payload.
- Accept common object payload shapes (`accessToken`, `token`, nested `data`).
- Return null for unsupported or empty values.

Parameters:
tokenPayload (unknown) - value from permission response or event payload

Returns:
string | null - normalized non-empty token or null when unavailable

Possible side effects:
None
*/
function normalizeAccessTokenValue(tokenPayload) {
  if (typeof tokenPayload === "string" && tokenPayload.trim() !== "") {
    return tokenPayload;
  }

  if (!tokenPayload || typeof tokenPayload !== "object") {
    return null;
  }

  const objectPayload = tokenPayload;
  const candidateValues = [objectPayload.accessToken, objectPayload.token, objectPayload.data];
  const firstStringCandidate = candidateValues.find(
    (candidateValue) => typeof candidateValue === "string" && candidateValue.trim() !== "",
  );

  return firstStringCandidate || null;
}

/*
Purpose:
Pick first usable identifier from prioritized candidate list so embedded file
payload variations can still provide stable file/version ids.

Parameters:
candidates (unknown[]) - id candidates in priority order

Returns:
string | null - first non-empty normalized id

Possible side effects:
None
*/
function pickFirstIdentifier(candidates) {
  if (!Array.isArray(candidates)) {
    return null;
  }

  for (const candidateValue of candidates) {
    if (candidateValue === null || candidateValue === undefined) {
      continue;
    }

    const normalizedValue = String(candidateValue).trim();
    if (normalizedValue !== "") {
      return normalizedValue;
    }
  }

  return null;
}

/*
Purpose:
Resolve identifier value from URL query parameters with case-insensitive key
matching to tolerate payload shape differences.

Parameters:
urlCandidate (string) - URL that may include id/version query params
parameterNames (string[]) - accepted query key names

Returns:
string | null - matched query value

Possible side effects:
None
*/
function readIdentifierFromUrlQuery(urlCandidate, parameterNames) {
  if (typeof urlCandidate !== "string" || urlCandidate.trim() === "") {
    return null;
  }

  if (!Array.isArray(parameterNames) || parameterNames.length === 0) {
    return null;
  }

  try {
    const parsedUrl = new URL(urlCandidate, window.location.origin);

    for (const parameterName of parameterNames) {
      const normalizedParameterName = String(parameterName || "").toLowerCase();
      if (!normalizedParameterName) {
        continue;
      }

      for (const [queryKey, queryValue] of parsedUrl.searchParams.entries()) {
        if (String(queryKey).toLowerCase() !== normalizedParameterName) {
          continue;
        }

        const normalizedQueryValue = String(queryValue || "").trim();
        if (normalizedQueryValue !== "") {
          return normalizedQueryValue;
        }
      }
    }
  } catch (urlError) {
    return null;
  }

  return null;
}

/*
Purpose:
Convert timestamp-like value into compact user-visible date string for picker
table metadata while tolerating invalid or missing values.

Parameters:
timestampCandidate (string | number | null | undefined) - source timestamp

Returns:
string - formatted local timestamp or fallback dash

Possible side effects:
None
*/
function formatPickerTimestamp(timestampCandidate) {
  if (timestampCandidate === null || timestampCandidate === undefined || timestampCandidate === "") {
    return "-";
  }

  const parsedDate = new Date(timestampCandidate);
  if (Number.isNaN(parsedDate.getTime())) {
    return String(timestampCandidate);
  }

  return parsedDate.toLocaleString();
}

/*
Purpose:
Check whether two normalized file descriptors point to the same underlying IFC
file so picker selection and row highlighting stay consistent.

Parameters:
leftFile (object | null) - first file candidate
rightFile (object | null) - second file candidate

Returns:
boolean - true when files are equivalent

Possible side effects:
None
*/
function isSameIfcFile(leftFile, rightFile) {
  if (!leftFile || !rightFile) {
    return false;
  }

  if (leftFile.id && rightFile.id) {
    const leftVersionId = leftFile.versionId || "";
    const rightVersionId = rightFile.versionId || "";
    return leftFile.id === rightFile.id && leftVersionId === rightVersionId;
  }

  return leftFile.name === rightFile.name && (leftFile.link || "") === (rightFile.link || "");
}

/*
Purpose:
Map one viewer model object into normalized IFC file descriptor used by picker
table and download/check workflows.

Parameters:
viewerModel (object) - one model entry returned by Viewer API

Returns:
object - normalized file descriptor with metadata hints

Possible side effects:
None
*/
function normalizeViewerModelAsIfcFile(viewerModel) {
  const candidateLink = pickFirstIdentifier([
    viewerModel?.downloadUrl,
    viewerModel?.url,
    viewerModel?.href,
    viewerModel?.self,
    viewerModel?.link,
    viewerModel?.sourceUrl,
  ]) || "";

  const normalizedFileId = pickFirstIdentifier([
    viewerModel?.id,
    viewerModel?.modelId,
    viewerModel?.fileId,
    viewerModel?.sourceFileId,
    viewerModel?.documentId,
    readIdentifierFromUrlQuery(candidateLink, ["fileId", "modelId", "id", "sourceId"]),
  ]);

  const normalizedVersionId = pickFirstIdentifier([
    viewerModel?.versionId,
    viewerModel?.fileVersionId,
    viewerModel?.latestVersionId,
    viewerModel?.version,
    readIdentifierFromUrlQuery(candidateLink, ["versionId", "modelVersionId", "latestVersionId"]),
  ]);

  return {
    id: normalizedFileId,
    versionId: normalizedVersionId,
    name:
      pickFirstIdentifier([viewerModel?.name, viewerModel?.fileName, viewerModel?.displayName, viewerModel?.title]) ||
      "Unnamed model",
    link: candidateLink,
    type: pickFirstIdentifier([viewerModel?.type, viewerModel?.itemType]) || "FILE",
    fileType:
      pickFirstIdentifier([
        viewerModel?.fileType,
        viewerModel?.mimeType,
        viewerModel?.format,
        viewerModel?.extension,
        viewerModel?.runtimeType,
      ]) || "",
    modifiedAt: pickFirstIdentifier([
      viewerModel?.modifiedOn,
      viewerModel?.modifiedAt,
      viewerModel?.updatedAt,
      viewerModel?.updatedOn,
      viewerModel?.createdAt,
      viewerModel?.createdOn,
    ]),
    source: "Project IFC catalog",
  };
}

/*
Purpose:
Render project IFC catalog as an application-owned table so model selection does
not depend on Trimble embedded file explorer UI.

Parameters:
ifcFiles (Array<object>) - normalized IFC file list

Returns:
void

Possible side effects:
- Replaces picker list content.
- Attaches row/radio event handlers.
*/
function renderProjectIfcFileTable(ifcFiles) {
  if (!ui.ifcPickerList) {
    return;
  }

  ui.ifcPickerList.innerHTML = "";

  if (!Array.isArray(ifcFiles) || ifcFiles.length === 0) {
    ui.ifcPickerList.innerHTML = `
      <div class="empty-state">No IFC files were found in the current project.</div>
    `;
    return;
  }

  const pickerTable = document.createElement("table");
  pickerTable.className = "modal-picker-table";
  pickerTable.setAttribute("role", "grid");
  pickerTable.setAttribute("aria-label", "Project IFC file list");

  const tableHead = document.createElement("thead");
  tableHead.innerHTML = `
    <tr>
      <th scope="col">Select</th>
      <th scope="col">Name</th>
      <th scope="col">Last Modified</th>
      <th scope="col">Version</th>
    </tr>
  `;
  pickerTable.appendChild(tableHead);

  const tableBody = document.createElement("tbody");
  ifcFiles.forEach((ifcFile, fileIndex) => {
    const tableRow = document.createElement("tr");
    tableRow.className = "modal-picker-row";
    tableRow.dataset.fileIndex = String(fileIndex);

    const selectCell = document.createElement("td");
    selectCell.className = "modal-picker-cell-select";
    const selectInput = document.createElement("input");
    selectInput.type = "radio";
    selectInput.name = "ifc-picker-selection";
    selectInput.value = String(fileIndex);
    selectInput.setAttribute("aria-label", `Select model ${ifcFile.name}`);
    selectInput.checked = isSameIfcFile(runtimeState.pickerSelectedIfcFile, ifcFile);

    selectInput.addEventListener("change", () => {
      runtimeState.pickerSelectedIfcFile = ifcFile;
      renderPickerSelectionState(ifcFile);
      renderAppState(`Model selected: ${ifcFile.name}. Confirm with OK.`, "info", "select");
    });

    selectCell.appendChild(selectInput);
    tableRow.appendChild(selectCell);

    const nameCell = document.createElement("td");
    nameCell.textContent = ifcFile.name;
    tableRow.appendChild(nameCell);

    const modifiedCell = document.createElement("td");
    modifiedCell.textContent = formatPickerTimestamp(ifcFile.modifiedAt);
    tableRow.appendChild(modifiedCell);

    const versionCell = document.createElement("td");
    versionCell.textContent = ifcFile.versionId || "-";
    tableRow.appendChild(versionCell);

    tableRow.addEventListener("click", () => {
      if (selectInput.checked) {
        return;
      }

      selectInput.checked = true;
      selectInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    tableBody.appendChild(tableRow);
  });

  pickerTable.appendChild(tableBody);
  ui.ifcPickerList.appendChild(pickerTable);
}

/*
Purpose:
Load project model catalog through hidden embedded viewer and extract IFC files
for custom picker table rendering.

Parameters:
forceReload (boolean) - true to bypass cached result

Returns:
Promise<Array<object>> - normalized IFC file descriptors

Possible side effects:
- Initializes hidden embedded viewer.
- Caches resolved IFC file list in runtime state.
*/
async function loadProjectIfcFiles(forceReload = false) {
  const hasCachedProjectFiles =
    !forceReload &&
    runtimeState.projectIfcFilesLoadedProjectId === runtimeState.currentProjectId &&
    !runtimeState.projectIfcFilesLoadError;

  if (hasCachedProjectFiles) {
    return runtimeState.projectIfcFiles;
  }

  if (runtimeState.projectIfcFilesLoadPromise) {
    return runtimeState.projectIfcFilesLoadPromise;
  }

  runtimeState.projectIfcFilesLoadPromise = (async () => {
    if (!runtimeState.currentProjectId) {
      throw new Error("Current project id was missing, so IFC catalog could not be loaded.");
    }

    const accessToken = await ensureAccessTokenForProjectBrowsing();
    const embeddedViewerApi = await ensureEmbeddedViewer(accessToken, null, null);
    if (!embeddedViewerApi?.viewer || typeof embeddedViewerApi.viewer.getModels !== "function") {
      throw new Error("Viewer API did not expose model listing capability.");
    }

    const viewerModels = await embeddedViewerApi.viewer.getModels();
    if (!Array.isArray(viewerModels)) {
      throw new Error("Viewer API returned unexpected model list payload.");
    }

    const seenIfcFileKeys = new Set();
    const normalizedIfcFiles = viewerModels
      .map((viewerModel) => normalizeViewerModelAsIfcFile(viewerModel))
      .filter((normalizedFile) => isIfcFileSelection(normalizedFile) && Boolean(normalizedFile.id))
      .filter((normalizedFile) => {
        const uniqueKey = `${normalizedFile.id}::${normalizedFile.versionId || ""}`;
        if (seenIfcFileKeys.has(uniqueKey)) {
          return false;
        }

        seenIfcFileKeys.add(uniqueKey);
        return true;
      })
      .sort((leftFile, rightFile) => leftFile.name.localeCompare(rightFile.name, undefined, { sensitivity: "base" }));

    runtimeState.projectIfcFiles = normalizedIfcFiles;
    runtimeState.projectIfcFilesLoadedProjectId = runtimeState.currentProjectId;
    runtimeState.projectIfcFilesLoadError = "";
    return normalizedIfcFiles;
  })();

  try {
    return await runtimeState.projectIfcFilesLoadPromise;
  } catch (error) {
    runtimeState.projectIfcFilesLoadError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    runtimeState.projectIfcFilesLoadPromise = null;
  }
}

/*
Purpose:
Start background IFC catalog loading so picker table is ready before user opens
the modal.

Parameters:
None

Returns:
void

Possible side effects:
- Triggers asynchronous hidden viewer initialization in background.
*/
function prefetchProjectIfcFilesInBackground() {
  loadProjectIfcFiles(false).catch(() => {
    // Keep background preload silent; modal open flow will surface errors when needed.
  });
}

/*
Purpose:
Resolve all pending token waiters once token data arrives through the Workspace
event channel.

Logic:
- Keep waiters in a Set so each asynchronous wait can be completed exactly once.
- Iterate and resolve all current waiters when a token is received.

Parameters:
accessToken (string | null) - latest token value from Workspace event or permission response

Returns:
void

Possible side effects:
- Resolves pending promises created by `waitForAccessTokenEvent`.
*/
function resolveAccessTokenWaiters(accessToken) {
  if (!accessToken || runtimeState.accessTokenWaiters.size === 0) {
    return;
  }

  runtimeState.accessTokenWaiters.forEach((resolveWaiter) => {
    resolveWaiter(accessToken);
  });
}

/*
Purpose:
Wait for asynchronous `extension.accessToken` event when permission request
does not immediately return token data.

Logic:
- Return immediately if token is already known.
- Register resolver into shared waiter Set.
- Reject after timeout to avoid hanging UI forever when permission is denied.

Parameters:
timeoutMilliseconds (number) - maximum wait duration for token event

Returns:
Promise<string> - resolved access token from Workspace event stream

Possible side effects:
- Allocates one timeout.
- Adds and removes resolver callbacks in runtime state.
*/
function waitForAccessTokenEvent(timeoutMilliseconds = 12000) {
  if (runtimeState.accessToken) {
    return Promise.resolve(runtimeState.accessToken);
  }

  return new Promise((resolve, reject) => {
    let isSettled = false;

    const resolveWaiter = (tokenValue) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      window.clearTimeout(timeoutId);
      runtimeState.accessTokenWaiters.delete(resolveWaiter);
      resolve(tokenValue);
    };

    const timeoutId = window.setTimeout(() => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      runtimeState.accessTokenWaiters.delete(resolveWaiter);
      reject(new Error("Access token event was not received in time."));
    }, timeoutMilliseconds);

    runtimeState.accessTokenWaiters.add(resolveWaiter);
  });
}

/*
Purpose:
Ensure access token exists before project file catalog/model loading is started.

Logic:
- Reuse existing token when already present.
- If missing, ask Workspace API permission once more to refresh token data.
- If permission response does not contain token directly, wait for
  `extension.accessToken` event and use that token.

Parameters:
None

Returns:
Promise<string> - access token

Possible side effects:
- May trigger permission prompt in Trimble Connect host.
*/
async function ensureAccessTokenForProjectBrowsing() {
  if (runtimeState.accessToken) {
    return runtimeState.accessToken;
  }

  const permissionResult = await requestAccessTokenPermission(runtimeState.workspaceApi);
  const permissionToken = normalizeAccessTokenValue(permissionResult?.data || permissionResult);
  runtimeState.accessToken = permissionToken || runtimeState.accessToken;
  resolveAccessTokenWaiters(runtimeState.accessToken);

  if (runtimeState.accessToken) {
    return runtimeState.accessToken;
  }

  try {
    runtimeState.accessToken = await waitForAccessTokenEvent(12000);
  } catch {
    throw new Error(
      "Access token was not available after permission request. Confirm that accesstoken permission was accepted in Trimble Connect.",
    );
  }

  return runtimeState.accessToken;
}

/*
Purpose:
Resolve embedded Connect URL used by iframe-based file explorer inside modal.

Parameters:
None

Returns:
string - embed URL for Trimble Connect component host

Possible side effects:
None
*/
function getConnectEmbedUrl() {
  if (
    window.TrimbleConnectWorkspace &&
    typeof window.TrimbleConnectWorkspace.getConnectEmbedUrl === "function"
  ) {
    return window.TrimbleConnectWorkspace.getConnectEmbedUrl();
  }

  return "https://web.connect.trimble.com/?isEmbedded=true";
}

/*
Purpose:
Pause async flow for a short duration during polling loops without blocking UI.

Parameters:
milliseconds (number) - delay duration

Returns:
Promise<void>

Possible side effects:
None
*/
function sleep(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/*
Purpose:
Normalize dynamic id-like value into non-empty string so viewer model id
matching can be performed reliably across mixed payload shapes.

Parameters:
candidateValue (unknown) - id-like value from viewer payload

Returns:
string - normalized string id or empty string when unusable

Possible side effects:
None
*/
function normalizeViewerId(candidateValue) {
  if (candidateValue === null || candidateValue === undefined) {
    return "";
  }

  const normalizedValue = String(candidateValue).trim();
  return normalizedValue !== "" ? normalizedValue : "";
}

/*
Purpose:
Decode base64 payload returned by Workspace API into binary ArrayBuffer.

Logic:
- Accept plain base64 string or data URL string.
- Convert decoded binary string into Uint8Array.

Parameters:
base64Payload (string) - base64 encoded file content

Returns:
ArrayBuffer - decoded binary data

Possible side effects:
None
*/
function decodeBase64ToArrayBuffer(base64Payload) {
  if (typeof base64Payload !== "string" || base64Payload.trim() === "") {
    throw new Error("Viewer payload did not contain base64 file data.");
  }

  const normalizedBase64 = base64Payload.includes(",") ? base64Payload.split(",").pop() : base64Payload;
  const binaryString = window.atob(normalizedBase64);
  const binaryLength = binaryString.length;
  const binaryBytes = new Uint8Array(binaryLength);

  for (let index = 0; index < binaryLength; index += 1) {
    binaryBytes[index] = binaryString.charCodeAt(index);
  }

  return binaryBytes.buffer;
}

/*
Purpose:
Normalize file payload returned by `viewer.getLoadedModel` into ArrayBuffer.

Logic:
- Prefer `Blob` conversion when payload is Blob.
- Support base64 string payload used by some host implementations.

Parameters:
loadedModelFile (object) - file payload from ViewerAPI

Returns:
Promise<ArrayBuffer> - normalized model bytes

Possible side effects:
None
*/
async function extractArrayBufferFromLoadedViewerModel(loadedModelFile) {
  const fileBlobPayload = loadedModelFile?.blob;
  if (!fileBlobPayload) {
    throw new Error("Viewer returned model metadata without file blob content.");
  }

  if (fileBlobPayload instanceof Blob) {
    return fileBlobPayload.arrayBuffer();
  }

  if (typeof fileBlobPayload === "string") {
    return decodeBase64ToArrayBuffer(fileBlobPayload);
  }

  throw new Error("Viewer model blob payload type was unsupported.");
}

/*
Purpose:
Wait until requested model has become available through viewer runtime API and
returns downloadable blob payload.

Logic:
- Poll `viewer.getLoadedModel(modelId)` while embed viewer initializes model.
- Stop with timeout to avoid endless wait when model cannot be loaded.

Parameters:
viewerApi (object) - connected Workspace API bound to embedded viewer
modelId (string) - selected model id
timeoutMilliseconds (number) - max wait duration
pollIntervalMilliseconds (number) - poll interval

Returns:
Promise<object> - loaded model payload containing blob data

Possible side effects:
- Repeatedly calls ViewerAPI methods during wait period.
*/
async function waitForLoadedModelBlob(
  viewerApi,
  modelId,
  timeoutMilliseconds = 45000,
  pollIntervalMilliseconds = 1200,
) {
  const startTimestamp = Date.now();

  while (Date.now() - startTimestamp < timeoutMilliseconds) {
    const modelIdCandidates = [];
    const seenModelIds = new Set();
    const pushModelIdCandidate = (candidateValue) => {
      const normalizedCandidate = normalizeViewerId(candidateValue);
      if (!normalizedCandidate || seenModelIds.has(normalizedCandidate)) {
        return;
      }

      seenModelIds.add(normalizedCandidate);
      modelIdCandidates.push(normalizedCandidate);
    };

    pushModelIdCandidate(modelId);

    try {
      if (typeof viewerApi.viewer.getModels === "function") {
        const availableModels = await viewerApi.viewer.getModels();
        if (Array.isArray(availableModels)) {
          const preferredModelIds = [];
          const secondaryModelIds = [];
          const requestedModelId = normalizeViewerId(modelId);

          availableModels.forEach((availableModel) => {
            if (!availableModel || typeof availableModel !== "object") {
              return;
            }

            const availableModelId = normalizeViewerId(availableModel.id || availableModel.modelId);
            if (!availableModelId) {
              return;
            }

            const comparableModelIdentifiers = [
              availableModel.fileId,
              availableModel.sourceFileId,
              availableModel.documentId,
              availableModel.versionId,
              availableModel.fileVersionId,
              availableModel.latestVersionId,
            ]
              .map((identifierValue) => normalizeViewerId(identifierValue))
              .filter(Boolean);

            if (requestedModelId && comparableModelIdentifiers.includes(requestedModelId)) {
              preferredModelIds.push(availableModelId);
            } else {
              secondaryModelIds.push(availableModelId);
            }
          });

          preferredModelIds.forEach((candidateId) => {
            pushModelIdCandidate(candidateId);
          });
          secondaryModelIds.forEach((candidateId) => {
            pushModelIdCandidate(candidateId);
          });
        }
      }
    } catch (error) {
      // Ignore model listing failures and continue with known id candidates.
    }

    for (const modelIdCandidate of modelIdCandidates) {
      try {
        const loadedModel = await viewerApi.viewer.getLoadedModel(modelIdCandidate);
        if (loadedModel?.blob) {
          return loadedModel;
        }
      } catch (error) {
        // Ignore transient errors while viewer model is still loading.
      }
    }

    try {
      const loadedModelWithoutId = await viewerApi.viewer.getLoadedModel();
      if (loadedModelWithoutId?.blob) {
        return loadedModelWithoutId;
      }
    } catch (error) {
      // Ignore signatures that require explicit model id argument.
    }

    await sleep(pollIntervalMilliseconds);
  }

  throw new Error(`Embedded viewer did not provide model blob within ${timeoutMilliseconds} ms.`);
}

/*
Purpose:
Handle hidden viewer callback channel without mutating user-visible selection
state, because hidden bridge iframe is used only for in-memory file retrieval.

Parameters:
None

Returns:
void

Possible side effects:
None
*/
function handleEmbeddedViewerEvent() {
  // Hidden bridge viewer events are intentionally ignored.
}

/*
Purpose:
Create or reuse hidden embedded 3D viewer so file bytes can be retrieved via
Workspace API bridge instead of cross-origin browser fetch requests.

Logic:
- Reuse connected hidden viewer iframe when available.
- Update access token and initialize viewer for selected project/model.

Parameters:
accessToken (string) - current user token
modelId (string | null) - selected model id
versionId (string | null) - selected model version id

Returns:
Promise<object> - connected viewer Workspace API instance

Possible side effects:
- Creates hidden iframe in document body.
- Calls `embed.init3DViewer` for selected project/model.
*/
async function ensureEmbeddedViewer(accessToken, modelId, versionId) {
  if (runtimeState.embeddedViewerApi && runtimeState.embeddedViewerFrame?.isConnected) {
    await runtimeState.embeddedViewerApi.embed.setTokens({ accessToken });
    await runtimeState.embeddedViewerApi.embed.init3DViewer({
      projectId: runtimeState.currentProjectId,
      modelId: modelId || undefined,
      versionId: versionId || undefined,
    });
    return runtimeState.embeddedViewerApi;
  }

  if (runtimeState.embeddedViewerInitPromise) {
    return runtimeState.embeddedViewerInitPromise;
  }

  runtimeState.embeddedViewerInitPromise = (async () => {
    const hiddenViewerFrame = document.createElement("iframe");
    hiddenViewerFrame.title = "Trimble Connect Hidden Viewer";
    hiddenViewerFrame.src = getConnectEmbedUrl();
    hiddenViewerFrame.setAttribute("aria-hidden", "true");
    hiddenViewerFrame.style.position = "absolute";
    hiddenViewerFrame.style.width = "0";
    hiddenViewerFrame.style.height = "0";
    hiddenViewerFrame.style.border = "0";
    hiddenViewerFrame.style.opacity = "0";
    hiddenViewerFrame.style.pointerEvents = "none";
    hiddenViewerFrame.style.left = "-9999px";
    hiddenViewerFrame.style.top = "-9999px";

    const loadPromise = new Promise((resolve, reject) => {
      hiddenViewerFrame.addEventListener("load", () => resolve(), { once: true });
      hiddenViewerFrame.addEventListener("error", () => reject(new Error("Hidden viewer iframe failed to load.")), {
        once: true,
      });
    });

    document.body.appendChild(hiddenViewerFrame);
    await loadPromise;

    let embeddedViewerApi = null;
    try {
      embeddedViewerApi = await window.TrimbleConnectWorkspace.connect(hiddenViewerFrame, handleEmbeddedViewerEvent, 30000);
    } catch (frameConnectError) {
      embeddedViewerApi = await window.TrimbleConnectWorkspace.connect(
        hiddenViewerFrame.contentWindow,
        handleEmbeddedViewerEvent,
        30000,
      );
    }

    await embeddedViewerApi.embed.setTokens({ accessToken });
    await embeddedViewerApi.embed.init3DViewer({
      projectId: runtimeState.currentProjectId,
      modelId: modelId || undefined,
      versionId: versionId || undefined,
    });

    runtimeState.embeddedViewerFrame = hiddenViewerFrame;
    runtimeState.embeddedViewerApi = embeddedViewerApi;
    return embeddedViewerApi;
  })();

  try {
    return await runtimeState.embeddedViewerInitPromise;
  } finally {
    runtimeState.embeddedViewerInitPromise = null;
  }
}

/*
Purpose:
Retrieve IFC bytes through embedded Trimble viewer bridge as CORS-safe fallback
when direct link download from extension origin is blocked.

Logic:
- Ensure access token exists.
- Ensure hidden viewer is initialized for selected model.
- Wait for `viewer.getLoadedModel` blob payload and normalize to ArrayBuffer.
- Validate payload with web-ifc readability check before returning.

Parameters:
selectedFile (object) - normalized selected IFC descriptor

Returns:
Promise<ArrayBuffer> - validated IFC bytes

Possible side effects:
- Loads selected model in hidden embedded viewer iframe.
*/
async function downloadIfcViaEmbeddedViewerBridge(selectedFile) {
  if (!selectedFile?.id) {
    throw new Error("Embedded viewer fallback requires selected file id.");
  }

  const accessToken = await ensureAccessTokenForProjectBrowsing();
  const embeddedViewerApi = await ensureEmbeddedViewer(accessToken, selectedFile.id, selectedFile.versionId || null);
  const loadedViewerModel = await waitForLoadedModelBlob(embeddedViewerApi, selectedFile.id);
  const modelArrayBuffer = await extractArrayBufferFromLoadedViewerModel(loadedViewerModel);
  try {
    await verifyIfcModelReadable(modelArrayBuffer);
  } catch (verificationError) {
    const viewerModelName = String(loadedViewerModel?.name || "").trim();
    const viewerModelType = String(loadedViewerModel?.type || loadedViewerModel?.runtimeType || "").trim();
    const viewerModelIdentity = [viewerModelName, viewerModelType].filter(Boolean).join(" / ");
    const viewerModelSuffix = viewerModelIdentity ? ` Viewer payload: ${viewerModelIdentity}.` : "";
    throw new Error(
      `Embedded viewer payload was not valid IFC content.${
        verificationError instanceof Error ? ` ${verificationError.message}` : ` ${String(verificationError)}`
      }${viewerModelSuffix}`,
    );
  }

  return modelArrayBuffer;
}

/*
Purpose:
Load IFC bytes into browser memory using best available strategy.

Logic:
1) Prefer embedded viewer bridge when file id is available, because this route
   uses host-internal loading and avoids cross-origin fetch issues.
2) If viewer bridge is unavailable or fails, try direct/Core API download flow.
3) Always verify payload readability before returning.

Parameters:
selectedFile (object) - normalized selected IFC descriptor
options (object) - loading behavior options
options.allowDirectFallback (boolean) - allow direct/Core API fallback when viewer bridge fails

Returns:
Promise<{ arrayBuffer: ArrayBuffer, source: string }>

Possible side effects:
- Executes network download and/or embedded viewer loading.
*/
async function loadIfcArrayBufferWithFallback(selectedFile, options = {}) {
  const allowDirectFallback = options.allowDirectFallback !== false;
  const accessToken = await ensureAccessTokenForProjectBrowsing();
  const canUseViewerBridge = Boolean(selectedFile?.id);

  if (canUseViewerBridge) {
    try {
      const viewerBuffer = await downloadIfcViaEmbeddedViewerBridge(selectedFile);
      return {
        arrayBuffer: viewerBuffer,
        source: "viewer-bridge",
      };
    } catch (viewerBridgeError) {
      if (!allowDirectFallback) {
        throw new Error(
          `Viewer bridge failed: ${
            viewerBridgeError instanceof Error ? viewerBridgeError.message : String(viewerBridgeError)
          }`,
        );
      }

      try {
        const directBuffer = await downloadSelectedIfcAsArrayBuffer(selectedFile, accessToken, runtimeState.currentProjectId);
        await verifyIfcModelReadable(directBuffer);
        return {
          arrayBuffer: directBuffer,
          source: "direct",
          viewerBridgeError,
        };
      } catch (directDownloadError) {
        throw new Error(
          `Viewer bridge failed: ${
            viewerBridgeError instanceof Error ? viewerBridgeError.message : String(viewerBridgeError)
          } | Direct download failed: ${
            directDownloadError instanceof Error ? directDownloadError.message : String(directDownloadError)
          }`,
        );
      }
    }
  }

  if (!allowDirectFallback) {
    throw new Error("Direct download fallback is disabled and selected model did not contain viewer-compatible id.");
  }

  const directBuffer = await downloadSelectedIfcAsArrayBuffer(selectedFile, accessToken, runtimeState.currentProjectId);
  await verifyIfcModelReadable(directBuffer);
  return {
    arrayBuffer: directBuffer,
    source: "direct",
  };
}

/*
Purpose:
Open IFC picker modal and present application-owned project IFC table that is
loaded in background through Viewer API.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Opens picker modal.
- Loads and renders project IFC file list.
*/
async function openProjectIfcPicker() {
  openIfcPickerModal();
  resetPickerSelection();

  if (ui.ifcPickerStatus) {
    ui.ifcPickerStatus.textContent = "Loading project IFC files...";
  }

  if (ui.ifcPickerList) {
    ui.ifcPickerList.innerHTML = `
      <div class="empty-state">Loading IFC file table...</div>
    `;
  }

  renderAppState("Opening model selection...", "info", "select");

  try {
    if (!runtimeState.currentProjectId) {
      throw new Error("Current project was not available. Refresh the view and try again.");
    }

    const projectIfcFiles = await loadProjectIfcFiles(false);
    const matchingSelectedFile = projectIfcFiles.find((ifcFile) => isSameIfcFile(ifcFile, runtimeState.selectedIfcFile));
    if (matchingSelectedFile) {
      runtimeState.pickerSelectedIfcFile = matchingSelectedFile;
      renderPickerSelectionState(matchingSelectedFile);
    }

    renderProjectIfcFileTable(projectIfcFiles);

    if (ui.ifcPickerStatus) {
      ui.ifcPickerStatus.textContent =
        projectIfcFiles.length > 0
          ? "Select one IFC file from the table and confirm with OK."
          : "No IFC files were found in the current project.";
    }
  } catch (error) {
    if (ui.ifcPickerStatus) {
      ui.ifcPickerStatus.textContent = "Project IFC file listing failed.";
    }

    if (ui.ifcPickerList) {
      ui.ifcPickerList.innerHTML = `
        <div class="empty-state">${error instanceof Error ? error.message : String(error)}</div>
      `;
    }
  }
}

/*
Purpose:
Commit staged IFC picker selection, preload selected file bytes into browser
memory, and prepare checker state for the next "run check" step.

Logic:
1) Require staged selection from application-owned IFC table.
2) Download IFC bytes immediately so file is ready for check execution.
3) Store downloaded bytes in runtime cache keyed by selected file.
4) Promote selection into active checker file state and close modal.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Executes IFC download request.
- Writes preloaded IFC bytes into runtime cache.
- Updates selected model UI and status.
*/
async function confirmPickerSelection() {
  const stagedSelection = runtimeState.pickerSelectedIfcFile;
  if (!stagedSelection) {
    renderAppState("Select an IFC model before confirming.", "warning", "select");
    return;
  }

  const currentSelectedFile = runtimeState.selectedIfcFile;
  const sameFileAsCurrentSelection =
    currentSelectedFile &&
    ((stagedSelection.id && currentSelectedFile.id === stagedSelection.id) ||
      (!stagedSelection.id && currentSelectedFile.name === stagedSelection.name));

  const committedSelection = {
    ...stagedSelection,
    link: stagedSelection.link || (sameFileAsCurrentSelection ? currentSelectedFile.link : ""),
    source: stagedSelection.source || (sameFileAsCurrentSelection ? currentSelectedFile.source : "Modal / IFC table"),
    versionId: stagedSelection.versionId || (sameFileAsCurrentSelection ? currentSelectedFile.versionId : null),
  };

  if (!committedSelection.id) {
    renderAppState(
      "Selected model does not contain a valid file id. Select another IFC file from the table.",
      "warning",
      "select",
    );
    return;
  }

  try {
    if (ui.confirmIfcPickerButton) {
      ui.confirmIfcPickerButton.disabled = true;
      ui.confirmIfcPickerButton.textContent = "Loading...";
    }

    renderAppState(`Loading selected model into browser memory: ${committedSelection.name}`, "info", "select");
    const loadedModel = await loadIfcArrayBufferWithFallback(committedSelection, {
      allowDirectFallback: false,
    });
    const modelBytes = loadedModel.arrayBuffer;
    const fileKey = buildSelectedFileCacheKey(committedSelection);

    runtimeState.preloadedIfcModel = {
      fileKey,
      arrayBuffer: modelBytes,
    };

    runtimeState.selectedIfcFile = committedSelection;
    renderSelectedFile(ui.selectedFileName, ui.selectedFileSource, committedSelection.name, committedSelection.source);
    const readyMessage =
      loadedModel.source === "viewer-bridge"
        ? `Model ready for validation (viewer bridge): ${committedSelection.name}`
        : `Model ready for validation: ${committedSelection.name}`;
    renderAppState(readyMessage, "success", "select");
    updateRunButtonState();
    closeIfcPickerModal();
  } catch (error) {
    renderAppState(
      `Model preload failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
      "select",
    );
  } finally {
    if (ui.confirmIfcPickerButton) {
      ui.confirmIfcPickerButton.textContent = "OK";
      ui.confirmIfcPickerButton.disabled = !runtimeState.pickerSelectedIfcFile;
    }
  }
}

/*
Purpose:
Execute one full checker run for currently selected IFC file.

Logic:
1) Reuse preloaded IFC bytes when available, otherwise load selected model.
2) Parse model through web-ifc runtime.
3) Run configurable rule set against parsed objects.
4) Render summary + findings report.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Performs network download.
- Runs CPU-heavy IFC parsing in browser.
- Updates report UI and status text.
*/
async function runSelectedIfcCheck() {
  if (!runtimeState.selectedIfcFile || !isIfcFileSelection(runtimeState.selectedIfcFile)) {
    renderAppState("Select an IFC model before running validation.", "warning", "select");
    return;
  }

  runtimeState.isRunningCheck = true;
  setActionControlsBusy(true);
  if (ui.runCheckButton) {
    ui.runCheckButton.textContent = "Validation running...";
  }
  updateRunButtonState();

  try {
    clearRenderedReport(ui.reportSummary, ui.reportList);
    const selectedFileKey = buildSelectedFileCacheKey(runtimeState.selectedIfcFile);
    const cachedModel = runtimeState.preloadedIfcModel;
    let ifcFileBuffer = null;

    if (cachedModel && cachedModel.fileKey === selectedFileKey && cachedModel.arrayBuffer) {
      ifcFileBuffer = cachedModel.arrayBuffer;
      renderAppState(`Using preloaded model: ${runtimeState.selectedIfcFile.name}`, "info", "process");
    } else {
      renderAppState(`Loading model: ${runtimeState.selectedIfcFile.name}`, "info", "process");
      const selectedFromProjectCatalog =
        runtimeState.selectedIfcFile.source === "Project IFC catalog" ||
        runtimeState.selectedIfcFile.source === "Modal / IFC table";

      const loadedModel = await loadIfcArrayBufferWithFallback(runtimeState.selectedIfcFile, {
        allowDirectFallback: !selectedFromProjectCatalog,
      });
      ifcFileBuffer = loadedModel.arrayBuffer;
      runtimeState.preloadedIfcModel = {
        fileKey: selectedFileKey,
        arrayBuffer: ifcFileBuffer,
      };
    }

    renderAppState("Reading IFC structure (web-ifc)...", "info", "process");
    const parsedModel = await parseIfcModelForChecking(ifcFileBuffer, runtimeState.originalRuleDataset);

    renderAppState("Running rule validation...", "info", "process");
    const checkReport = runModelChecks(parsedModel, runtimeState.originalRuleDataset);

    renderReportSummary(ui.reportSummary, checkReport.summary);
    renderReportFindings(ui.reportList, checkReport);

    const completionMessage =
      checkReport.summary.totalIssues > 0
        ? `Validation complete. Findings: ${checkReport.summary.totalIssues}.`
        : "Validation complete. No findings.";
    renderAppState(completionMessage, checkReport.summary.totalIssues > 0 ? "warning" : "success", "report");
  } catch (error) {
    renderAppState(`Validation failed: ${error instanceof Error ? error.message : String(error)}`, "error", "report");
  } finally {
    runtimeState.isRunningCheck = false;
    setActionControlsBusy(false);
    if (ui.runCheckButton) {
      ui.runCheckButton.textContent = "Run check";
    }
    updateRunButtonState();
  }
}

/*
Purpose:
Handle Trimble Workspace events and keep shell state synchronized.

Parameters:
eventName (string) - event identifier
args (object) - event payload

Returns:
Promise<void>

Possible side effects:
- Updates selection state, token state, status UI and button state.
*/
async function handleWorkspaceEvent(eventName, args) {
  if (eventName === WORKSPACE_EVENT_ACCESS_TOKEN) {
    runtimeState.accessToken = normalizeAccessTokenValue(args?.data) || null;
    resolveAccessTokenWaiters(runtimeState.accessToken);
    if (runtimeState.embeddedViewerApi && runtimeState.accessToken) {
      runtimeState.embeddedViewerApi.embed.setTokens({ accessToken: runtimeState.accessToken }).catch(() => {
        // Ignore token refresh failures here; hidden viewer will be re-initialized on demand.
      });
    }
    if (runtimeState.currentProjectId && runtimeState.projectIfcFilesLoadedProjectId !== runtimeState.currentProjectId) {
      prefetchProjectIfcFilesInBackground();
    }
    if (!runtimeState.selectedIfcFile) {
      renderAppState("Connection ready. Select model for validation.", "success", "select");
    }
    return;
  }

  if (eventName === WORKSPACE_EVENT_FILE_SELECTED || eventName === WORKSPACE_EVENT_FILE_VIEW_CLICKED) {
    const selectedFile = normalizeSelectedFile(args);
    if (!selectedFile) {
      renderAppState("No file metadata was found in selected event payload.", "warning", "select");
      return;
    }

    runtimeState.selectedIfcFile = selectedFile;
    invalidatePreloadedModelIfSelectionChanged(selectedFile);
    renderSelectedFile(ui.selectedFileName, ui.selectedFileSource, selectedFile.name, selectedFile.source || eventName);

    if (!isIfcFileSelection(selectedFile)) {
      renderAppState("Selected file is not IFC. Choose a .ifc file.", "warning", "select");
    } else {
      renderAppState(`Selected model: ${selectedFile.name}`, "success", "select");
    }

    updateRunButtonState();
    return;
  }

  if (eventName === WORKSPACE_EVENT_EXTENSION_COMMAND && args?.data === "main_clicked") {
    renderAppState("Application activated. Select model and run validation.", "info", "select");
  }
}

/*
Purpose:
Initialize Trimble connection, permissions and web-ifc runtime readiness.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Connects to Trimble Workspace API.
- Requests access token permission.
- Initializes web-ifc runtime.
*/
async function initializeApplication() {
  clearRenderedReport(ui.reportSummary, ui.reportList);
  if (ui.checkerRuntimeVersion) {
    ui.checkerRuntimeVersion.textContent = `web-ifc ${WEB_IFC_VERSION}`;
  }

  renderAppState("Connecting to Trimble Connect...", "info", "connect");
  runtimeState.workspaceApi = await connectWorkspaceApi(handleWorkspaceEvent);

  await registerMainMenu(runtimeState.workspaceApi);
  await setExtensionStatusMessage(runtimeState.workspaceApi, "IFC Checker extension active");

  const project = await getCurrentProject(runtimeState.workspaceApi);
  runtimeState.currentProjectId = project?.id || "";
  runtimeState.currentProjectName = project?.name || "Unknown project";

  try {
    const permissionResult = await requestAccessTokenPermission(runtimeState.workspaceApi);
    const permissionToken = normalizeAccessTokenValue(permissionResult?.data || permissionResult);
    runtimeState.accessToken = permissionToken || runtimeState.accessToken;
    resolveAccessTokenWaiters(runtimeState.accessToken);
    if (!runtimeState.accessToken) {
      try {
        runtimeState.accessToken = await waitForAccessTokenEvent(12000);
      } catch {
        runtimeState.accessToken = null;
      }
    }
  } catch (error) {
    runtimeState.accessToken = null;
  }

  renderAppState(`Connected to project: ${runtimeState.currentProjectName}`, "success", "select");

  renderAppState("Loading rule dataset...", "info", "select");
  runtimeState.originalRuleDataset = await loadOriginalRuleDataset();

  renderAppState("Initializing IFC runtime...", "info", "select");
  await getInitializedWebIfcRuntime();

  prefetchProjectIfcFilesInBackground();
  renderAppState("Ready. Select model and run validation.", "success", "select");

  updateRunButtonState();
}

ui.runCheckButton?.addEventListener("click", () => {
  runSelectedIfcCheck();
});

ui.selectIfcButton?.addEventListener("click", () => {
  openProjectIfcPicker();
});

ui.confirmIfcPickerButton?.addEventListener("click", () => {
  confirmPickerSelection();
});

ui.cancelIfcPickerButton?.addEventListener("click", () => {
  closeIfcPickerModal();
});

ui.clearReportButton?.addEventListener("click", () => {
  clearRenderedReport(ui.reportSummary, ui.reportList);
  renderAppState("Report cleared.", "info", "select");
});

ui.closeIfcPickerButton?.addEventListener("click", () => {
  closeIfcPickerModal();
});

ui.ifcPickerModal?.addEventListener("click", (event) => {
  if (event.target === ui.ifcPickerModal) {
    closeIfcPickerModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui.ifcPickerModal && !ui.ifcPickerModal.classList.contains("hidden")) {
    closeIfcPickerModal();
  }
});

resetPickerSelection();
updateRunButtonState();
initializeApplication().catch((error) => {
  renderAppState(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error", "connect");
});
