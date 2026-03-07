import { runModelChecks } from "./checker/checkerEngine.js";
import {
  getInitializedWebIfcRuntime,
  parseIfcModelForChecking,
  verifyIfcModelReadable,
} from "./checker/webIfcModelParser.js";
import { loadOriginalRuleDataset } from "./checker/rules/originalRuleDatasetLoader.js";
import {
  buildSelectedIssueRowsForBcfCreation,
  buildCheckerReportExportPayload,
  buildExportFileName,
  triggerJsonFileDownload,
} from "./reporting/reportExtensions.js";
import {
  clearRenderedReport,
  getSelectedBcfIssueSelectors,
  renderReportFindings,
  renderReportSummary,
} from "./ui/reportView.js";

const WORKSPACE_EVENT_ACCESS_TOKEN = "extension.accessToken";
const WORKSPACE_EVENT_EXTENSION_COMMAND = "extension.command";
const IFC_FILE_DOWNLOADED_EVENT = "ifc-file-downloaded";
const MAIN_MENU_COMMAND = "main_clicked";
const MAIN_MENU_TITLE = "IFC Checker";
const MAIN_MENU_ICON_URL = "https://www.tietomallintaja.fi/wp-content/uploads/2022/03/LOGO-Tekstilla-Musta-200-x-200.png";

const CORE_API_BASE_URL_STATIC_CANDIDATES = [
  "https://app.connect.trimble.com/tc/api/2.0",
  "https://app21.connect.trimble.com/tc/api/2.0",
  "https://app31.connect.trimble.com/tc/api/2.0",
  "https://app32.connect.trimble.com/tc/api/2.0",
];

const TOPICS_API_BASE_URL_STATIC_CANDIDATES = [
  "https://open11.connect.trimble.com",
  "https://open21.connect.trimble.com",
  "https://open31.connect.trimble.com",
  "https://open32.connect.trimble.com",
];

const TOPICS_API_MEDIA_TYPE_CONNECT = "application/vnd.trimble.connect.app+json";
const TOPICS_API_MEDIA_TYPE_CONNECT_LEGACY = "application/vnd.trimble.connect.app";
const TOPICS_API_MEDIA_TYPE_BCF = "application/json";
const IFC_CHECKER_TOPIC_LABEL = "IFC-checker";
const DEFAULT_BCF_LENGTH_UNIT_TO_METERS = 0.001;

const ui = {
  status: document.getElementById("status"),
  fileBrowserSection: document.getElementById("file-browser-section"),
  projectName: document.getElementById("project-name"),
  projectId: document.getElementById("project-id"),
  fileCount: document.getElementById("file-count"),
  fileTableBody: document.getElementById("file-table-body"),
  refreshButton: document.getElementById("refresh-button"),
  selectedFileSummary: document.getElementById("selected-file-summary"),
  downloadSelectedButton: document.getElementById("download-selected-button"),
  editCheckSettingsButton: document.getElementById("edit-check-settings-button"),
  clearModelButton: document.getElementById("clear-model-button"),
  downloadReportButton: document.getElementById("download-report-button"),
  exportBcfDraftButton: document.getElementById("export-bcf-draft-button"),
  reportSummary: document.getElementById("report-summary"),
  reportList: document.getElementById("report-list"),
  checkSelectionModal: document.getElementById("check-selection-modal"),
  checkSelectionDialog: document.querySelector(".check-selection-dialog"),
  checkSelectionContent: document.getElementById("check-selection-content"),
  checkSelectionCloseButton: document.getElementById("check-selection-close-button"),
  checkSelectionCancelButton: document.getElementById("check-selection-cancel-button"),
  checkSelectionConfirmButton: document.getElementById("check-selection-confirm-button"),
  checkSelectionEnableAllButton: document.getElementById("check-selection-enable-all-button"),
  checkSelectionDisableAllButton: document.getElementById("check-selection-disable-all-button"),
  checkSelectionDefaultsButton: document.getElementById("check-selection-defaults-button"),
  bcfCreateModal: document.getElementById("bcf-create-modal"),
  bcfCreateDialog: document.querySelector(".bcf-create-dialog"),
  bcfCreateTitle: document.getElementById("bcf-create-title"),
  bcfCreateSubtitle: document.getElementById("bcf-create-subtitle"),
  bcfCreateMessage: document.getElementById("bcf-create-message"),
  bcfCreateContent: document.getElementById("bcf-create-content"),
  bcfCreateCloseButton: document.getElementById("bcf-create-close-button"),
  bcfCreateCancelButton: document.getElementById("bcf-create-cancel-button"),
  bcfCreateConfirmButton: document.getElementById("bcf-create-confirm-button"),
};

const runtimeState = {
  workspaceApi: null,
  hasRegisteredMainMenu: false,
  accessToken: null,
  accessTokenWaiters: new Set(),
  currentProjectId: "",
  currentProjectName: "",
  isLoadingFiles: false,
  isDownloadingSelectedFile: false,
  isRunningCheck: false,
  selectedFileRowKey: "",
  selectedFileEntry: null,
  latestIfcFileEntries: [],
  activeCoreApiBaseUrl: "",
  downloadedIfcFile: null,
  latestCheckResult: null,
  originalRuleDataset: null,
  checkExecutionOptions: null,
  isCreatingBcfTopics: false,
};

/*
Purpose:
Keep one explicit string validation helper so id, name, and URL checks
follow the same rule everywhere in this file.

Logic:
A value is considered usable text only when it is a string and has at least
one non-whitespace character after trimming.

Parameters:
value (unknown) - candidate value that might contain text

Returns:
boolean - true when value is a non-empty string

Possible side effects:
None
*/
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/*
Purpose:
Pick the first non-empty string from a prioritized candidate list so payload
shape differences do not break id and name extraction.

Logic:
The function loops through candidates in order and returns the first value
that becomes a non-empty string after normalization.

Parameters:
candidates (unknown[]) - candidate values in priority order

Returns:
string - first usable value or empty string when none are usable

Possible side effects:
None
*/
function pickFirstNonEmptyString(candidates) {
  if (!Array.isArray(candidates)) {
    return "";
  }

  for (const candidateValue of candidates) {
    if (candidateValue === null || candidateValue === undefined) {
      continue;
    }

    const normalizedCandidate = String(candidateValue).trim();
    if (normalizedCandidate !== "") {
      return normalizedCandidate;
    }
  }

  return "";
}

/*
Purpose:
Escape plain text into HTML-safe output for modal templates that render labels
directly from rule dataset content.

Parameters:
unsafeText (unknown) - text candidate that may contain HTML-reserved characters

Returns:
string - escaped text

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
Create one safe deep copy for check-execution options so modal edits can be
staged without mutating currently active runtime configuration.

Parameters:
checkExecutionOptions (object | null) - source options

Returns:
object - deep-cloned options

Possible side effects:
None
*/
function cloneCheckExecutionOptions(checkExecutionOptions) {
  const sourceOptions = checkExecutionOptions && typeof checkExecutionOptions === "object" ? checkExecutionOptions : {};
  return JSON.parse(JSON.stringify(sourceOptions));
}

/*
Purpose:
Normalize property state value from dataset/UI into allowed engine values.

Parameters:
stateValue (unknown) - candidate state

Returns:
"checked" | "unchecked"

Possible side effects:
None
*/
function normalizePropertyStateValue(stateValue) {
  return String(stateValue || "").toLowerCase() === "unchecked" ? "unchecked" : "checked";
}

/*
Purpose:
Build scope-grouped property definitions so check-selection modal can mirror the
original application categorization for product and system checks.

Parameters:
ruleDataset (object) - loaded original dataset

Returns:
{
  product: Map<string, Array<object>>,
  system: Map<string, Array<object>>
}

Possible side effects:
None
*/
function buildScopeGroupedPropertyDefinitions(ruleDataset) {
  const buildGroupedMap = (definitions) => {
    const groupedMap = new Map();

    (definitions || []).forEach((definition) => {
      if (!definition?.group || !definition?.label) {
        return;
      }

      if (!groupedMap.has(definition.group)) {
        groupedMap.set(definition.group, []);
      }

      groupedMap.get(definition.group).push(definition);
    });

    Array.from(groupedMap.keys()).forEach((groupName) => {
      const groupDefinitions = groupedMap.get(groupName) || [];
      groupDefinitions.sort((leftDefinition, rightDefinition) =>
        String(leftDefinition.label).localeCompare(String(rightDefinition.label), "fi", { sensitivity: "base" }),
      );
    });

    return new Map(
      Array.from(groupedMap.entries()).sort((leftEntry, rightEntry) =>
        String(leftEntry[0]).localeCompare(String(rightEntry[0]), "fi", { sensitivity: "base" }),
      ),
    );
  };

  return {
    product: buildGroupedMap(ruleDataset?.productPropertyDefinitions || []),
    system: buildGroupedMap(ruleDataset?.systemPropertyDefinitions || []),
  };
}

/*
Purpose:
Build default check-execution options directly from extracted dataset so each
property starts with the same checked/unchecked state as in original app.

Parameters:
ruleDataset (object) - loaded original dataset

Returns:
{
  enabledScopes: { product: boolean, system: boolean },
  enabledCheckPhases: {
    productIdentification: boolean,
    productContent: boolean,
    systemIdentification: boolean,
    systemContent: boolean
  },
  showWarnings: boolean,
  propertyStates: object
}

Possible side effects:
None
*/
function buildDefaultCheckExecutionOptions(ruleDataset) {
  const propertyStates = {};
  const defaultStates = ruleDataset?.defaultPropertyStates || {};
  const allDefinitions = [
    ...(ruleDataset?.productPropertyDefinitions || []),
    ...(ruleDataset?.systemPropertyDefinitions || []),
  ];

  allDefinitions.forEach((definition) => {
    if (!definition?.group || !definition?.label) {
      return;
    }

    if (!propertyStates[definition.group]) {
      propertyStates[definition.group] = {};
    }

    const defaultState = defaultStates[definition.group]?.[definition.label];
    propertyStates[definition.group][definition.label] = normalizePropertyStateValue(defaultState);
  });

  return {
    enabledScopes: {
      product: true,
      system: true,
    },
    enabledCheckPhases: {
      productIdentification: true,
      productContent: true,
      systemIdentification: true,
      systemContent: true,
    },
    showWarnings: false,
    propertyStates,
  };
}

/*
Purpose:
Merge persisted or previously selected options with current dataset defaults so
new properties/check phases are always initialized and legacy option payloads do
not break execution.

Parameters:
defaultExecutionOptions (object) - fresh defaults from current dataset
existingExecutionOptions (object | null) - previously stored options

Returns:
object - normalized and merged options

Possible side effects:
None
*/
function mergeCheckExecutionOptionsWithDefaults(defaultExecutionOptions, existingExecutionOptions) {
  const mergedOptions = cloneCheckExecutionOptions(defaultExecutionOptions);
  const sourceOptions =
    existingExecutionOptions && typeof existingExecutionOptions === "object" ? existingExecutionOptions : {};

  mergedOptions.enabledScopes.product = sourceOptions?.enabledScopes?.product !== false;
  mergedOptions.enabledScopes.system = sourceOptions?.enabledScopes?.system !== false;

  mergedOptions.enabledCheckPhases.productIdentification =
    sourceOptions?.enabledCheckPhases?.productIdentification !== false;
  mergedOptions.enabledCheckPhases.productContent = sourceOptions?.enabledCheckPhases?.productContent !== false;
  mergedOptions.enabledCheckPhases.systemIdentification =
    sourceOptions?.enabledCheckPhases?.systemIdentification !== false;
  mergedOptions.enabledCheckPhases.systemContent = sourceOptions?.enabledCheckPhases?.systemContent !== false;
  mergedOptions.showWarnings = sourceOptions?.showWarnings === true;

  Object.keys(mergedOptions.propertyStates).forEach((groupName) => {
    Object.keys(mergedOptions.propertyStates[groupName]).forEach((propertyLabel) => {
      const existingState = sourceOptions?.propertyStates?.[groupName]?.[propertyLabel];
      if (existingState !== undefined) {
        mergedOptions.propertyStates[groupName][propertyLabel] = normalizePropertyStateValue(existingState);
      }
    });
  });

  return mergedOptions;
}

/*
Purpose:
Ensure runtime has one stable check-selection option object before UI modal is
opened or checker execution is triggered.

Parameters:
ruleDataset (object) - loaded original dataset

Returns:
void

Possible side effects:
- Initializes runtime check-execution options when missing.
*/
function ensureCheckExecutionOptionsInitialized(ruleDataset) {
  const defaultExecutionOptions = buildDefaultCheckExecutionOptions(ruleDataset);
  runtimeState.checkExecutionOptions = mergeCheckExecutionOptionsWithDefaults(
    defaultExecutionOptions,
    runtimeState.checkExecutionOptions,
  );
}

/*
Purpose:
Compute selected/total property count for one scope so modal can display quick
scope-level selection statistics.

Parameters:
scopeGroupedDefinitions (Map<string, Array<object>>) - group map for one scope
propertyStates (object) - selected property states

Returns:
{ selectedCount: number, totalCount: number }

Possible side effects:
None
*/
function countScopeSelectedProperties(scopeGroupedDefinitions, propertyStates) {
  let selectedCount = 0;
  let totalCount = 0;

  Array.from(scopeGroupedDefinitions.values()).forEach((groupDefinitions) => {
    groupDefinitions.forEach((definition) => {
      totalCount += 1;
      const stateValue = normalizePropertyStateValue(propertyStates?.[definition.group]?.[definition.label]);
      if (stateValue !== "unchecked") {
        selectedCount += 1;
      }
    });
  });

  return { selectedCount, totalCount };
}

/*
Purpose:
Create one compact human-readable summary string for currently selected check
execution options so status messages can confirm what will be executed.

Parameters:
ruleDataset (object) - loaded original dataset
checkExecutionOptions (object) - selected options

Returns:
string - summary text

Possible side effects:
None
*/
function summarizeCheckExecutionOptions(ruleDataset, checkExecutionOptions) {
  const groupedDefinitionsByScope = buildScopeGroupedPropertyDefinitions(ruleDataset);
  const productScopeEnabled = checkExecutionOptions?.enabledScopes?.product !== false;
  const systemScopeEnabled = checkExecutionOptions?.enabledScopes?.system !== false;
  const productIdentificationEnabled = checkExecutionOptions?.enabledCheckPhases?.productIdentification !== false;
  const productContentEnabled = checkExecutionOptions?.enabledCheckPhases?.productContent !== false;
  const systemIdentificationEnabled = checkExecutionOptions?.enabledCheckPhases?.systemIdentification !== false;
  const systemContentEnabled = checkExecutionOptions?.enabledCheckPhases?.systemContent !== false;
  const showWarningsEnabled = checkExecutionOptions?.showWarnings === true;

  const productCounts = countScopeSelectedProperties(groupedDefinitionsByScope.product, checkExecutionOptions?.propertyStates || {});
  const systemCounts = countScopeSelectedProperties(groupedDefinitionsByScope.system, checkExecutionOptions?.propertyStates || {});

  return `Tuoteosat: ${productScopeEnabled ? "ON" : "OFF"} [Tunnistaminen: ${productIdentificationEnabled ? "ON" : "OFF"}, Sisalto: ${productContentEnabled ? "ON" : "OFF"}] (${productCounts.selectedCount}/${productCounts.totalCount}), Jarjestelmat: ${systemScopeEnabled ? "ON" : "OFF"} [Tunnistaminen: ${systemIdentificationEnabled ? "ON" : "OFF"}, Sisalto: ${systemContentEnabled ? "ON" : "OFF"}] (${systemCounts.selectedCount}/${systemCounts.totalCount}), Nayta varoitukset: ${showWarningsEnabled ? "ON" : "OFF"}`;
}

/*
Purpose:
Encode dataset values for HTML data attributes used by delegated modal events.

Parameters:
rawValue (unknown) - source value

Returns:
string - URI-encoded string

Possible side effects:
None
*/
function encodeDataAttributeValue(rawValue) {
  return encodeURIComponent(String(rawValue ?? ""));
}

/*
Purpose:
Decode URI-encoded data-attribute values from modal control elements.

Parameters:
encodedValue (string | null) - encoded value from data-attribute

Returns:
string - decoded value or empty string when malformed

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

/*
Purpose:
Render one scope section in check-selection modal with original-style
categorization and per-group property toggles.

Parameters:
scopeKey ("product" | "system") - scope identifier
scopeTitle (string) - visible scope title
scopeDescription (string) - user guidance text
groupedDefinitions (Map<string, Array<object>>) - scope definitions grouped by FI group
draftExecutionOptions (object) - mutable draft options

Returns:
string - scope section HTML

Possible side effects:
None
*/
function renderCheckSelectionScopeSection(
  scopeKey,
  scopeTitle,
  scopeDescription,
  identificationLabel,
  contentLabel,
  groupedDefinitions,
  draftExecutionOptions,
) {
  const scopeEnabled = draftExecutionOptions?.enabledScopes?.[scopeKey] !== false;
  const identificationPhaseKey = `${scopeKey}Identification`;
  const contentPhaseKey = `${scopeKey}Content`;
  const isIdentificationEnabled = draftExecutionOptions?.enabledCheckPhases?.[identificationPhaseKey] !== false;
  const isContentEnabled = draftExecutionOptions?.enabledCheckPhases?.[contentPhaseKey] !== false;
  const scopeSelectionCounts = countScopeSelectedProperties(groupedDefinitions, draftExecutionOptions?.propertyStates || {});

  const groupMarkup = Array.from(groupedDefinitions.entries())
    .map(([groupName, groupDefinitions], groupIndex) => {
      let selectedInGroup = 0;
      const optionRows = groupDefinitions
        .map((definition) => {
          const currentState = normalizePropertyStateValue(
            draftExecutionOptions?.propertyStates?.[definition.group]?.[definition.label],
          );
          const isChecked = currentState !== "unchecked";
          if (isChecked) {
            selectedInGroup += 1;
          }

          return `
            <label class="check-option-row">
              <input
                type="checkbox"
                data-check-property="true"
                data-check-group="${encodeDataAttributeValue(definition.group)}"
                data-check-label="${encodeDataAttributeValue(definition.label)}"
                ${isChecked ? "checked" : ""}
                ${scopeEnabled ? "" : "disabled"}
              />
              <span>${escapeHtml(definition.label)}</span>
            </label>
          `;
        })
        .join("");

      return `
        <details class="check-group-details" ${groupIndex === 0 ? "open" : ""}>
          <summary class="check-group-summary">
            <span class="check-group-name">${escapeHtml(groupName)}</span>
            <span class="check-group-count">${selectedInGroup} / ${groupDefinitions.length}</span>
          </summary>
          <div class="check-group-options">
            ${optionRows}
          </div>
        </details>
      `;
    })
    .join("");

  return `
    <section class="check-scope-card ${scopeEnabled ? "" : "is-scope-disabled"}" data-check-scope="${scopeKey}">
      <label class="check-scope-header">
        <input type="checkbox" data-check-scope-enabled="${scopeKey}" ${scopeEnabled ? "checked" : ""} />
        <span class="check-scope-title">${escapeHtml(scopeTitle)}</span>
      </label>
      <div class="check-scope-meta">
        <span>${escapeHtml(scopeDescription)}</span>
        <span class="check-scope-count">${scopeSelectionCounts.selectedCount} / ${scopeSelectionCounts.totalCount} valittuna</span>
      </div>
      <div class="check-phase-grid">
        <label class="check-phase-row">
          <input
            type="checkbox"
            data-check-phase-enabled="${identificationPhaseKey}"
            ${isIdentificationEnabled ? "checked" : ""}
            ${scopeEnabled ? "" : "disabled"}
          />
          <span>${escapeHtml(identificationLabel)}</span>
        </label>
        <label class="check-phase-row">
          <input
            type="checkbox"
            data-check-phase-enabled="${contentPhaseKey}"
            ${isContentEnabled ? "checked" : ""}
            ${scopeEnabled ? "" : "disabled"}
          />
          <span>${escapeHtml(contentLabel)}</span>
        </label>
      </div>
      <div class="check-scope-groups">${groupMarkup}</div>
    </section>
  `;
}

/*
Purpose:
Render full check-selection modal content using both product and system scope
grouping so user can choose what is validated before checker run.

Parameters:
groupedDefinitionsByScope (object) - grouped definitions for both scopes
draftExecutionOptions (object) - mutable draft options

Returns:
string - full modal content HTML

Possible side effects:
None
*/
function renderCheckSelectionModalContent(groupedDefinitionsByScope, draftExecutionOptions) {
  const showWarningsEnabled = draftExecutionOptions?.showWarnings === true;

  return `
    <section class="check-display-options">
      <label class="check-display-option-row">
        <input type="checkbox" data-check-show-warnings="true" ${showWarningsEnabled ? "checked" : ""} />
        <span>Nayta varoitukset tuloksissa</span>
      </label>
    </section>
    ${renderCheckSelectionScopeSection(
      "product",
      "Tuoteosien tarkastukset",
      "Tuoteosien tunnistaminen ja tunnistettujen tuoteosien tietosisallot.",
      "Tuoteosien tunnistaminen",
      "Tunnistettujen tuoteosien tietorakenteet ja sisallot",
      groupedDefinitionsByScope.product,
      draftExecutionOptions,
    )}
    ${renderCheckSelectionScopeSection(
      "system",
      "Jarjestelmien tarkastukset",
      "Jarjestelmien tunnistaminen ja tunnistettujen jarjestelmien tietosisallot.",
      "Jarjestelmien tunnistaminen",
      "Tunnistettujen jarjestelmien tietorakenteet ja sisallot",
      groupedDefinitionsByScope.system,
      draftExecutionOptions,
    )}
  `;
}

/*
Purpose:
Set all property states and scope flags in one action for modal quick actions.

Parameters:
draftExecutionOptions (object) - mutable draft options
groupedDefinitionsByScope (object) - grouped definitions for both scopes
checkedState ("checked" | "unchecked") - target state for all properties
enabledScopeState (boolean) - target enabled state for both scopes

Returns:
void

Possible side effects:
- Mutates draft options object.
*/
function applyGlobalCheckSelectionState(draftExecutionOptions, groupedDefinitionsByScope, checkedState, enabledScopeState) {
  const normalizedState = normalizePropertyStateValue(checkedState);
  draftExecutionOptions.enabledScopes.product = Boolean(enabledScopeState);
  draftExecutionOptions.enabledScopes.system = Boolean(enabledScopeState);
  draftExecutionOptions.enabledCheckPhases.productIdentification = Boolean(enabledScopeState);
  draftExecutionOptions.enabledCheckPhases.productContent = Boolean(enabledScopeState);
  draftExecutionOptions.enabledCheckPhases.systemIdentification = Boolean(enabledScopeState);
  draftExecutionOptions.enabledCheckPhases.systemContent = Boolean(enabledScopeState);

  const setScopeState = (scopeGroupedDefinitions) => {
    Array.from(scopeGroupedDefinitions.values()).forEach((groupDefinitions) => {
      groupDefinitions.forEach((definition) => {
        if (!draftExecutionOptions.propertyStates[definition.group]) {
          draftExecutionOptions.propertyStates[definition.group] = {};
        }

        draftExecutionOptions.propertyStates[definition.group][definition.label] = normalizedState;
      });
    });
  };

  setScopeState(groupedDefinitionsByScope.product);
  setScopeState(groupedDefinitionsByScope.system);
}

/*
Purpose:
Open check-selection modal and resolve selected options when user confirms.

Parameters:
ruleDataset (object) - loaded original dataset

Returns:
Promise<object | null> - selected execution options, or null when cancelled

Possible side effects:
- Opens interactive modal.
- Attaches temporary event handlers.
*/
function openCheckSelectionModal(ruleDataset) {
  return new Promise((resolvePromise) => {
    ensureCheckExecutionOptionsInitialized(ruleDataset);
    if (!ui.checkSelectionModal || !ui.checkSelectionDialog || !ui.checkSelectionContent) {
      resolvePromise(cloneCheckExecutionOptions(runtimeState.checkExecutionOptions));
      return;
    }

    const groupedDefinitionsByScope = buildScopeGroupedPropertyDefinitions(ruleDataset);
    let draftExecutionOptions = cloneCheckExecutionOptions(runtimeState.checkExecutionOptions);

    const renderModalContent = () => {
      ui.checkSelectionContent.innerHTML = renderCheckSelectionModalContent(groupedDefinitionsByScope, draftExecutionOptions);
    };

    const cleanupAndResolve = (resolvedValue) => {
      ui.checkSelectionModal.hidden = true;
      document.body.classList.remove("modal-open");

      ui.checkSelectionContent.removeEventListener("change", handleContentChange);
      ui.checkSelectionCloseButton?.removeEventListener("click", handleCancel);
      ui.checkSelectionCancelButton?.removeEventListener("click", handleCancel);
      ui.checkSelectionConfirmButton?.removeEventListener("click", handleConfirm);
      ui.checkSelectionEnableAllButton?.removeEventListener("click", handleEnableAll);
      ui.checkSelectionDisableAllButton?.removeEventListener("click", handleDisableAll);
      ui.checkSelectionDefaultsButton?.removeEventListener("click", handleDefaults);
      ui.checkSelectionModal.removeEventListener("click", handleBackdropClick);
      ui.checkSelectionModal.removeEventListener("keydown", handleModalKeydown);

      resolvePromise(resolvedValue);
    };

    const handleCancel = () => {
      cleanupAndResolve(null);
    };

    const handleConfirm = () => {
      const isProductScopeEnabled = draftExecutionOptions?.enabledScopes?.product !== false;
      const isSystemScopeEnabled = draftExecutionOptions?.enabledScopes?.system !== false;
      const hasProductChecksSelected =
        isProductScopeEnabled &&
        (draftExecutionOptions?.enabledCheckPhases?.productIdentification !== false ||
          draftExecutionOptions?.enabledCheckPhases?.productContent !== false);
      const hasSystemChecksSelected =
        isSystemScopeEnabled &&
        (draftExecutionOptions?.enabledCheckPhases?.systemIdentification !== false ||
          draftExecutionOptions?.enabledCheckPhases?.systemContent !== false);

      if (!hasProductChecksSelected && !hasSystemChecksSelected) {
        setStatus("Valitse ainakin yksi tarkastus ennen suoritusta.", "warning");
        return;
      }

      cleanupAndResolve(cloneCheckExecutionOptions(draftExecutionOptions));
    };

    const handleEnableAll = () => {
      applyGlobalCheckSelectionState(draftExecutionOptions, groupedDefinitionsByScope, "checked", true);
      renderModalContent();
    };

    const handleDisableAll = () => {
      applyGlobalCheckSelectionState(draftExecutionOptions, groupedDefinitionsByScope, "unchecked", false);
      renderModalContent();
    };

    const handleDefaults = () => {
      draftExecutionOptions = buildDefaultCheckExecutionOptions(ruleDataset);
      renderModalContent();
    };

    const handleBackdropClick = (clickEvent) => {
      if (clickEvent.target === ui.checkSelectionModal) {
        handleCancel();
      }
    };

    const handleModalKeydown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        handleCancel();
      }
    };

    const handleContentChange = (changeEvent) => {
      const eventTarget = changeEvent.target;
      if (!(eventTarget instanceof HTMLInputElement)) {
        return;
      }

      if (eventTarget.getAttribute("data-check-show-warnings") === "true") {
        draftExecutionOptions.showWarnings = eventTarget.checked;
        renderModalContent();
        return;
      }

      const scopeKeyFromToggle = eventTarget.getAttribute("data-check-scope-enabled");
      if (scopeKeyFromToggle) {
        draftExecutionOptions.enabledScopes[scopeKeyFromToggle] = eventTarget.checked;
        renderModalContent();
        return;
      }

      const phaseKeyFromToggle = eventTarget.getAttribute("data-check-phase-enabled");
      if (phaseKeyFromToggle) {
        draftExecutionOptions.enabledCheckPhases[phaseKeyFromToggle] = eventTarget.checked;
        renderModalContent();
        return;
      }

      if (eventTarget.getAttribute("data-check-property") === "true") {
        const propertyGroup = decodeDataAttributeValue(eventTarget.getAttribute("data-check-group"));
        const propertyLabel = decodeDataAttributeValue(eventTarget.getAttribute("data-check-label"));

        if (!propertyGroup || !propertyLabel) {
          return;
        }

        if (!draftExecutionOptions.propertyStates[propertyGroup]) {
          draftExecutionOptions.propertyStates[propertyGroup] = {};
        }

        draftExecutionOptions.propertyStates[propertyGroup][propertyLabel] = eventTarget.checked ? "checked" : "unchecked";
        renderModalContent();
      }
    };

    renderModalContent();
    ui.checkSelectionModal.hidden = false;
    document.body.classList.add("modal-open");
    ui.checkSelectionDialog.focus();

    ui.checkSelectionContent.addEventListener("change", handleContentChange);
    ui.checkSelectionCloseButton?.addEventListener("click", handleCancel);
    ui.checkSelectionCancelButton?.addEventListener("click", handleCancel);
    ui.checkSelectionConfirmButton?.addEventListener("click", handleConfirm);
    ui.checkSelectionEnableAllButton?.addEventListener("click", handleEnableAll);
    ui.checkSelectionDisableAllButton?.addEventListener("click", handleDisableAll);
    ui.checkSelectionDefaultsButton?.addEventListener("click", handleDefaults);
    ui.checkSelectionModal.addEventListener("click", handleBackdropClick);
    ui.checkSelectionModal.addEventListener("keydown", handleModalKeydown);
  });
}

/*
Purpose:
Render one clear status line with semantic style so the user can understand
exactly what the extension is doing during asynchronous calls.

Parameters:
message (string) - status text displayed to user
severity ("info" | "success" | "warning" | "error") - visual status level

Returns:
void

Possible side effects:
- Updates status element text and CSS class list.
*/
function setStatus(message, severity = "info") {
  if (!ui.status) {
    return;
  }

  ui.status.textContent = message;
  ui.status.className = `status status-${severity}`;
}

/*
Purpose:
Synchronize loading-state UI behavior so repeated clicks cannot start parallel
file-tree traversals and produce conflicting table updates.

Logic:
When loading starts, refresh button is disabled. When loading finishes, button
is enabled again.

Parameters:
isLoading (boolean) - true while file loading is in progress

Returns:
void

Possible side effects:
- Updates refresh button disabled state.
- Stores loading flag in runtime state.
*/
function setLoadingState(isLoading) {
  runtimeState.isLoadingFiles = Boolean(isLoading);

  updateRefreshButtonState();
  updateDownloadButtonState();
  updateEditCheckSettingsButtonState();
  updateClearModelButtonState();
  updateReportExportActionButtonState();
}

/*
Purpose:
Keep refresh button gating logic in one helper so list reloading cannot be
triggered during running checker execution.

Parameters:
None

Returns:
void

Possible side effects:
- Updates refresh button disabled state.
*/
function updateRefreshButtonState() {
  if (!ui.refreshButton) {
    return;
  }

  ui.refreshButton.disabled = runtimeState.isLoadingFiles || runtimeState.isRunningCheck || runtimeState.isCreatingBcfTopics;
}

/*
Purpose:
Enable or disable clear-model button based on whether a model is currently
stored in memory and whether potentially conflicting operations are running.

Parameters:
None

Returns:
void

Possible side effects:
- Updates clear button disabled state.
*/
function updateClearModelButtonState() {
  if (!ui.clearModelButton) {
    return;
  }

  const hasLoadedModel = Boolean(runtimeState.downloadedIfcFile);
  ui.clearModelButton.disabled =
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics ||
    !hasLoadedModel;
}

/*
Purpose:
Enable report export actions only when one completed check result exists and no
conflicting async operation is running.

Logic:
Report export buttons are usable only after successful checker run because they
depend on latest in-memory report payload.

Parameters:
None

Returns:
void

Possible side effects:
- Updates report-export and BCF-draft button disabled states.
*/
function updateReportExportActionButtonState() {
  const hasCheckResult = Boolean(runtimeState.latestCheckResult && runtimeState.downloadedIfcFile);
  const shouldDisableButtons =
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics ||
    !hasCheckResult;

  if (ui.downloadReportButton) {
    ui.downloadReportButton.disabled = shouldDisableButtons;
  }

  if (ui.exportBcfDraftButton) {
    ui.exportBcfDraftButton.disabled = shouldDisableButtons;
  }
}

/*
Purpose:
Enable or disable the "edit check settings" action so user can re-open check
selection safely after model download, but never during conflicting operations.

Logic:
Settings editing stays available only when:
- model bytes are already stored in memory
- file loading, file download, and checker run are all idle

Parameters:
None

Returns:
void

Possible side effects:
- Updates settings edit button disabled state.
*/
function updateEditCheckSettingsButtonState() {
  if (!ui.editCheckSettingsButton) {
    return;
  }

  const hasLoadedModel = Boolean(runtimeState.downloadedIfcFile);
  ui.editCheckSettingsButton.disabled =
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics ||
    !hasLoadedModel;
}

/*
Purpose:
Synchronize download button availability with current selection and active
request states so user can only start a valid and non-overlapping download.

Logic:
Download button is enabled only when:
- file listing is not loading
- download is not already running
- checker run is not already running
- selected file exists and includes both fileId and versionId

Parameters:
None

Returns:
void

Possible side effects:
- Updates selected-file download button disabled state.
*/
function updateDownloadButtonState() {
  if (!ui.downloadSelectedButton) {
    return;
  }

  const hasSelectableFile =
    runtimeState.selectedFileEntry &&
    isNonEmptyString(runtimeState.selectedFileEntry.fileId) &&
    isNonEmptyString(runtimeState.selectedFileEntry.versionId);

  ui.downloadSelectedButton.disabled =
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics ||
    !hasSelectableFile;
}

/*
Purpose:
Render one compact summary of current row selection so user can verify fileId,
folderId, and versionId before running the download action.

Parameters:
selectedFileEntry (object | null) - selected row payload or null

Returns:
void

Possible side effects:
- Updates selected-file summary label text.
*/
function renderSelectedFileSummary(selectedFileEntry) {
  if (!ui.selectedFileSummary) {
    return;
  }

  if (!selectedFileEntry) {
    ui.selectedFileSummary.textContent = "No IFC file selected.";
    return;
  }

  ui.selectedFileSummary.textContent = `Selected: ${selectedFileEntry.name} | fileId: ${selectedFileEntry.fileId} | folderId: ${selectedFileEntry.folderId} | versionId: ${selectedFileEntry.versionId}`;
}

/*
Purpose:
Synchronize radio inputs and selected-row highlight classes after selection
changes without rebuilding the whole table DOM.

Logic:
Each row compares its row key with runtime selection key and updates both
`checked` and `is-selected` state accordingly.

Parameters:
None

Returns:
void

Possible side effects:
- Mutates row classes and radio checked values in file table body.
*/
function syncFileTableSelectionState() {
  if (!ui.fileTableBody) {
    return;
  }

  const tableRows = Array.from(ui.fileTableBody.querySelectorAll("tr[data-row-key]"));
  tableRows.forEach((tableRow) => {
    const rowKey = String(tableRow.getAttribute("data-row-key") || "");
    const isSelectedRow = rowKey !== "" && rowKey === runtimeState.selectedFileRowKey;
    tableRow.classList.toggle("is-selected", isSelectedRow);

    const rowRadioInput = tableRow.querySelector('input[type="radio"][name="ifc-file-selection"]');
    if (rowRadioInput instanceof HTMLInputElement) {
      rowRadioInput.checked = isSelectedRow;
    }
  });
}

/*
Purpose:
Set current file selection in one place so runtime state, summary label, table
selection styles, and action-button state always stay in sync.

Parameters:
selectedFileEntry (object | null) - next selected file entry

Returns:
void

Possible side effects:
- Updates selected-file runtime state.
- Updates file table selection highlight.
- Updates selected-file summary and download button state.
*/
function setSelectedFileEntry(selectedFileEntry) {
  if (selectedFileEntry && typeof selectedFileEntry === "object") {
    runtimeState.selectedFileEntry = selectedFileEntry;
    runtimeState.selectedFileRowKey = buildFileRowKey(selectedFileEntry);
  } else {
    runtimeState.selectedFileEntry = null;
    runtimeState.selectedFileRowKey = "";
  }

  syncFileTableSelectionState();
  renderSelectedFileSummary(runtimeState.selectedFileEntry);
  updateDownloadButtonState();
}

/*
Purpose:
Normalize access-token payload variants into one plain token string because
Workspace API may deliver token through multiple data shapes.

Logic:
- Accept direct token string payload.
- Accept common object payload fields (`accessToken`, `token`, nested `data`).
- Return empty string when no usable token exists.

Parameters:
tokenPayload (unknown) - payload from permission call or access-token event

Returns:
string - normalized token or empty string

Possible side effects:
None
*/
function normalizeAccessToken(tokenPayload) {
  if (isNonEmptyString(tokenPayload)) {
    return tokenPayload.trim();
  }

  if (!tokenPayload || typeof tokenPayload !== "object") {
    return "";
  }

  const objectPayload = tokenPayload;
  const candidateValues = [
    objectPayload.accessToken,
    objectPayload.token,
    objectPayload.data?.accessToken,
    objectPayload.data?.token,
    objectPayload.data,
  ];

  for (const candidateValue of candidateValues) {
    if (isNonEmptyString(candidateValue)) {
      return candidateValue.trim();
    }
  }

  return "";
}

/*
Purpose:
Resolve all pending token waiters when token arrives asynchronously through
Workspace event flow.

Parameters:
resolvedToken (string) - newly received access token

Returns:
void

Possible side effects:
- Resolves and clears all pending token waiter callbacks.
*/
function resolveAccessTokenWaiters(resolvedToken) {
  if (!isNonEmptyString(resolvedToken)) {
    return;
  }

  runtimeState.accessTokenWaiters.forEach((resolveWaiter) => {
    resolveWaiter(resolvedToken);
  });

  runtimeState.accessTokenWaiters.clear();
}

/*
Purpose:
Handle Workspace API events that are relevant for this lightweight file-index
view.

Logic:
- Capture access-token events for API calls.
- Handle extension command event as manual refresh trigger.

Parameters:
eventName (string) - Workspace event name
eventArguments (unknown) - event payload

Returns:
void

Possible side effects:
- Updates cached token.
- Triggers table reload when command event is received.
*/
function handleWorkspaceEvent(eventName, eventArguments) {
  if (eventName === WORKSPACE_EVENT_ACCESS_TOKEN) {
    const eventToken = normalizeAccessToken(eventArguments);
    if (isNonEmptyString(eventToken)) {
      runtimeState.accessToken = eventToken;
      resolveAccessTokenWaiters(eventToken);
    }
    return;
  }

  if (
    eventName === WORKSPACE_EVENT_EXTENSION_COMMAND &&
    (!eventArguments?.data || eventArguments.data === MAIN_MENU_COMMAND) &&
    !runtimeState.isLoadingFiles
  ) {
    void loadAndRenderProjectFiles();
  }
}

/*
Purpose:
Register one extension command into Trimble Connect UI so the app becomes
selectable from the left-side navigation and command interactions can trigger
refresh logic.

Logic:
The command is registered only once per runtime session. Some host variants
may not expose `ui.setMenu`; in that case we skip registration gracefully so
the rest of file loading and checker functionality still work.

Parameters:
workspaceApi (object) - connected Workspace API object

Returns:
Promise<void>

Possible side effects:
- Adds or updates extension menu item in Trimble Connect shell.
*/
async function registerMainMenuIfSupported(workspaceApi) {
  if (runtimeState.hasRegisteredMainMenu) {
    return;
  }

  const setMenuFunction =
    workspaceApi?.ui && typeof workspaceApi.ui.setMenu === "function" ? workspaceApi.ui.setMenu.bind(workspaceApi.ui) : null;

  if (!setMenuFunction) {
    return;
  }

  await setMenuFunction({
    title: MAIN_MENU_TITLE,
    icon: MAIN_MENU_ICON_URL,
    command: MAIN_MENU_COMMAND,
  });

  runtimeState.hasRegisteredMainMenu = true;
}

/*
Purpose:
Create one Workspace API connection and store it in runtime state so every
operation reuses the same channel.

Parameters:
None

Returns:
Promise<object> - connected Workspace API object

Possible side effects:
- Creates cross-window connection to Trimble Connect host.
- Throws when Workspace API script is missing.
*/
async function connectWorkspaceApi() {
  if (runtimeState.workspaceApi) {
    return runtimeState.workspaceApi;
  }

  if (!window.TrimbleConnectWorkspace || typeof window.TrimbleConnectWorkspace.connect !== "function") {
    throw new Error("Trimble Workspace API script was not available on the page.");
  }

  runtimeState.workspaceApi = await window.TrimbleConnectWorkspace.connect(window.parent, handleWorkspaceEvent, 30000);
  return runtimeState.workspaceApi;
}

/*
Purpose:
Read current project context from Workspace API while tolerating API version
variations (`getCurrentProject` vs `getProject`).

Parameters:
workspaceApi (object) - connected Workspace API object

Returns:
Promise<{ projectId: string, projectName: string, rootFolderId: string }>

Possible side effects:
None
*/
async function readCurrentProjectContext(workspaceApi) {
  const projectApi = workspaceApi?.project;
  if (!projectApi || typeof projectApi !== "object") {
    throw new Error("Workspace project API was missing.");
  }

  const getCurrentProjectFunction =
    typeof projectApi.getCurrentProject === "function"
      ? projectApi.getCurrentProject.bind(projectApi)
      : typeof projectApi.getProject === "function"
        ? projectApi.getProject.bind(projectApi)
        : null;

  if (!getCurrentProjectFunction) {
    throw new Error("Workspace project API did not expose project read method.");
  }

  const rawProject = await getCurrentProjectFunction();
  const projectId = pickFirstNonEmptyString([rawProject?.id, rawProject?.projectId]);
  const projectName = pickFirstNonEmptyString([rawProject?.name, rawProject?.projectName]);
  const rootFolderId = pickFirstNonEmptyString([
    rawProject?.rootFolderId,
    rawProject?.rootFolder?.id,
    rawProject?.rootId,
    rawProject?.folderId,
    rawProject?.defaultFolderId,
    rawProject?.projectFolderId,
  ]);

  if (!isNonEmptyString(projectId)) {
    throw new Error("Current project id was missing from Workspace API response.");
  }

  return {
    projectId,
    projectName: projectName || "Unnamed project",
    rootFolderId,
  };
}

/*
Purpose:
Wait for access-token event when permission call does not return the token
immediately.

Logic:
A timeout is included so the UI does not stay in silent pending state forever
if host never dispatches the access-token event.

Parameters:
timeoutMs (number) - maximum wait time in milliseconds

Returns:
Promise<string> - token received through event

Possible side effects:
- Adds and later removes one resolve callback from waiter set.
*/
function waitForAccessTokenEvent(timeoutMs = 30000) {
  if (isNonEmptyString(runtimeState.accessToken)) {
    return Promise.resolve(runtimeState.accessToken);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutHandle = window.setTimeout(() => {
      runtimeState.accessTokenWaiters.delete(resolveWaiter);
      rejectPromise(new Error("Access token event timeout expired."));
    }, timeoutMs);

    const resolveWaiter = (resolvedToken) => {
      window.clearTimeout(timeoutHandle);
      resolvePromise(resolvedToken);
    };

    runtimeState.accessTokenWaiters.add(resolveWaiter);
  });
}

/*
Purpose:
Request access-token permission and return a usable token for Core API calls.

Logic:
- Request permission from Workspace host.
- Use token directly when present in response.
- If token is not in response, wait for `extension.accessToken` event.

Parameters:
workspaceApi (object) - connected Workspace API object

Returns:
Promise<string> - usable bearer token

Possible side effects:
- May open permission prompt in Trimble Connect host UI.
*/
async function ensureAccessToken(workspaceApi) {
  if (isNonEmptyString(runtimeState.accessToken)) {
    return runtimeState.accessToken;
  }

  if (!workspaceApi?.extension || typeof workspaceApi.extension.requestPermission !== "function") {
    throw new Error("Workspace extension permission API was missing.");
  }

  const permissionResponse = await workspaceApi.extension.requestPermission("accesstoken");
  const permissionToken = normalizeAccessToken(permissionResponse);
  if (isNonEmptyString(permissionToken)) {
    runtimeState.accessToken = permissionToken;
    return permissionToken;
  }

  const permissionStatus = pickFirstNonEmptyString([
    permissionResponse?.status,
    typeof permissionResponse === "string" ? permissionResponse : "",
  ]).toLowerCase();

  if (permissionStatus === "denied") {
    throw new Error("Access token permission was denied in Trimble Connect.");
  }

  const eventToken = await waitForAccessTokenEvent(30000);
  runtimeState.accessToken = eventToken;
  return eventToken;
}

/*
Purpose:
Add URL candidate once while preserving insertion order so API host fallback
sequence remains deterministic.

Parameters:
urlCandidates (Array<string>) - mutable destination list
seenCandidates (Set<string>) - de-duplication set
candidateUrl (string) - URL candidate to add

Returns:
void

Possible side effects:
- Mutates provided list and set.
*/
function pushUniqueUrlCandidate(urlCandidates, seenCandidates, candidateUrl) {
  if (!isNonEmptyString(candidateUrl)) {
    return;
  }

  if (seenCandidates.has(candidateUrl)) {
    return;
  }

  seenCandidates.add(candidateUrl);
  urlCandidates.push(candidateUrl);
}

/*
Purpose:
Build prioritized Core API host candidates because Trimble Connect projects can
be served from different regional app hosts.

Logic:
- Derive host from current browser host first so the most likely region is
  tried before generic fallback hosts.
- Then include known static host list.
- Keep list unique and stable for predictable fallback behavior.

Parameters:
None

Returns:
Array<string> - candidate Core API base URLs

Possible side effects:
None
*/
function buildCoreApiBaseUrlCandidates() {
  const urlCandidates = [];
  const seenCandidates = new Set();

  const currentHost = pickFirstNonEmptyString([window.location.host]).toLowerCase();
  if (isNonEmptyString(currentHost)) {
    if (currentHost.startsWith("web.")) {
      const derivedAppHost = currentHost.replace(/^web\./, "app.");
      pushUniqueUrlCandidate(urlCandidates, seenCandidates, `https://${derivedAppHost}/tc/api/2.0`);
    } else if (currentHost.startsWith("app.")) {
      pushUniqueUrlCandidate(urlCandidates, seenCandidates, `https://${currentHost}/tc/api/2.0`);
    }
  }

  CORE_API_BASE_URL_STATIC_CANDIDATES.forEach((staticCandidate) => {
    pushUniqueUrlCandidate(urlCandidates, seenCandidates, staticCandidate);
  });

  return urlCandidates;
}

/*
Purpose:
Extract one item array from folder endpoint response because payload may return
as raw array or wrapped object depending on endpoint version.

Parameters:
responsePayload (unknown) - parsed JSON payload

Returns:
Array<object> - normalized folder item list

Possible side effects:
None
*/
function extractFolderItems(responsePayload) {
  if (Array.isArray(responsePayload)) {
    return responsePayload;
  }

  if (!responsePayload || typeof responsePayload !== "object") {
    return [];
  }

  const candidateCollections = [
    responsePayload.items,
    responsePayload.data,
    responsePayload.results,
    responsePayload.entries,
    responsePayload.children,
  ];

  const firstArrayCandidate = candidateCollections.find((candidateValue) => Array.isArray(candidateValue));
  return firstArrayCandidate || [];
}

/*
Purpose:
Load one folder's direct children from Trimble Connect Core API.

Parameters:
coreApiBaseUrl (string) - Core API host base URL
folderId (string) - folder identifier
accessToken (string) - bearer token

Returns:
Promise<Array<object>> - direct folder item entries

Possible side effects:
- Executes one network request to Core API.
*/
async function loadFolderItems(coreApiBaseUrl, folderId, accessToken) {
  const folderEndpoint = `${coreApiBaseUrl}/folders/${encodeURIComponent(folderId)}/items?tokenThumburl=false`;

  const folderResponse = await fetch(folderEndpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!folderResponse.ok) {
    throw new Error(`Folder listing request failed (${folderResponse.status}) at ${coreApiBaseUrl}.`);
  }

  const folderResponsePayload = await folderResponse.json();
  return extractFolderItems(folderResponsePayload);
}

/*
Purpose:
Fetch JSON payload from Core API with shared authorization behavior so root
folder resolution logic can reuse one predictable helper.

Parameters:
requestUrl (string) - absolute Core API endpoint URL
accessToken (string) - bearer token

Returns:
Promise<unknown> - parsed JSON payload

Possible side effects:
- Executes one network request to Core API.
*/
async function loadJsonFromCoreApi(requestUrl, accessToken) {
  const response = await fetch(requestUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Core API request failed (${response.status}) for ${requestUrl}.`);
  }

  return response.json();
}

/*
Purpose:
Extract possible root-folder identifier from project metadata payload because
field naming can vary across API versions and environments.

Parameters:
projectPayload (unknown) - parsed project metadata response payload
projectId (string) - current project id used as final fallback

Returns:
string - best-effort root folder id candidate

Possible side effects:
None
*/
function extractRootFolderIdFromProjectPayload(projectPayload, projectId) {
  if (!projectPayload || typeof projectPayload !== "object") {
    return projectId;
  }

  return (
    pickFirstNonEmptyString([
      projectPayload.rootFolderId,
      projectPayload.rootFolder?.id,
      projectPayload.rootId,
      projectPayload.folderId,
      projectPayload.defaultFolderId,
      projectPayload.projectFolderId,
    ]) || projectId
  );
}

/*
Purpose:
Resolve root folder id for project traversal with multiple fallbacks so file
listing can start from the correct folder even when Workspace project payload
does not expose `rootFolderId` directly.

Logic:
- Prefer root folder id from Workspace project context when available.
- Fallback to Core API project metadata endpoint.
- Finally fallback to project id to keep behavior deterministic.

Parameters:
coreApiBaseUrl (string) - active Core API base URL
accessToken (string) - bearer token
projectId (string) - current project id
preferredRootFolderId (string) - root folder candidate from Workspace API

Returns:
Promise<string> - resolved root folder id

Possible side effects:
- May execute one additional Core API request for project metadata.
*/
async function resolveProjectRootFolderId(coreApiBaseUrl, accessToken, projectId, preferredRootFolderId) {
  if (isNonEmptyString(preferredRootFolderId)) {
    return preferredRootFolderId;
  }

  try {
    const projectEndpoint = `${coreApiBaseUrl}/projects/${encodeURIComponent(projectId)}`;
    const projectPayload = await loadJsonFromCoreApi(projectEndpoint, accessToken);
    return extractRootFolderIdFromProjectPayload(projectPayload, projectId);
  } catch (projectReadError) {
    return projectId;
  }
}

/*
Purpose:
Classify one folder-item entry as folder or file with tolerant heuristics,
because item type fields may differ between API payload variants.

Logic:
- Respect explicit boolean folder flags first.
- Fall back to textual type markers.
- As last fallback, treat entries with child arrays as folders.

Parameters:
rawItem (object) - one folder-item payload entry

Returns:
boolean - true when entry should be traversed as folder

Possible side effects:
None
*/
function isFolderEntry(rawItem) {
  if (!rawItem || typeof rawItem !== "object") {
    return false;
  }

  if (rawItem.isFolder === true || rawItem.folder === true) {
    return true;
  }

  const normalizedTypeText = pickFirstNonEmptyString([
    rawItem.type,
    rawItem.itemType,
    rawItem.entityType,
    rawItem.kind,
  ]).toLowerCase();

  if (normalizedTypeText.includes("folder") || normalizedTypeText.includes("directory")) {
    return true;
  }

  return Array.isArray(rawItem.children) && rawItem.children.length > 0;
}

/*
Purpose:
Create stable item id from heterogeneous payload shapes so recursion queue and
file rows can reference entries reliably.

Parameters:
rawItem (object) - one folder-item payload entry

Returns:
string - best-effort id value

Possible side effects:
None
*/
function readEntryId(rawItem) {
  return pickFirstNonEmptyString([
    rawItem?.id,
    rawItem?.folderId,
    rawItem?.fileId,
    rawItem?.modelId,
    rawItem?.documentId,
  ]);
}

/*
Purpose:
Resolve file version identifier from folder-item payload using multiple field
names so downstream download endpoint call can always include `versionId`.

Parameters:
rawItem (object) - one folder-item payload entry
fallbackFileId (string) - file id used when explicit version id is missing

Returns:
string - version id candidate

Possible side effects:
None
*/
function readEntryVersionId(rawItem, fallbackFileId) {
  return (
    pickFirstNonEmptyString([
      rawItem?.versionId,
      rawItem?.fileVersionId,
      rawItem?.latestVersionId,
      rawItem?.version?.id,
      rawItem?.version,
    ]) || fallbackFileId
  );
}

/*
Purpose:
Create human-readable item name from payload while preserving resilience when
name field is missing.

Parameters:
rawItem (object) - one folder-item payload entry
entryId (string) - already normalized item id

Returns:
string - display name

Possible side effects:
None
*/
function readEntryName(rawItem, entryId) {
  const explicitName = pickFirstNonEmptyString([
    rawItem?.name,
    rawItem?.title,
    rawItem?.fileName,
    rawItem?.displayName,
  ]);

  if (isNonEmptyString(explicitName)) {
    return explicitName;
  }

  if (isNonEmptyString(entryId)) {
    return `Unnamed item (${entryId})`;
  }

  return "Unnamed item";
}

/*
Purpose:
Build nested path text for files while traversing the folder tree so duplicate
file names still have deterministic ordering context.

Parameters:
parentPath (string) - parent folder path text
entryName (string) - current item name

Returns:
string - joined path text

Possible side effects:
None
*/
function buildChildPath(parentPath, entryName) {
  if (!isNonEmptyString(parentPath)) {
    return entryName;
  }

  return `${parentPath}/${entryName}`;
}

/*
Purpose:
Traverse project folder hierarchy and collect all file entries through one
breadth-first walk.

Logic:
- Start from resolved root folder id.
- Load folder items.
- Queue child folders.
- Store non-folder entries as files.

Parameters:
coreApiBaseUrl (string) - active Core API base URL
accessToken (string) - bearer token
rootFolderId (string) - root folder id used as traversal start point

Returns:
Promise<Array<{fileId: string, folderId: string, versionId: string, name: string, path: string}>> - collected file list

Possible side effects:
- Executes multiple network requests while traversing folder hierarchy.
*/
async function collectFilesFromProjectTree(coreApiBaseUrl, accessToken, rootFolderId) {
  const folderQueue = [{ folderId: rootFolderId, parentPath: "" }];
  const visitedFolderIds = new Set();
  const discoveredFiles = [];

  while (folderQueue.length > 0) {
    const currentFolder = folderQueue.shift();
    if (!currentFolder || !isNonEmptyString(currentFolder.folderId)) {
      continue;
    }

    if (visitedFolderIds.has(currentFolder.folderId)) {
      continue;
    }

    visitedFolderIds.add(currentFolder.folderId);

    const folderItems = await loadFolderItems(coreApiBaseUrl, currentFolder.folderId, accessToken);
    folderItems.forEach((rawItem) => {
      const entryId = readEntryId(rawItem);
      const entryName = readEntryName(rawItem, entryId);
      const entryPath = buildChildPath(currentFolder.parentPath, entryName);

      if (isFolderEntry(rawItem)) {
        if (isNonEmptyString(entryId)) {
          folderQueue.push({
            folderId: entryId,
            parentPath: entryPath,
          });
        }
        return;
      }

      const fileId = entryId || `${currentFolder.folderId}:${entryName}`;
      const versionId = readEntryVersionId(rawItem, fileId);
      discoveredFiles.push({
        fileId,
        folderId: currentFolder.folderId,
        versionId,
        name: entryName,
        path: entryPath,
      });
    });
  }

  return discoveredFiles;
}

/*
Purpose:
Apply IFC file-name filter in one shared helper so every render and load phase
follows the same extension policy.

Logic:
File is accepted only when its name ends with `.ifc` in case-insensitive form.
This covers both `.ifc` and `.IFC` and avoids missing mixed-case variants.

Parameters:
fileName (string) - file name candidate

Returns:
boolean - true when file name matches IFC extension rule

Possible side effects:
None
*/
function isIfcFileName(fileName) {
  if (!isNonEmptyString(fileName)) {
    return false;
  }

  return fileName.trim().toLowerCase().endsWith(".ifc");
}

/*
Purpose:
Build one stable row key for table selection state so selected radio can be
restored after re-render when same file still exists in the filtered result.

Parameters:
fileEntry (object) - normalized file entry rendered in table

Returns:
string - deterministic row key

Possible side effects:
None
*/
function buildFileRowKey(fileEntry) {
  return `${fileEntry?.fileId || ""}::${fileEntry?.versionId || ""}::${fileEntry?.folderId || ""}::${fileEntry?.name || ""}`;
}

/*
Purpose:
Load project files with regional host fallback so extension remains usable when
first Core API host candidate does not match active project environment.

Parameters:
accessToken (string) - bearer token
projectId (string) - current project id
preferredRootFolderId (string) - root folder candidate from Workspace API

Returns:
Promise<{ fileEntries: Array<{fileId: string, folderId: string, versionId: string, name: string, path: string}>, coreApiBaseUrl: string }> - files plus active API host

Possible side effects:
- Executes network requests against one or more Core API hosts.
*/
async function loadProjectFiles(accessToken, projectId, preferredRootFolderId) {
  const coreApiBaseUrlCandidates = buildCoreApiBaseUrlCandidates();
  const failedAttempts = [];

  for (const coreApiBaseUrl of coreApiBaseUrlCandidates) {
    try {
      const resolvedRootFolderId = await resolveProjectRootFolderId(
        coreApiBaseUrl,
        accessToken,
        projectId,
        preferredRootFolderId,
      );

      const collectedFiles = await collectFilesFromProjectTree(coreApiBaseUrl, accessToken, resolvedRootFolderId);
      return {
        fileEntries: collectedFiles.filter((fileEntry) => isIfcFileName(fileEntry.name)),
        coreApiBaseUrl,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      failedAttempts.push(`${coreApiBaseUrl}: ${errorMessage}`);
    }
  }

  throw new Error(`Project file listing failed for all API hosts. ${failedAttempts.join(" | ")}`);
}

/*
Purpose:
Request signed download URL for one selected IFC file using Core API endpoint
that requires both file id and version id.

Parameters:
coreApiBaseUrl (string) - active Core API base URL
accessToken (string) - bearer token
fileId (string) - selected file id
versionId (string) - selected file version id

Returns:
Promise<string> - signed binary download URL

Possible side effects:
- Executes network request to Core API endpoint.
*/
async function requestSignedDownloadUrl(coreApiBaseUrl, accessToken, fileId, versionId) {
  const downloadUrlEndpoint = `${coreApiBaseUrl}/files/fs/${encodeURIComponent(fileId)}/downloadurl?versionId=${encodeURIComponent(versionId)}`;
  const responsePayload = await loadJsonFromCoreApi(downloadUrlEndpoint, accessToken);
  const signedDownloadUrl = pickFirstNonEmptyString([responsePayload?.url, responsePayload?.downloadUrl]);

  if (!isNonEmptyString(signedDownloadUrl)) {
    throw new Error("Download URL endpoint did not return a usable signed URL.");
  }

  return signedDownloadUrl;
}

/*
Purpose:
Download IFC bytes from signed URL and keep the resulting ArrayBuffer in
runtime memory for later parsing/validation steps.

Parameters:
signedDownloadUrl (string) - signed binary download URL
selectedFileEntry (object) - selected file metadata

Returns:
Promise<ArrayBuffer> - downloaded IFC bytes

Possible side effects:
- Executes binary fetch request.
- Stores downloaded buffer into runtime state.
*/
async function downloadIfcToBrowserMemory(signedDownloadUrl, selectedFileEntry) {
  const downloadResponse = await fetch(signedDownloadUrl, {
    method: "GET",
  });

  if (!downloadResponse.ok) {
    throw new Error(`Signed file download failed with status ${downloadResponse.status}.`);
  }

  const downloadedBuffer = await downloadResponse.arrayBuffer();
  runtimeState.downloadedIfcFile = {
    fileId: selectedFileEntry.fileId,
    folderId: selectedFileEntry.folderId,
    versionId: selectedFileEntry.versionId,
    name: selectedFileEntry.name,
    path: selectedFileEntry.path,
    byteLength: downloadedBuffer.byteLength,
    downloadedAt: new Date().toISOString(),
    buffer: downloadedBuffer,
  };

  return downloadedBuffer;
}

/*
Purpose:
Mark checker execution as running or idle so UI actions can be gated while
heavy IFC parsing and rule evaluation are in progress.

Parameters:
isRunning (boolean) - true while checker run is active

Returns:
void

Possible side effects:
- Updates checker running flag in runtime state.
- Updates action-button enabled states.
*/
function setCheckerRunningState(isRunning) {
  runtimeState.isRunningCheck = Boolean(isRunning);
  updateRefreshButtonState();
  updateDownloadButtonState();
  updateEditCheckSettingsButtonState();
  updateClearModelButtonState();
  updateReportExportActionButtonState();
}

/*
Purpose:
Expand or collapse the file-browser area that contains project file listing
and IFC selection controls.

Parameters:
isExpanded (boolean) - true to open browser section, false to collapse

Returns:
void

Possible side effects:
- Updates `open` state of file browser details element.
*/
function setFileBrowserExpanded(isExpanded) {
  if (!ui.fileBrowserSection) {
    return;
  }

  ui.fileBrowserSection.open = Boolean(isExpanded);
}

/*
Purpose:
Emit one application-level event when IFC file bytes are fully downloaded to
memory so checker workflow can start through event-driven orchestration.

Parameters:
downloadedIfcFile (object) - in-memory IFC payload + metadata

Returns:
void

Possible side effects:
- Dispatches custom DOM event to window listeners.
*/
function dispatchIfcFileDownloadedEvent(downloadedIfcFile) {
  window.dispatchEvent(
    new CustomEvent(IFC_FILE_DOWNLOADED_EVENT, {
      detail: {
        downloadedIfcFile,
      },
    }),
  );
}

/*
Purpose:
Run checker pipeline using already-downloaded in-memory IFC bytes so no second
network download is needed before validation.

Logic:
- Ensure runtime and rule dataset are ready.
- Validate payload readability.
- Parse IFC model to checker input shape.
- Execute rule checks and render summary + findings.

Parameters:
downloadedIfcFile (object) - downloaded IFC metadata and ArrayBuffer payload

Returns:
Promise<void>

Possible side effects:
- Executes CPU-heavy web-ifc parsing and rule engine evaluation.
- Updates report summary and findings UI.
- Updates status labels and extension status message.
*/
async function runModelCheckFromDownloadedFile(downloadedIfcFile) {
  if (!downloadedIfcFile || !(downloadedIfcFile.buffer instanceof ArrayBuffer)) {
    setStatus("Downloaded IFC payload was missing, so check could not start.", "error");
    return;
  }

  if (runtimeState.isRunningCheck) {
    setStatus("Checker run is already in progress.", "warning");
    return;
  }

  setCheckerRunningState(true);
  runtimeState.latestCheckResult = null;
  updateReportExportActionButtonState();

  try {
    setFileBrowserExpanded(false);
    clearRenderedReport(ui.reportSummary, ui.reportList);
    ui.reportSummary?.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Preparing checker runtime for ${downloadedIfcFile.name}...`, "info");
    await getInitializedWebIfcRuntime();

    if (!runtimeState.originalRuleDataset) {
      setStatus("Loading checker rule dataset...", "info");
      runtimeState.originalRuleDataset = await loadOriginalRuleDataset();
    }
    ensureCheckExecutionOptionsInitialized(runtimeState.originalRuleDataset);

    setStatus("Validating in-memory IFC payload...", "info");
    await verifyIfcModelReadable(downloadedIfcFile.buffer);

    setStatus("Parsing IFC model for checking...", "info");
    const parsedModel = await parseIfcModelForChecking(downloadedIfcFile.buffer, runtimeState.originalRuleDataset);

    setStatus("Running rule checks...", "info");
    const checkResult = runModelChecks(
      parsedModel,
      runtimeState.originalRuleDataset,
      runtimeState.checkExecutionOptions || null,
    );
    runtimeState.latestCheckResult = checkResult;

    const showWarningsInResultView = checkResult?.executionProfile?.display?.showWarnings !== false;
    renderReportSummary(ui.reportSummary, checkResult.summary, {
      showWarnings: showWarningsInResultView,
    });
    renderReportFindings(ui.reportList, checkResult);

    const successMessage = showWarningsInResultView
      ? `Check completed for ${downloadedIfcFile.name}. Errors: ${checkResult.summary.errorCount}, warnings: ${checkResult.summary.warningCount}.`
      : `Check completed for ${downloadedIfcFile.name}. Errors: ${checkResult.summary.errorCount}.`;
    setStatus(successMessage, "success");

    if (runtimeState.workspaceApi?.extension && typeof runtimeState.workspaceApi.extension.setStatusMessage === "function") {
      await runtimeState.workspaceApi.extension.setStatusMessage(successMessage);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Check failed: ${errorMessage}`, "error");
  } finally {
    setCheckerRunningState(false);
  }
}

/*
Purpose:
React to in-memory IFC download completion event and immediately start checker
workflow against the downloaded payload.

Parameters:
event (CustomEvent) - download completion event object

Returns:
Promise<void>

Possible side effects:
- Starts asynchronous checker execution.
*/
async function handleIfcFileDownloadedEvent(event) {
  const downloadedIfcFile = event?.detail?.downloadedIfcFile || null;
  await runModelCheckFromDownloadedFile(downloadedIfcFile);
}

/*
Purpose:
Clear currently loaded IFC model from memory and reset report state so user is
returned to file-selection workflow before starting a new check.

Logic:
- Drop downloaded ArrayBuffer and selected file row state.
- Clear rendered report content.
- Re-open file-browser section.
- Re-render file table so selection and action buttons reset visibly.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Clears in-memory downloaded IFC payload.
- Resets checker report UI.
- Updates status and extension host status text.
*/
async function clearLoadedModelAndResetWorkflow() {
  if (
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics
  ) {
    setStatus("Wait until current operation finishes before clearing model.", "warning");
    return;
  }

  runtimeState.downloadedIfcFile = null;
  runtimeState.latestCheckResult = null;
  setSelectedFileEntry(null);

  clearRenderedReport(ui.reportSummary, ui.reportList);
  renderFileTable(runtimeState.latestIfcFileEntries);
  setFileBrowserExpanded(true);
  ui.fileBrowserSection?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!Array.isArray(runtimeState.latestIfcFileEntries) || runtimeState.latestIfcFileEntries.length === 0) {
    await loadAndRenderProjectFiles();
  } else {
    setStatus("Loaded model was cleared from memory. Select file and run download again.", "info");

    if (runtimeState.workspaceApi?.extension && typeof runtimeState.workspaceApi.extension.setStatusMessage === "function") {
      await runtimeState.workspaceApi.extension.setStatusMessage("Loaded model cleared from memory.");
    }
  }

  updateClearModelButtonState();
  updateEditCheckSettingsButtonState();
  updateReportExportActionButtonState();
}

/*
Purpose:
Allow user to adjust check-selection options after IFC file has already been
downloaded, and immediately re-run checks against the same in-memory model.

Logic:
- Keep the downloaded ArrayBuffer untouched in runtime memory.
- Open the same check-selection modal used before download.
- Persist selected options when user confirms.
- Trigger checker run again with updated options and existing memory payload.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Opens check-selection modal.
- Updates runtime check execution options.
- Triggers new checker run against already loaded model.
*/
async function editCheckSettingsForLoadedModel() {
  if (
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics
  ) {
    setStatus("Wait until current operation finishes before editing check settings.", "warning");
    return;
  }

  if (!runtimeState.downloadedIfcFile || !(runtimeState.downloadedIfcFile.buffer instanceof ArrayBuffer)) {
    setStatus("Load one IFC model to memory before editing check settings.", "warning");
    return;
  }

  try {
    if (!runtimeState.originalRuleDataset) {
      setStatus("Loading checker rule dataset...", "info");
      runtimeState.originalRuleDataset = await loadOriginalRuleDataset();
    }

    const selectedExecutionOptions = await openCheckSelectionModal(runtimeState.originalRuleDataset);
    if (!selectedExecutionOptions) {
      setStatus("Check settings edit was cancelled.", "info");
      return;
    }

    runtimeState.checkExecutionOptions = selectedExecutionOptions;
    const selectionSummary = summarizeCheckExecutionOptions(runtimeState.originalRuleDataset, runtimeState.checkExecutionOptions);
    setStatus(`Check settings updated. ${selectionSummary}`, "info");

    await runModelCheckFromDownloadedFile(runtimeState.downloadedIfcFile);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Updating check settings failed: ${errorMessage}`, "error");
  } finally {
    updateEditCheckSettingsButtonState();
  }
}

/*
Purpose:
Build one normalized project context payload for report exports so every export
contains stable project identifiers even when fields are partially missing.

Parameters:
None

Returns:
{ id: string, name: string } - current project context

Possible side effects:
None
*/
function buildCurrentProjectContextForExport() {
  return {
    id: runtimeState.currentProjectId || "",
    name: runtimeState.currentProjectName || "",
  };
}

/*
Purpose:
Collect unique non-empty string values from array-like payload so extension
option parsing remains stable even when API returns duplicate or blank entries.

Parameters:
valueCandidates (unknown) - candidate array payload

Returns:
Array<string> - unique normalized values

Possible side effects:
None
*/
function collectUniqueTrimmedStringValues(valueCandidates) {
  if (!Array.isArray(valueCandidates)) {
    return [];
  }

  const normalizedValues = valueCandidates
    .map((candidateValue) => String(candidateValue || "").trim())
    .filter((candidateValue) => candidateValue !== "");

  return Array.from(new Set(normalizedValues));
}

/*
Purpose:
Select the best option from extension values by checking preferred keywords
before falling back to the first available option.

Parameters:
optionValues (Array<string>) - extension option values
preferredKeywords (Array<string>) - case-insensitive keyword priorities

Returns:
string - selected option value or empty string when list is empty

Possible side effects:
None
*/
function selectPreferredExtensionOptionValue(optionValues, preferredKeywords) {
  const normalizedOptions = collectUniqueTrimmedStringValues(optionValues);
  const normalizedKeywords = collectUniqueTrimmedStringValues(preferredKeywords).map((keyword) => keyword.toLowerCase());

  for (const preferredKeyword of normalizedKeywords) {
    const matchedOption = normalizedOptions.find((optionValue) => optionValue.toLowerCase().includes(preferredKeyword));
    if (matchedOption) {
      return matchedOption;
    }
  }

  return normalizedOptions[0] || "";
}

/*
Purpose:
Resolve exact extension option value using case-insensitive full-string matching.
This is used when a required value has stable spelling but project extension
payload can vary by letter casing.

Parameters:
optionValues (Array<string>) - extension option values
targetValue (string) - desired value that should match exactly ignoring case

Returns:
string - matched option preserving original extension casing, or empty string

Possible side effects:
None
*/
function findExtensionOptionValueByCaseInsensitiveExactMatch(optionValues, targetValue) {
  const normalizedOptions = collectUniqueTrimmedStringValues(optionValues);
  const normalizedTargetValue = String(targetValue || "").trim().toLowerCase();
  if (!normalizedTargetValue) {
    return "";
  }

  return (
    normalizedOptions.find((optionValue) => optionValue.toLowerCase() === normalizedTargetValue) || ""
  );
}

/*
Purpose:
Build normalized option payload from Topics API extensions response so BCF topic
creation modal can offer valid project-specific select lists.

Parameters:
extensionPayload (unknown) - parsed project extensions payload

Returns:
{
  topicTypes: Array<string>,
  topicStatuses: Array<string>,
  priorities: Array<string>,
  stages: Array<string>,
  topicLabels: Array<string>,
  projectActions: Array<string>,
  topicActions: Array<string>,
  defaultTopicType: string,
  defaultTopicStatus: string,
  defaultPriority: string,
  requiredTopicLabel: string,
  defaultTopicLabel: string
}

Possible side effects:
None
*/
function buildBcfProjectExtensionOptions(extensionPayload) {
  const topicTypes = collectUniqueTrimmedStringValues(extensionPayload?.topic_type);
  const topicStatuses = collectUniqueTrimmedStringValues(extensionPayload?.topic_status);
  const priorities = collectUniqueTrimmedStringValues(extensionPayload?.priority);
  const stages = collectUniqueTrimmedStringValues(extensionPayload?.stage);
  const topicLabels = collectUniqueTrimmedStringValues(extensionPayload?.topic_label);
  const projectActions = collectUniqueTrimmedStringValues(extensionPayload?.project_actions);
  const topicActions = collectUniqueTrimmedStringValues(extensionPayload?.topic_actions);

  const defaultTopicType = selectPreferredExtensionOptionValue(topicTypes, ["error", "warning", "issue", "clash", "information"]);
  const defaultTopicStatus = selectPreferredExtensionOptionValue(topicStatuses, ["open", "reopened", "in progress"]);
  const defaultPriority = selectPreferredExtensionOptionValue(priorities, ["high", "medium", "low"]);
  const requiredTopicLabel = findExtensionOptionValueByCaseInsensitiveExactMatch(topicLabels, IFC_CHECKER_TOPIC_LABEL);
  const defaultTopicLabel = requiredTopicLabel || selectPreferredExtensionOptionValue(topicLabels, ["issue"]);

  return {
    topicTypes,
    topicStatuses,
    priorities,
    stages,
    topicLabels,
    projectActions,
    topicActions,
    defaultTopicType,
    defaultTopicStatus,
    defaultPriority,
    requiredTopicLabel,
    defaultTopicLabel,
  };
}

/*
Purpose:
Normalize optional placement-point payload into stable XYZ object so marker and
camera creation logic can trust numeric coordinates.

Parameters:
placementPointCandidate (unknown) - placement point candidate

Returns:
{ x: number, y: number, z: number } | null - normalized point or null when invalid

Possible side effects:
None
*/
function normalizeBcfPlacementPoint(placementPointCandidate) {
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
Normalize IFC length-unit conversion factor into safe positive number so BCF
payload builders can convert model coordinates into meters consistently.

Logic:
- Accept only finite positive numeric values.
- Fallback to explicit default when model context does not expose unit metadata.

Parameters:
lengthUnitToMetersCandidate (unknown) - candidate unit conversion value
fallbackValue (number) - fallback conversion value when candidate is invalid

Returns:
number - normalized meters-per-model-unit scale

Possible side effects:
None
*/
function normalizeBcfLengthUnitToMeters(lengthUnitToMetersCandidate, fallbackValue = DEFAULT_BCF_LENGTH_UNIT_TO_METERS) {
  const normalizedFallbackValue = Number(fallbackValue);
  const normalizedCandidateValue = Number(lengthUnitToMetersCandidate);

  if (Number.isFinite(normalizedCandidateValue) && normalizedCandidateValue > 0) {
    return normalizedCandidateValue;
  }

  if (Number.isFinite(normalizedFallbackValue) && normalizedFallbackValue > 0) {
    return normalizedFallbackValue;
  }

  return 1;
}

/*
Purpose:
Resolve BCF coordinate scale from latest checker result model metadata so camera
and marker coordinates can be sent in meters expected by Topics API payloads.

Parameters:
latestCheckResult (object | null) - latest checker result payload

Returns:
number - meters-per-model-unit scale used by BCF payload builders

Possible side effects:
None
*/
function resolveBcfLengthUnitToMetersFromCheckResult(latestCheckResult) {
  return normalizeBcfLengthUnitToMeters(latestCheckResult?.modelContext?.ifcLengthUnitToMeters);
}

/*
Purpose:
Convert normalized placement point from model units into BCF meter coordinates
so Topics API marker/camera payloads align with Connect viewpoint expectations.

Parameters:
placementPointCandidate (unknown) - placement point in model units
lengthUnitToMetersCandidate (unknown) - meters-per-model-unit conversion scale

Returns:
{ x: number, y: number, z: number } | null - placement point converted to meters

Possible side effects:
None
*/
function convertPlacementPointToBcfMeters(placementPointCandidate, lengthUnitToMetersCandidate) {
  const normalizedPoint = normalizeBcfPlacementPoint(placementPointCandidate);
  if (!normalizedPoint) {
    return null;
  }

  const lengthUnitToMeters = normalizeBcfLengthUnitToMeters(lengthUnitToMetersCandidate);
  return {
    x: normalizedPoint.x * lengthUnitToMeters,
    y: normalizedPoint.y * lengthUnitToMeters,
    z: normalizedPoint.z * lengthUnitToMeters,
  };
}

/*
Purpose:
Pick default topic type value for one selected issue row so error/warning rows
map to matching type names whenever project extension values support them.

Parameters:
issueSeverity (string) - issue severity ("error" | "warning")
extensionOptions (object) - normalized extension options

Returns:
string - default topic type for this row

Possible side effects:
None
*/
function buildDefaultTopicTypeForIssue(issueSeverity, extensionOptions) {
  const normalizedSeverity = String(issueSeverity || "").trim().toLowerCase();
  if (normalizedSeverity === "error") {
    const errorType = selectPreferredExtensionOptionValue(extensionOptions?.topicTypes || [], ["error", "issue", "clash"]);
    return errorType || extensionOptions?.defaultTopicType || "Error";
  }

  const warningType = selectPreferredExtensionOptionValue(extensionOptions?.topicTypes || [], ["warning", "information", "issue"]);
  return warningType || extensionOptions?.defaultTopicType || "Warning";
}

/*
Purpose:
Create deterministic default topic title for selected issue row so modal opens
with informative text and user can quickly adjust titles when needed.

Parameters:
issueRow (object) - normalized issue row

Returns:
string - default topic title

Possible side effects:
None
*/
function buildDefaultBcfTopicTitle(issueRow) {
  const severityLabel = String(issueRow?.severity || "warning")
    .trim()
    .toUpperCase();
  const objectName = String(issueRow?.objectName || "Unnamed object").trim();
  return `${severityLabel} - ${objectName}`;
}

/*
Purpose:
Format placement point for modal metadata display so users can verify whether
camera estimation can use coordinate data for each selected issue.

Parameters:
placementPoint (object | null) - normalized placement point

Returns:
string - human-readable coordinate text

Possible side effects:
None
*/
function formatPlacementPointForModal(placementPoint) {
  const normalizedPoint = normalizeBcfPlacementPoint(placementPoint);
  if (!normalizedPoint) {
    return "not available";
  }

  return `${normalizedPoint.x.toFixed(3)}, ${normalizedPoint.y.toFixed(3)}, ${normalizedPoint.z.toFixed(3)}`;
}

/*
Purpose:
Render select-option markup from dynamic value list while preserving selected
state and optional empty placeholder row.

Parameters:
optionValues (Array<string>) - option values
selectedValue (string) - selected value
includeEmptyOption (boolean) - true when empty placeholder should be rendered
emptyOptionLabel (string) - empty placeholder text

Returns:
string - rendered option markup

Possible side effects:
None
*/
function buildSelectOptionMarkup(optionValues, selectedValue, includeEmptyOption = false, emptyOptionLabel = "Not set") {
  const normalizedOptions = collectUniqueTrimmedStringValues(optionValues);
  const normalizedSelectedValue = String(selectedValue || "").trim();
  if (normalizedSelectedValue && !normalizedOptions.includes(normalizedSelectedValue)) {
    normalizedOptions.unshift(normalizedSelectedValue);
  }

  const optionMarkup = normalizedOptions
    .map((optionValue) => {
      const selectedAttribute = optionValue === normalizedSelectedValue ? " selected" : "";
      return `<option value="${escapeHtml(optionValue)}"${selectedAttribute}>${escapeHtml(optionValue)}</option>`;
    })
    .join("");

  if (!includeEmptyOption) {
    return optionMarkup;
  }

  const emptySelectedAttribute = normalizedSelectedValue === "" ? " selected" : "";
  return `<option value=""${emptySelectedAttribute}>${escapeHtml(emptyOptionLabel)}</option>${optionMarkup}`;
}

/*
Purpose:
Render full BCF creation modal content with generic topic settings and one
editable row per selected issue.

Parameters:
issueRows (Array<object>) - selected issue rows
extensionOptions (object) - normalized extension options

Returns:
string - modal content markup

Possible side effects:
None
*/
function renderBcfTopicCreationModalContent(issueRows, extensionOptions) {
  const normalizedIssueRows = Array.isArray(issueRows) ? issueRows : [];
  const normalizedExtensionOptions = extensionOptions || {};
  const defaultStatusValue = normalizedExtensionOptions.defaultTopicStatus || "Open";
  const defaultPriorityValue = normalizedExtensionOptions.defaultPriority || "Medium";
  const defaultLabels = collectUniqueTrimmedStringValues([normalizedExtensionOptions.defaultTopicLabel]);

  const labelsMarkup = normalizedExtensionOptions.topicLabels?.length
    ? normalizedExtensionOptions.topicLabels
        .map((labelValue) => {
          const isChecked = defaultLabels.includes(labelValue);
          const checkedAttribute = isChecked ? " checked" : "";
          return `
            <label class="bcf-create-chip-option">
              <input type="checkbox" data-bcf-generic-label-option="true" value="${escapeHtml(labelValue)}"${checkedAttribute} />
              <span>${escapeHtml(labelValue)}</span>
            </label>
          `;
        })
        .join("")
    : `<p class="bcf-create-helper-text">Project extensions did not provide label options.</p>`;

  const topicRowsMarkup = normalizedIssueRows
    .map((issueRow, issueIndex) => {
      const normalizedPlacementPoint = normalizeBcfPlacementPoint(issueRow?.placementPoint);
      const defaultTopicType = buildDefaultTopicTypeForIssue(issueRow?.severity, normalizedExtensionOptions);
      const topicTypeOptions = collectUniqueTrimmedStringValues([defaultTopicType, ...(normalizedExtensionOptions.topicTypes || [])]);
      const defaultTitle = buildDefaultBcfTopicTitle(issueRow);
      const defaultDescription = String(issueRow?.message || "").trim();
      const severityLabel = String(issueRow?.severity || "warning").toLowerCase() === "error" ? "Error" : "Warning";

      return `
        <article class="bcf-create-topic-row" data-bcf-topic-row-index="${issueIndex}">
          <div class="bcf-create-topic-row-header">
            <label class="bcf-create-topic-enable">
              <input type="checkbox" data-bcf-topic-field="include" checked />
              <span>Create topic</span>
            </label>
            <span class="bcf-create-topic-severity severity-${escapeHtml(severityLabel.toLowerCase())}">${escapeHtml(severityLabel)}</span>
          </div>
          <div class="bcf-create-topic-meta">
            <span><strong>Object:</strong> ${escapeHtml(issueRow?.objectName || "Unnamed")}</span>
            <span><strong>IFC GUID:</strong> ${escapeHtml(issueRow?.globalId || "-")}</span>
            <span><strong>IFC type:</strong> ${escapeHtml(issueRow?.ifcEntity || "-")}</span>
            <span><strong>ExpressId:</strong> ${escapeHtml(issueRow?.expressId ?? "-")}</span>
            <span><strong>Placement:</strong> ${escapeHtml(formatPlacementPointForModal(normalizedPlacementPoint))}</span>
          </div>
          <div class="bcf-create-topic-grid">
            <label class="bcf-create-field">
              <span>Topic type</span>
              <select data-bcf-topic-field="topic-type">
                ${buildSelectOptionMarkup(topicTypeOptions, defaultTopicType, true, "Not set")}
              </select>
            </label>
            <label class="bcf-create-field bcf-create-field-wide">
              <span>Title</span>
              <input type="text" data-bcf-topic-field="title" value="${escapeHtml(defaultTitle)}" maxlength="180" />
            </label>
            <label class="bcf-create-field bcf-create-field-wide">
              <span>Description</span>
              <textarea data-bcf-topic-field="description" rows="3">${escapeHtml(defaultDescription)}</textarea>
            </label>
          </div>
        </article>
      `;
    })
    .join("");

  return `
    <div class="bcf-create-layout">
      <section class="bcf-create-generic-panel">
        <h4 class="bcf-create-panel-title">Generic topic settings</h4>
        <div class="bcf-create-generic-grid">
          <label class="bcf-create-field">
            <span>Topic status</span>
            <select data-bcf-generic-field="topic-status">
              ${buildSelectOptionMarkup(normalizedExtensionOptions.topicStatuses || [], defaultStatusValue, true, "Not set")}
            </select>
          </label>
          <label class="bcf-create-field">
            <span>Priority</span>
            <select data-bcf-generic-field="priority">
              ${buildSelectOptionMarkup(normalizedExtensionOptions.priorities || [], defaultPriorityValue, true, "Not set")}
            </select>
          </label>
          <label class="bcf-create-field">
            <span>Stage</span>
            <select data-bcf-generic-field="stage">
              ${buildSelectOptionMarkup(normalizedExtensionOptions.stages || [], "", true, "Not set")}
            </select>
          </label>
          <label class="bcf-create-field">
            <span>Due date</span>
            <input type="date" data-bcf-generic-field="due-date" />
          </label>
          <label class="bcf-create-field bcf-create-field-wide">
            <span>Reference links (one URL per line)</span>
            <textarea data-bcf-generic-field="reference-links" rows="2" placeholder="https://example.com/specification"></textarea>
          </label>
        </div>
        <div class="bcf-create-label-options">
          <h5 class="bcf-create-subheading">Project labels</h5>
          <div class="bcf-create-chip-list">
            ${labelsMarkup}
          </div>
        </div>
        <div class="bcf-create-toggle-list">
          <label class="bcf-create-toggle-option">
            <input type="checkbox" data-bcf-generic-field="create-viewpoints" checked />
            <span>Create a viewpoint for each topic (IFC GUID selection included)</span>
          </label>
          <label class="bcf-create-toggle-option">
            <input type="checkbox" data-bcf-generic-field="use-placement-camera" checked />
            <span>Use web-ifc placement coordinates to estimate camera</span>
          </label>
        </div>
      </section>
      <section class="bcf-create-topic-panel">
        <h4 class="bcf-create-panel-title">Per-topic settings (${normalizedIssueRows.length})</h4>
        <div class="bcf-create-topic-list">
          ${topicRowsMarkup}
        </div>
      </section>
    </div>
  `;
}

/*
Purpose:
Parse text input where values are separated by commas and/or line breaks so
modal fields can support both quick typing and pasted multiline lists.

Parameters:
rawText (unknown) - source text input

Returns:
Array<string> - normalized unique values

Possible side effects:
None
*/
function parseDelimitedTextValues(rawText) {
  const normalizedText = String(rawText || "");
  const splitValues = normalizedText
    .split(/[\n,]+/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");

  return Array.from(new Set(splitValues));
}

/*
Purpose:
Open a small informational modal for BCF flow warnings (for example when no
errors/warnings are selected) so user gets clear guidance in popup form.

Parameters:
messageText (string) - message shown in modal body

Returns:
Promise<void>

Possible side effects:
- Opens and closes BCF modal shell.
- Temporarily binds modal interaction handlers.
*/
function openBcfInformationModal(messageText) {
  return new Promise((resolvePromise) => {
    if (!ui.bcfCreateModal || !ui.bcfCreateDialog || !ui.bcfCreateTitle || !ui.bcfCreateSubtitle || !ui.bcfCreateContent) {
      setStatus(messageText, "warning");
      resolvePromise();
      return;
    }

    const setModalMessage = () => {
      if (ui.bcfCreateTitle) {
        ui.bcfCreateTitle.textContent = "Create BCF topics";
      }
      if (ui.bcfCreateSubtitle) {
        ui.bcfCreateSubtitle.textContent = "No findings selected";
      }
      if (ui.bcfCreateMessage) {
        ui.bcfCreateMessage.hidden = false;
        ui.bcfCreateMessage.className = "bcf-create-message severity-warning";
        ui.bcfCreateMessage.textContent = String(messageText || "");
      }
      ui.bcfCreateContent.innerHTML = "";
    };

    const cleanupAndResolve = () => {
      ui.bcfCreateModal.hidden = true;
      document.body.classList.remove("modal-open");

      ui.bcfCreateCloseButton?.removeEventListener("click", handleClose);
      ui.bcfCreateConfirmButton?.removeEventListener("click", handleClose);
      ui.bcfCreateModal.removeEventListener("click", handleBackdropClick);
      ui.bcfCreateModal.removeEventListener("keydown", handleModalKeydown);

      if (ui.bcfCreateCancelButton) {
        ui.bcfCreateCancelButton.hidden = false;
      }
      resolvePromise();
    };

    const handleClose = () => {
      cleanupAndResolve();
    };

    const handleBackdropClick = (clickEvent) => {
      if (clickEvent.target === ui.bcfCreateModal) {
        cleanupAndResolve();
      }
    };

    const handleModalKeydown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape" || keyboardEvent.key === "Enter") {
        keyboardEvent.preventDefault();
        cleanupAndResolve();
      }
    };

    if (ui.bcfCreateCancelButton) {
      ui.bcfCreateCancelButton.hidden = true;
    }
    if (ui.bcfCreateConfirmButton) {
      ui.bcfCreateConfirmButton.textContent = "OK";
    }

    setModalMessage();
    ui.bcfCreateModal.hidden = false;
    document.body.classList.add("modal-open");
    ui.bcfCreateDialog.focus();

    ui.bcfCreateCloseButton?.addEventListener("click", handleClose);
    ui.bcfCreateConfirmButton?.addEventListener("click", handleClose);
    ui.bcfCreateModal.addEventListener("click", handleBackdropClick);
    ui.bcfCreateModal.addEventListener("keydown", handleModalKeydown);
  });
}

/*
Purpose:
Open interactive BCF creation modal and return user-provided generic settings
plus per-topic overrides for selected issue rows.

Parameters:
issueRows (Array<object>) - selected issue rows
extensionOptions (object) - normalized extension options

Returns:
Promise<object | null> - creation request payload or null when cancelled

Possible side effects:
- Opens modal UI.
- Reads user-edited form values.
*/
function openBcfTopicCreationModal(issueRows, extensionOptions) {
  return new Promise((resolvePromise) => {
    if (!ui.bcfCreateModal || !ui.bcfCreateDialog || !ui.bcfCreateTitle || !ui.bcfCreateSubtitle || !ui.bcfCreateContent) {
      resolvePromise(null);
      return;
    }

    const normalizedIssueRows = Array.isArray(issueRows) ? issueRows : [];
    const normalizedExtensionOptions = extensionOptions || {};
    const renderModalContent = () => {
      ui.bcfCreateTitle.textContent = "Create BCF topics";
      ui.bcfCreateSubtitle.textContent = `Review generic and per-topic settings for ${normalizedIssueRows.length} selected finding(s).`;
      if (ui.bcfCreateMessage) {
        ui.bcfCreateMessage.hidden = true;
        ui.bcfCreateMessage.textContent = "";
      }
      ui.bcfCreateContent.innerHTML = renderBcfTopicCreationModalContent(normalizedIssueRows, normalizedExtensionOptions);
    };

    const setInlineMessage = (messageText, severity = "warning") => {
      if (!ui.bcfCreateMessage) {
        return;
      }
      ui.bcfCreateMessage.hidden = false;
      ui.bcfCreateMessage.className = `bcf-create-message severity-${severity}`;
      ui.bcfCreateMessage.textContent = messageText;
    };

    const cleanupAndResolve = (resolvedValue) => {
      ui.bcfCreateModal.hidden = true;
      document.body.classList.remove("modal-open");

      ui.bcfCreateCloseButton?.removeEventListener("click", handleCancel);
      ui.bcfCreateCancelButton?.removeEventListener("click", handleCancel);
      ui.bcfCreateConfirmButton?.removeEventListener("click", handleConfirm);
      ui.bcfCreateContent.removeEventListener("change", handleContentChange);
      ui.bcfCreateModal.removeEventListener("click", handleBackdropClick);
      ui.bcfCreateModal.removeEventListener("keydown", handleModalKeydown);
      if (ui.bcfCreateCancelButton) {
        ui.bcfCreateCancelButton.hidden = false;
      }

      resolvePromise(resolvedValue);
    };

    const handleCancel = () => {
      cleanupAndResolve(null);
    };

    const handleBackdropClick = (clickEvent) => {
      if (clickEvent.target === ui.bcfCreateModal) {
        cleanupAndResolve(null);
      }
    };

    const handleModalKeydown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        cleanupAndResolve(null);
      }
    };

    const handleContentChange = (changeEvent) => {
      const eventTarget = changeEvent.target;
      if (!(eventTarget instanceof HTMLInputElement)) {
        return;
      }

      if (eventTarget.getAttribute("data-bcf-generic-field") !== "create-viewpoints") {
        return;
      }

      const cameraToggle = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="use-placement-camera"]');
      if (!(cameraToggle instanceof HTMLInputElement)) {
        return;
      }

      cameraToggle.disabled = !eventTarget.checked;
      if (cameraToggle.disabled) {
        cameraToggle.checked = false;
      }
    };

    const handleConfirm = () => {
      const genericStatusSelect = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="topic-status"]');
      const genericPrioritySelect = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="priority"]');
      const genericStageSelect = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="stage"]');
      const genericDueDateInput = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="due-date"]');
      const genericReferenceLinksInput = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="reference-links"]');
      const createViewpointsToggle = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="create-viewpoints"]');
      const usePlacementCameraToggle = ui.bcfCreateContent.querySelector('[data-bcf-generic-field="use-placement-camera"]');
      const allowedProjectLabels = collectUniqueTrimmedStringValues(normalizedExtensionOptions.topicLabels || []);
      const requiredProjectLabel = findExtensionOptionValueByCaseInsensitiveExactMatch(
        allowedProjectLabels,
        normalizedExtensionOptions.requiredTopicLabel || IFC_CHECKER_TOPIC_LABEL,
      );

      const selectedProjectLabels = Array.from(
        ui.bcfCreateContent.querySelectorAll('[data-bcf-generic-label-option="true"]:checked'),
      )
        .map((selectedLabelElement) =>
          selectedLabelElement instanceof HTMLInputElement ? String(selectedLabelElement.value || "").trim() : "",
        )
        .filter(
          (selectedLabelValue) =>
            selectedLabelValue !== "" &&
            (allowedProjectLabels.length === 0 || allowedProjectLabels.includes(selectedLabelValue)),
        );
      const requiredLabels = requiredProjectLabel ? [requiredProjectLabel] : [];

      const selectedTopics = [];
      const topicRowElements = Array.from(ui.bcfCreateContent.querySelectorAll("[data-bcf-topic-row-index]"));
      topicRowElements.forEach((topicRowElement) => {
        const issueRowIndex = Number(topicRowElement.getAttribute("data-bcf-topic-row-index") || "-1");
        if (!Number.isInteger(issueRowIndex) || issueRowIndex < 0 || issueRowIndex >= normalizedIssueRows.length) {
          return;
        }

        const sourceIssueRow = normalizedIssueRows[issueRowIndex];
        const includeToggle = topicRowElement.querySelector('[data-bcf-topic-field="include"]');
        const includeTopic = includeToggle instanceof HTMLInputElement ? includeToggle.checked : false;
        if (!includeTopic) {
          return;
        }

        const topicTypeSelect = topicRowElement.querySelector('[data-bcf-topic-field="topic-type"]');
        const titleInput = topicRowElement.querySelector('[data-bcf-topic-field="title"]');
        const descriptionInput = topicRowElement.querySelector('[data-bcf-topic-field="description"]');

        const topicTypeValue = String(topicTypeSelect?.value || "").trim();
        const titleValue = String(titleInput?.value || "").trim();
        const descriptionValue = String(descriptionInput?.value || "").trim();
        if (!titleValue || !descriptionValue) {
          return;
        }

        selectedTopics.push({
          ...sourceIssueRow,
          topicType: topicTypeValue,
          title: titleValue,
          description: descriptionValue,
          placementPoint: normalizeBcfPlacementPoint(sourceIssueRow?.placementPoint),
        });
      });

      if (selectedTopics.length === 0) {
        setInlineMessage("Select at least one row with non-empty title and description before creating BCF topics.");
        return;
      }

      cleanupAndResolve({
        generic: {
          topicStatus: String(genericStatusSelect?.value || "").trim(),
          priority: String(genericPrioritySelect?.value || "").trim(),
          stage: String(genericStageSelect?.value || "").trim(),
          dueDate: String(genericDueDateInput?.value || "").trim(),
          labels: collectUniqueTrimmedStringValues([...selectedProjectLabels, ...requiredLabels]),
          referenceLinks: parseDelimitedTextValues(genericReferenceLinksInput?.value || ""),
          createViewpoints: createViewpointsToggle instanceof HTMLInputElement ? createViewpointsToggle.checked : false,
          usePlacementCamera: usePlacementCameraToggle instanceof HTMLInputElement ? usePlacementCameraToggle.checked : false,
        },
        topics: selectedTopics,
      });
    };

    renderModalContent();

    if (ui.bcfCreateConfirmButton) {
      ui.bcfCreateConfirmButton.textContent = "Create topics";
    }

    ui.bcfCreateModal.hidden = false;
    document.body.classList.add("modal-open");
    ui.bcfCreateDialog.focus();

    ui.bcfCreateCloseButton?.addEventListener("click", handleCancel);
    ui.bcfCreateCancelButton?.addEventListener("click", handleCancel);
    ui.bcfCreateConfirmButton?.addEventListener("click", handleConfirm);
    ui.bcfCreateContent.addEventListener("change", handleContentChange);
    ui.bcfCreateModal.addEventListener("click", handleBackdropClick);
    ui.bcfCreateModal.addEventListener("keydown", handleModalKeydown);
  });
}

/*
Purpose:
Extract readable error details from Topics API response payload so status text
can expose actionable backend diagnostics when request fails.

Parameters:
responsePayload (unknown) - parsed JSON payload

Returns:
string - normalized error message

Possible side effects:
None
*/
function parseTopicsApiErrorMessage(responsePayload) {
  if (!responsePayload || typeof responsePayload !== "object") {
    return "";
  }

  const payloadMessage = pickFirstNonEmptyString([
    responsePayload.message,
    responsePayload.error?.message,
    responsePayload.error_description,
    responsePayload.detail,
    responsePayload.title,
  ]);
  if (payloadMessage) {
    return payloadMessage;
  }

  if (Array.isArray(responsePayload.errors) && responsePayload.errors.length > 0) {
    const firstError = responsePayload.errors[0];
    const errorMessage = pickFirstNonEmptyString([
      firstError?.message,
      typeof firstError === "string" ? firstError : "",
    ]);
    if (errorMessage) {
      return errorMessage;
    }
  }

  return "";
}

/*
Purpose:
Perform one authorized Topics API request and parse JSON response with rich
error details so caller can decide whether fallback attempts are needed.

Parameters:
requestUrl (string) - absolute Topics API URL
accessToken (string) - bearer token
requestOptions (object) - method/body/media options
requestOptions.includeResponseMetadata (boolean) - return payload + selected response headers

Returns:
Promise<unknown | { payload: unknown, status: number, requestUrl: string, responseHeaders: { odataNextLink: string } }>
- Parsed payload (default), or payload + metadata when includeResponseMetadata=true.

Possible side effects:
- Executes HTTP request against Topics API.
*/
async function requestTopicsApiJson(
  requestUrl,
  accessToken,
  {
    method = "GET",
    requestBody = null,
    acceptMediaType = TOPICS_API_MEDIA_TYPE_BCF,
    contentMediaType = TOPICS_API_MEDIA_TYPE_BCF,
    includeResponseMetadata = false,
  } = {},
) {
  let response = null;

  try {
    const requestHeaders = {
      Accept: acceptMediaType,
      Authorization: `Bearer ${accessToken}`,
    };

    const requestInit = {
      method,
      headers: requestHeaders,
    };

    if (requestBody !== null && requestBody !== undefined) {
      requestHeaders["Content-Type"] = contentMediaType;
      requestInit.body = JSON.stringify(requestBody);
    }

    response = await fetch(requestUrl, requestInit);
  } catch (fetchError) {
    const networkError = new Error(`Topics API request failed before response: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
    networkError.status = 0;
    networkError.requestUrl = requestUrl;
    throw networkError;
  }

  let parsedPayload = null;
  const responseContentType = String(response.headers.get("content-type") || "").toLowerCase();
  const canParseJson = responseContentType.includes("application/json") || responseContentType.includes("+json");

  if (canParseJson) {
    try {
      parsedPayload = await response.json();
    } catch (parseError) {
      parsedPayload = null;
    }
  } else if (response.status !== 204) {
    try {
      const rawText = await response.text();
      const trimmedText = String(rawText || "").trim();
      if (trimmedText !== "") {
        parsedPayload = {
          message: trimmedText,
        };
      }
    } catch (readError) {
      parsedPayload = null;
    }
  }

  if (!response.ok) {
    const parsedErrorMessage = parseTopicsApiErrorMessage(parsedPayload);
    const fallbackMessage = `Topics API request failed (${response.status}) for ${requestUrl}.`;
    const requestError = new Error(parsedErrorMessage ? `${fallbackMessage} ${parsedErrorMessage}` : fallbackMessage);
    requestError.status = response.status;
    requestError.requestUrl = requestUrl;
    requestError.responsePayload = parsedPayload;
    throw requestError;
  }

  const responsePayload = response.status === 204 ? null : parsedPayload;
  if (!includeResponseMetadata) {
    return responsePayload;
  }

  const odataNextLink = pickFirstNonEmptyString([
    response.headers.get("odata.nextLink"),
    response.headers.get("odata-nextlink"),
    response.headers.get("OData-NextLink"),
    response.headers.get("next"),
  ]);

  return {
    payload: responsePayload,
    status: response.status,
    requestUrl,
    responseHeaders: {
      odataNextLink,
    },
  };
}

/*
Purpose:
Map Trimble app/web host name into matching Topics API host name so project
region can be inferred before trying static fallback hosts.

Parameters:
trimbleHostName (string) - host candidate from current runtime or Core API URL

Returns:
string - derived Topics API host name, or empty string when mapping is unknown

Possible side effects:
None
*/
function deriveTopicsHostFromTrimbleHost(trimbleHostName) {
  const normalizedHost = String(trimbleHostName || "").trim().toLowerCase();
  if (!normalizedHost) {
    return "";
  }

  const appLikeHost = normalizedHost.startsWith("web.") ? normalizedHost.replace(/^web\./, "app.") : normalizedHost;
  const stageMatch = appLikeHost.match(/^app(\d*)\.stage\.connect\.trimble\.com$/);
  if (stageMatch) {
    const regionCode = stageMatch[1] || "11";
    return `open${regionCode}.stage.connect.trimble.com`;
  }

  if (appLikeHost === "app.connect.trimble.com") {
    return "open11.connect.trimble.com";
  }

  const productionMatch = appLikeHost.match(/^app(\d+)\.connect\.trimble\.com$/);
  if (productionMatch) {
    return `open${productionMatch[1]}.connect.trimble.com`;
  }

  return "";
}

/*
Purpose:
Build ordered Topics API base URL candidate list by deriving host from active
runtime/Core host first and then appending known static server URLs.

Parameters:
None

Returns:
Array<string> - Topics API base URL candidates

Possible side effects:
None
*/
function buildTopicsApiBaseUrlCandidates() {
  const urlCandidates = [];
  const seenCandidates = new Set();

  const sourceHosts = [];
  if (isNonEmptyString(runtimeState.activeCoreApiBaseUrl)) {
    try {
      sourceHosts.push(new URL(runtimeState.activeCoreApiBaseUrl).host);
    } catch (urlError) {
      sourceHosts.push("");
    }
  }
  sourceHosts.push(pickFirstNonEmptyString([window.location.host]));

  sourceHosts.forEach((sourceHost) => {
    const derivedTopicsHost = deriveTopicsHostFromTrimbleHost(sourceHost);
    if (isNonEmptyString(derivedTopicsHost)) {
      pushUniqueUrlCandidate(urlCandidates, seenCandidates, `https://${derivedTopicsHost}`);
    }
  });

  TOPICS_API_BASE_URL_STATIC_CANDIDATES.forEach((staticCandidate) => {
    pushUniqueUrlCandidate(urlCandidates, seenCandidates, staticCandidate);
  });

  return urlCandidates;
}

/*
Purpose:
Resolve working Topics API base URL for current project by validating candidate
servers until one returns project payload successfully.

Parameters:
accessToken (string) - bearer token
projectId (string) - current Trimble project id

Returns:
Promise<string> - working Topics API base URL

Possible side effects:
- Executes one or more Topics API requests.
*/
async function resolveTopicsApiBaseUrlForProject(accessToken, projectId) {
  const topicsApiBaseUrlCandidates = buildTopicsApiBaseUrlCandidates();
  const failedAttempts = [];

  for (const topicsApiBaseUrl of topicsApiBaseUrlCandidates) {
    const projectEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}`;
    try {
      await requestTopicsApiJson(projectEndpoint, accessToken, {
        method: "GET",
        acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
      });
      return topicsApiBaseUrl;
    } catch (error) {
      const statusCode = Number(error?.status || 0);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 401 || statusCode === 403) {
        throw new Error(`Topics API authorization failed at ${topicsApiBaseUrl}. ${errorMessage}`);
      }

      failedAttempts.push(`${topicsApiBaseUrl}: ${errorMessage}`);
    }
  }

  const failedAttemptText = failedAttempts.join(" | ");
  throw new Error(`Could not resolve Topics API host for current project. ${failedAttemptText}`);
}

/*
Purpose:
Load raw project extension payload from Topics API with media-type fallback so
callers can inspect and update extension values safely.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id

Returns:
Promise<object> - raw extension payload

Possible side effects:
- Executes Topics API extension request against project extensions endpoint.
*/
async function fetchProjectBcfExtensionsPayload(topicsApiBaseUrl, accessToken, projectId) {
  const extensionsEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/extensions`;
  let extensionsPayload = null;

  try {
    extensionsPayload = await requestTopicsApiJson(extensionsEndpoint, accessToken, {
      method: "GET",
      acceptMediaType: TOPICS_API_MEDIA_TYPE_CONNECT,
    });
  } catch (error) {
    const statusCode = Number(error?.status || 0);
    if (statusCode !== 400 && statusCode !== 406 && statusCode !== 415) {
      throw error;
    }

    extensionsPayload = await requestTopicsApiJson(extensionsEndpoint, accessToken, {
      method: "GET",
      acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
    });
  }

  return extensionsPayload || {};
}

/*
Purpose:
Update project extension values through Trimble Connect extension endpoint. This
is used to guarantee that required topic labels exist before topic creation.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id
extensionUpdatePayload (object) - PUT payload constrained by extensions_PUT_Connect

Returns:
Promise<object> - updated extension payload returned by Topics API

Possible side effects:
- Executes Topics API PUT request and mutates project extension values.
*/
async function updateProjectBcfExtensions(topicsApiBaseUrl, accessToken, projectId, extensionUpdatePayload) {
  const extensionsEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/extensions`;
  return requestTopicsApiJson(extensionsEndpoint, accessToken, {
    method: "PUT",
    requestBody: extensionUpdatePayload,
    acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
    contentMediaType: TOPICS_API_MEDIA_TYPE_BCF,
  });
}

/*
Purpose:
Ensure required project topic label exists in project extensions before topic
creation. Without this safeguard Topics API can reject topic creation when label
validation is strict.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id
extensionsPayload (object) - current extensions payload
requiredTopicLabel (string) - required label value that must be present

Returns:
Promise<object> - extensions payload that contains the required label

Possible side effects:
- May issue Topics API PUT request to add missing label in project extensions.
*/
async function ensureProjectTopicLabelExists(
  topicsApiBaseUrl,
  accessToken,
  projectId,
  extensionsPayload,
  requiredTopicLabel,
) {
  const normalizedExtensionsPayload = extensionsPayload || {};
  const normalizedRequiredLabel = String(requiredTopicLabel || "").trim();
  if (!normalizedRequiredLabel) {
    return normalizedExtensionsPayload;
  }

  const currentTopicLabels = collectUniqueTrimmedStringValues(normalizedExtensionsPayload?.topic_label);
  const existingRequiredLabel = findExtensionOptionValueByCaseInsensitiveExactMatch(currentTopicLabels, normalizedRequiredLabel);
  if (existingRequiredLabel) {
    return normalizedExtensionsPayload;
  }

  const updatedTopicLabels = collectUniqueTrimmedStringValues([...currentTopicLabels, normalizedRequiredLabel]);
  try {
    const updatedExtensionsPayload = await updateProjectBcfExtensions(
      topicsApiBaseUrl,
      accessToken,
      projectId,
      {
        topic_label: updatedTopicLabels,
      },
    );
    const updatedLabelValues = collectUniqueTrimmedStringValues(updatedExtensionsPayload?.topic_label);
    if (findExtensionOptionValueByCaseInsensitiveExactMatch(updatedLabelValues, normalizedRequiredLabel)) {
      return updatedExtensionsPayload || {};
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not add required topic label "${normalizedRequiredLabel}" to project extensions. ${errorMessage}`);
  }

  const refreshedExtensionsPayload = await fetchProjectBcfExtensionsPayload(topicsApiBaseUrl, accessToken, projectId);
  const refreshedLabels = collectUniqueTrimmedStringValues(refreshedExtensionsPayload?.topic_label);
  if (findExtensionOptionValueByCaseInsensitiveExactMatch(refreshedLabels, normalizedRequiredLabel)) {
    return refreshedExtensionsPayload;
  }

  throw new Error(`Could not confirm required topic label "${normalizedRequiredLabel}" in project extensions.`);
}

/*
Purpose:
Load project extension options from Topics API, ensure required IFC checker
label exists, and return normalized options for modal rendering.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id

Returns:
Promise<object> - normalized extension options

Possible side effects:
- Executes Topics API extension GET and optional extension PUT requests.
*/
async function loadProjectBcfExtensionOptions(topicsApiBaseUrl, accessToken, projectId) {
  const extensionsPayload = await fetchProjectBcfExtensionsPayload(topicsApiBaseUrl, accessToken, projectId);
  const ensuredExtensionsPayload = await ensureProjectTopicLabelExists(
    topicsApiBaseUrl,
    accessToken,
    projectId,
    extensionsPayload,
    IFC_CHECKER_TOPIC_LABEL,
  );
  return buildBcfProjectExtensionOptions(ensuredExtensionsPayload || {});
}

/*
Purpose:
Build absolute URL for Topics API pagination from `odata.nextLink` so file
information listing can safely follow server-driven paging links.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
nextLinkValue (string) - next page link from response headers

Returns:
string - absolute next-page URL, or empty string when unavailable/invalid

Possible side effects:
None
*/
function buildTopicsApiPaginationUrl(topicsApiBaseUrl, nextLinkValue) {
  const normalizedNextLink = String(nextLinkValue || "").trim();
  if (!normalizedNextLink) {
    return "";
  }

  try {
    return new URL(normalizedNextLink, topicsApiBaseUrl).toString();
  } catch (urlError) {
    return "";
  }
}

/*
Purpose:
Load all Topics API file-information pages for one project so selected IFC file
can be mapped into exact BCF `files` payload values before topic creation.

Parameters:
topicsApiBaseUrl (string) - resolved Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id

Returns:
Promise<Array<object>> - flattened list of project file-information entries

Possible side effects:
- Executes one or more Topics API requests.
*/
async function loadProjectBcfFileInformationEntries(topicsApiBaseUrl, accessToken, projectId) {
  const fileInformationEntries = [];
  const maximumPageCount = 50;
  let loadedPageCount = 0;
  let nextRequestUrl = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/files_information?top=100`;

  while (isNonEmptyString(nextRequestUrl)) {
    loadedPageCount += 1;
    if (loadedPageCount > maximumPageCount) {
      throw new Error(`Topics API file-information pagination exceeded ${maximumPageCount} pages.`);
    }

    const responseWithMetadata = await requestTopicsApiJson(nextRequestUrl, accessToken, {
      method: "GET",
      acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
      includeResponseMetadata: true,
    });
    const pagePayload = Array.isArray(responseWithMetadata?.payload) ? responseWithMetadata.payload : [];
    fileInformationEntries.push(...pagePayload);

    nextRequestUrl = buildTopicsApiPaginationUrl(
      topicsApiBaseUrl,
      responseWithMetadata?.responseHeaders?.odataNextLink,
    );
  }

  return fileInformationEntries;
}

/*
Purpose:
Normalize one Topics API `files` object so link-update calls can reuse one
stable payload shape with optional fields preserved when present.

Parameters:
fileReferenceCandidate (object) - candidate file reference payload

Returns:
{ ifc_project?: string, ifc_spatial_structure_element?: string, filename: string, date?: string, reference: string } | null

Possible side effects:
None
*/
function normalizeTopicFileReferenceForBcfUpdate(fileReferenceCandidate) {
  if (!fileReferenceCandidate || typeof fileReferenceCandidate !== "object") {
    return null;
  }

  const normalizedIfcProject = String(fileReferenceCandidate.ifc_project || "").trim();
  const normalizedIfcSpatialStructureElement = String(fileReferenceCandidate.ifc_spatial_structure_element || "").trim();
  const normalizedFileName = String(fileReferenceCandidate.filename || "").trim();
  const normalizedDate = String(fileReferenceCandidate.date || "").trim();
  const normalizedReference = String(fileReferenceCandidate.reference || "").trim();
  if (!normalizedFileName || !normalizedReference) {
    return null;
  }

  const normalizedTopicFileReference = {
    filename: normalizedFileName,
    reference: normalizedReference,
  };
  if (normalizedIfcProject) {
    normalizedTopicFileReference.ifc_project = normalizedIfcProject;
  }
  if (normalizedIfcSpatialStructureElement) {
    normalizedTopicFileReference.ifc_spatial_structure_element = normalizedIfcSpatialStructureElement;
  }
  if (normalizedDate) {
    normalizedTopicFileReference.date = normalizedDate;
  }

  return normalizedTopicFileReference;
}

/*
Purpose:
Resolve one unambiguous Topics API file reference for the currently checked IFC
model so each created topic can be linked to both model project and model file.

Logic:
- Normalize all candidate file references from `files_information`.
- Score each candidate against selected IFC file id/version/name.
- Require a single highest-scoring match to avoid linking to wrong file.
- Require `ifc_project` to ensure model project link is included.

Parameters:
projectFileInformationEntries (Array<object>) - entries from `/files_information`
selectedModelFile (object) - metadata of currently checked IFC file

Returns:
{ ifc_project?: string, ifc_spatial_structure_element?: string, filename: string, date?: string, reference: string }

Possible side effects:
None
*/
function resolveTopicFileReferenceForSelectedModel(projectFileInformationEntries, selectedModelFile) {
  const selectedModelFileId = String(selectedModelFile?.fileId || "").trim();
  const selectedModelVersionId = String(selectedModelFile?.versionId || "").trim();
  const selectedModelFileName = String(selectedModelFile?.name || "").trim();
  if (!selectedModelFileId || !selectedModelFileName) {
    throw new Error("Selected IFC file id and file name are required for Topics file linking.");
  }

  const normalizedCandidateReferences = (Array.isArray(projectFileInformationEntries) ? projectFileInformationEntries : [])
    .map((projectFileInformationEntry) =>
      normalizeTopicFileReferenceForBcfUpdate(projectFileInformationEntry?.file || null),
    )
    .filter(Boolean);
  if (normalizedCandidateReferences.length === 0) {
    throw new Error("Topics API did not return project file information entries for linking.");
  }

  const normalizedSelectedFileIdLower = selectedModelFileId.toLowerCase();
  const normalizedSelectedVersionIdLower = selectedModelVersionId.toLowerCase();
  const normalizedSelectedFileNameLower = selectedModelFileName.toLowerCase();

  const scoredCandidates = normalizedCandidateReferences
    .map((topicFileReference) => {
      const normalizedReference = String(topicFileReference.reference || "").trim();
      const normalizedReferenceLower = normalizedReference.toLowerCase();
      const normalizedFileName = String(topicFileReference.filename || "").trim();
      const normalizedFileNameLower = normalizedFileName.toLowerCase();

      let matchScore = 0;
      if (normalizedReference === selectedModelFileId) {
        matchScore += 1000;
      } else if (normalizedReferenceLower.includes(normalizedSelectedFileIdLower)) {
        matchScore += 700;
      }

      if (normalizedSelectedVersionIdLower && normalizedReferenceLower.includes(normalizedSelectedVersionIdLower)) {
        matchScore += 250;
      }

      if (normalizedFileName === selectedModelFileName) {
        matchScore += 500;
      } else if (normalizedFileNameLower === normalizedSelectedFileNameLower) {
        matchScore += 450;
      }

      return {
        topicFileReference,
        matchScore,
      };
    })
    .filter((scoredCandidate) => scoredCandidate.matchScore > 0);

  if (scoredCandidates.length === 0) {
    throw new Error(
      `Could not match selected IFC file ${selectedModelFileName} (${selectedModelFileId}) to Topics project file list.`,
    );
  }

  const highestMatchScore = Math.max(...scoredCandidates.map((scoredCandidate) => scoredCandidate.matchScore));
  const highestScoredCandidates = scoredCandidates.filter(
    (scoredCandidate) => scoredCandidate.matchScore === highestMatchScore,
  );
  if (highestScoredCandidates.length !== 1) {
    throw new Error(
      `Could not resolve unique Topics file reference for ${selectedModelFileName}. ${highestScoredCandidates.length} equal matches were found.`,
    );
  }

  const resolvedTopicFileReference = highestScoredCandidates[0].topicFileReference;
  if (!isNonEmptyString(resolvedTopicFileReference.ifc_project)) {
    throw new Error(
      `Topics file reference for ${selectedModelFileName} did not include ifc_project, so model project link cannot be guaranteed.`,
    );
  }

  return resolvedTopicFileReference;
}

/*
Purpose:
Build a deterministic topic-file reference directly from current model context
so topic-file linking does not depend on optional file-information endpoint
availability.

Logic:
- Use selected IFC file id as server-specific file reference.
- Use selected IFC file name as BCF filename.
- Include IFCPROJECT GlobalId from latest check report model context when
  available so model project link is explicit.

Parameters:
selectedModelFile (object) - currently checked IFC file metadata
checkReportData (object | null) - latest checker report payload

Returns:
{ ifc_project?: string, filename: string, reference: string }

Possible side effects:
None
*/
function buildTopicFileReferenceFromSelectedModel(selectedModelFile, checkReportData) {
  const selectedModelFileId = String(selectedModelFile?.fileId || "").trim();
  const selectedModelFileName = String(selectedModelFile?.name || "").trim();
  if (!selectedModelFileId || !selectedModelFileName) {
    throw new Error("Selected IFC file id and name are required for topic-file linking.");
  }

  const ifcProjectGlobalId = String(checkReportData?.modelContext?.ifcProjectGlobalId || "").trim();
  const topicFileReference = {
    filename: selectedModelFileName,
    reference: selectedModelFileId,
  };
  if (ifcProjectGlobalId) {
    topicFileReference.ifc_project = ifcProjectGlobalId;
  }

  return topicFileReference;
}

/*
Purpose:
Resolve Topics `files` payload once per BCF creation run so each created topic
is linked to the exact IFC model file that produced the findings.

Parameters:
topicsApiBaseUrl (string) - Topics API base URL
accessToken (string) - bearer token
projectId (string) - current project id
selectedModelFile (object) - currently checked IFC file metadata
checkReportData (object | null) - latest checker report payload

Returns:
Promise<{ ifc_project?: string, ifc_spatial_structure_element?: string, filename: string, date?: string, reference: string }>

Possible side effects:
- May execute Topics API file-information requests as fallback.
*/
async function resolveTopicFileReferenceForCurrentModel(
  topicsApiBaseUrl,
  accessToken,
  projectId,
  selectedModelFile,
  checkReportData,
) {
  const localTopicFileReference = buildTopicFileReferenceFromSelectedModel(selectedModelFile, checkReportData);
  if (isNonEmptyString(localTopicFileReference.ifc_project)) {
    return localTopicFileReference;
  }

  const projectFileInformationEntries = await loadProjectBcfFileInformationEntries(
    topicsApiBaseUrl,
    accessToken,
    projectId,
  );
  return resolveTopicFileReferenceForSelectedModel(projectFileInformationEntries, selectedModelFile);
}

/*
Purpose:
Build topic creation payload for one selected issue by combining generic modal
settings with row-specific overrides and issue metadata.

Parameters:
genericSettings (object) - generic settings from modal
  - `lengthUnitToMeters` can be provided by caller to convert placement points
    from model units into BCF meter coordinates.
selectedIssueTopic (object) - one selected row from modal

Returns:
object - topic payload candidate

Possible side effects:
None
*/
function buildTopicPayloadForSelectedIssue(genericSettings, selectedIssueTopic) {
  const normalizedGenericSettings = genericSettings || {};
  const normalizedTopic = selectedIssueTopic || {};

  const normalizedTitle = String(normalizedTopic.title || "").trim();
  const normalizedDescription = String(normalizedTopic.description || "").trim();
  const normalizedTopicType = String(normalizedTopic.topicType || "").trim();
  const normalizedTopicStatus = String(normalizedGenericSettings.topicStatus || "").trim();
  const normalizedPriority = String(normalizedGenericSettings.priority || "").trim();
  const normalizedStage = String(normalizedGenericSettings.stage || "").trim();
  const normalizedDueDate = String(normalizedGenericSettings.dueDate || "").trim();

  const labelValues = collectUniqueTrimmedStringValues(
    Array.isArray(normalizedGenericSettings.labels) ? normalizedGenericSettings.labels : [],
  );
  const referenceLinks = collectUniqueTrimmedStringValues(normalizedGenericSettings.referenceLinks || []);

  const topicPayload = {
    title: normalizedTitle,
    description: normalizedDescription,
  };

  if (normalizedTopicType) {
    topicPayload.topic_type = normalizedTopicType;
  }
  if (normalizedTopicStatus) {
    topicPayload.topic_status = normalizedTopicStatus;
  }
  if (normalizedPriority) {
    topicPayload.priority = normalizedPriority;
  }
  if (normalizedStage) {
    topicPayload.stage = normalizedStage;
  }
  if (normalizedDueDate) {
    topicPayload.due_date = normalizedDueDate;
  }
  if (labelValues.length > 0) {
    topicPayload.labels = labelValues;
  }
  if (referenceLinks.length > 0) {
    topicPayload.reference_links = referenceLinks;
  }

  const bcfPlacementPoint = convertPlacementPointToBcfMeters(
    normalizedTopic.placementPoint,
    normalizedGenericSettings.lengthUnitToMeters,
  );
  if (bcfPlacementPoint) {
    topicPayload.marker = {
      model_point: bcfPlacementPoint,
    };
  }

  return topicPayload;
}

/*
Purpose:
Construct perspective camera around issue placement point so viewpoint payload
can include practical camera context when coordinate data is available.

Parameters:
placementPoint (object | null) - normalized placement point
lengthUnitToMeters (number) - meters-per-model-unit conversion scale

Returns:
object | null - perspective camera payload, null when point is unavailable

Possible side effects:
None
*/
function buildPerspectiveCameraFromPlacementPoint(placementPoint, lengthUnitToMeters) {
  const normalizedPoint = convertPlacementPointToBcfMeters(placementPoint, lengthUnitToMeters);
  if (!normalizedPoint) {
    return null;
  }

  const cameraOffset = {
    x: 8,
    y: 8,
    z: 8,
  };
  const cameraViewPoint = {
    x: normalizedPoint.x + cameraOffset.x,
    y: normalizedPoint.y + cameraOffset.y,
    z: normalizedPoint.z + cameraOffset.z,
  };

  const directionVector = {
    x: normalizedPoint.x - cameraViewPoint.x,
    y: normalizedPoint.y - cameraViewPoint.y,
    z: normalizedPoint.z - cameraViewPoint.z,
  };
  const directionLength = Math.hypot(directionVector.x, directionVector.y, directionVector.z);
  if (!Number.isFinite(directionLength) || directionLength <= 0.000001) {
    return null;
  }

  return {
    camera_view_point: cameraViewPoint,
    camera_direction: {
      x: directionVector.x / directionLength,
      y: directionVector.y / directionLength,
      z: directionVector.z / directionLength,
    },
    camera_up_vector: {
      x: 0,
      y: 0,
      z: 1,
    },
    field_of_view: 60,
    aspect_ratio: 1.7777777778,
  };
}

/*
Purpose:
Build viewpoint payload for one selected issue topic so created BCF topic is
linked to IFC GUID selection and optional camera placement context.

Parameters:
selectedIssueTopic (object) - selected issue row
usePlacementCamera (boolean) - true when camera should use placement point
lengthUnitToMeters (number) - meters-per-model-unit conversion scale

Returns:
object | null - viewpoint payload or null when IFC GUID is missing

Possible side effects:
None
*/
function buildViewpointPayloadForSelectedIssue(selectedIssueTopic, usePlacementCamera, lengthUnitToMeters) {
  const ifcGuid = String(selectedIssueTopic?.globalId || "").trim();
  if (!ifcGuid) {
    return null;
  }

  const expressIdValue = selectedIssueTopic?.expressId ?? "";
  const hasExpressId = isNonEmptyString(String(expressIdValue));

  const viewpointPayload = {
    components: {
      selection: [
        {
          ifc_guid: ifcGuid,
          originating_system: "Trimble Lab IFC Checker",
          authoring_tool_id: hasExpressId ? `ExpressId:${String(expressIdValue)}` : "Trimble-Lab",
        },
      ],
    },
  };

  if (usePlacementCamera) {
    const perspectiveCamera = buildPerspectiveCameraFromPlacementPoint(
      selectedIssueTopic?.placementPoint,
      lengthUnitToMeters,
    );
    if (perspectiveCamera) {
      viewpointPayload.perspective_camera = perspectiveCamera;
    }
  }

  return viewpointPayload;
}

/*
Purpose:
Create one BCF topic through Topics API using Connect media type first so marker
extension is preserved when supported, with fallback to pure BCF payload.

Parameters:
topicsApiBaseUrl (string) - Topics API base URL
accessToken (string) - bearer token
projectId (string) - project id
topicPayload (object) - topic payload candidate

Returns:
Promise<object> - created topic payload from Topics API

Possible side effects:
- Executes Topics API create-topic request.
*/
async function createSingleBcfTopic(topicsApiBaseUrl, accessToken, projectId, topicPayload) {
  const createTopicEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/topics`;

  try {
    return await requestTopicsApiJson(createTopicEndpoint, accessToken, {
      method: "POST",
      requestBody: topicPayload,
      acceptMediaType: TOPICS_API_MEDIA_TYPE_CONNECT,
      contentMediaType: TOPICS_API_MEDIA_TYPE_CONNECT,
    });
  } catch (error) {
    const statusCode = Number(error?.status || 0);
    if (statusCode !== 400 && statusCode !== 406 && statusCode !== 415) {
      throw error;
    }

    if (statusCode === 406 || statusCode === 415) {
      try {
        return await requestTopicsApiJson(createTopicEndpoint, accessToken, {
          method: "POST",
          requestBody: topicPayload,
          acceptMediaType: TOPICS_API_MEDIA_TYPE_CONNECT_LEGACY,
          contentMediaType: TOPICS_API_MEDIA_TYPE_CONNECT_LEGACY,
        });
      } catch (legacyConnectError) {
        const legacyStatusCode = Number(legacyConnectError?.status || 0);
        if (legacyStatusCode !== 400 && legacyStatusCode !== 406 && legacyStatusCode !== 415) {
          throw legacyConnectError;
        }
      }
    }

    const fallbackTopicPayload = {
      ...topicPayload,
    };
    delete fallbackTopicPayload.marker;

    return requestTopicsApiJson(createTopicEndpoint, accessToken, {
      method: "POST",
      requestBody: fallbackTopicPayload,
      acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
      contentMediaType: TOPICS_API_MEDIA_TYPE_BCF,
    });
  }
}

/*
Purpose:
Create one viewpoint for a previously created topic so IFC GUID reference and
camera context can be attached to the topic discussion in Trimble Connect.

Parameters:
topicsApiBaseUrl (string) - Topics API base URL
accessToken (string) - bearer token
projectId (string) - project id
topicGuid (string) - created topic guid
viewpointPayload (object) - viewpoint payload

Returns:
Promise<object> - created viewpoint payload

Possible side effects:
- Executes Topics API create-viewpoint request.
*/
async function createSingleBcfViewpoint(topicsApiBaseUrl, accessToken, projectId, topicGuid, viewpointPayload) {
  const createViewpointEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/viewpoints`;
  return requestTopicsApiJson(createViewpointEndpoint, accessToken, {
    method: "POST",
    requestBody: viewpointPayload,
    acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
    contentMediaType: TOPICS_API_MEDIA_TYPE_BCF,
  });
}

/*
Purpose:
Update one created topic with explicit model-file header reference so topic is
linked to the exact IFC project + IFC file that produced the finding.

Parameters:
topicsApiBaseUrl (string) - Topics API base URL
accessToken (string) - bearer token
projectId (string) - project id
topicGuid (string) - created topic guid
topicFileReference (object) - normalized file reference payload

Returns:
Promise<Array<object> | null> - updated file references returned by Topics API

Possible side effects:
- Executes Topics API update-files request for one topic.
*/
async function updateSingleBcfTopicFiles(topicsApiBaseUrl, accessToken, projectId, topicGuid, topicFileReference) {
  const updateFilesEndpoint = `${topicsApiBaseUrl}/bcf/3.0/projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/files`;
  return requestTopicsApiJson(updateFilesEndpoint, accessToken, {
    method: "PUT",
    requestBody: [topicFileReference],
    acceptMediaType: TOPICS_API_MEDIA_TYPE_BCF,
    contentMediaType: TOPICS_API_MEDIA_TYPE_BCF,
  });
}

/*
Purpose:
Execute full Topics API creation batch from modal request so each selected
issue row creates one topic and optionally one viewpoint.

Parameters:
options (object) - batch creation input
options.topicsApiBaseUrl (string) - Topics API base URL
options.accessToken (string) - bearer token
options.projectId (string) - project id
options.creationRequest (object) - modal-confirmed creation request
options.topicFileReference (object | null) - resolved topic-file header reference

Returns:
Promise<{ createdTopicCount: number, linkedTopicFileCount: number, createdViewpointCount: number, failedTopics: Array<object> }>

Possible side effects:
- Performs multiple Topics API requests.
*/
async function createBcfTopicsFromModalRequest({
  topicsApiBaseUrl,
  accessToken,
  projectId,
  creationRequest,
  topicFileReference,
}) {
  const creationResult = {
    createdTopicCount: 0,
    linkedTopicFileCount: 0,
    createdViewpointCount: 0,
    failedTopics: [],
  };

  const selectedTopics = Array.isArray(creationRequest?.topics) ? creationRequest.topics : [];
  for (const selectedTopic of selectedTopics) {
    try {
      const topicPayload = buildTopicPayloadForSelectedIssue(creationRequest?.generic || {}, selectedTopic);
      const createdTopicPayload = await createSingleBcfTopic(topicsApiBaseUrl, accessToken, projectId, topicPayload);

      const createdTopicGuid = pickFirstNonEmptyString([
        createdTopicPayload?.guid,
        createdTopicPayload?.topic_guid,
      ]);
      if (!createdTopicGuid) {
        throw new Error("Topics API did not return created topic guid, so file linking cannot continue.");
      }

      const topicActions = collectUniqueTrimmedStringValues(createdTopicPayload?.authorization?.topic_actions);
      if (topicFileReference) {
        const canUpdateFiles = topicActions.length === 0 || topicActions.includes("updateFiles");
        if (!canUpdateFiles) {
          throw new Error(
            `Created topic ${createdTopicGuid} did not expose updateFiles authorization required for model linking.`,
          );
        }

        await updateSingleBcfTopicFiles(topicsApiBaseUrl, accessToken, projectId, createdTopicGuid, topicFileReference);
        creationResult.linkedTopicFileCount += 1;
      }

      creationResult.createdTopicCount += 1;

      const createViewpointsEnabled = creationRequest?.generic?.createViewpoints === true;
      if (!createViewpointsEnabled) {
        continue;
      }

      const canCreateViewpoint = topicActions.length === 0 || topicActions.includes("createViewpoint");
      if (!canCreateViewpoint) {
        continue;
      }

      const viewpointPayload = buildViewpointPayloadForSelectedIssue(
        selectedTopic,
        creationRequest?.generic?.usePlacementCamera === true,
        creationRequest?.generic?.lengthUnitToMeters,
      );
      if (!viewpointPayload) {
        continue;
      }

      await createSingleBcfViewpoint(topicsApiBaseUrl, accessToken, projectId, createdTopicGuid, viewpointPayload);
      creationResult.createdViewpointCount += 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      creationResult.failedTopics.push({
        rowId: String(selectedTopic?.rowId || ""),
        title: String(selectedTopic?.title || ""),
        error: errorMessage,
      });
    }
  }

  return creationResult;
}

/*
Purpose:
Export latest checker result into local JSON file so user can archive report
content and share it outside Trimble Connect before server integration exists.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Triggers browser file download.
- Updates status and host extension status message.
*/
async function exportLatestCheckReportAsJson() {
  if (
    runtimeState.isLoadingFiles ||
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics
  ) {
    setStatus("Wait until current operation finishes before exporting report.", "warning");
    return;
  }

  if (!runtimeState.latestCheckResult || !runtimeState.downloadedIfcFile) {
    setStatus("Run one checker execution before exporting report JSON.", "warning");
    return;
  }

  try {
    const generatedAt = new Date().toISOString();
    const reportPayload = buildCheckerReportExportPayload({
      reportData: runtimeState.latestCheckResult,
      projectContext: buildCurrentProjectContextForExport(),
      selectedFile: runtimeState.downloadedIfcFile,
      checkExecutionOptions: runtimeState.checkExecutionOptions,
      generatedAt,
    });

    const exportFileName = buildExportFileName(runtimeState.downloadedIfcFile, "check-report", generatedAt);
    triggerJsonFileDownload(exportFileName, reportPayload);

    const successMessage = `Report JSON export completed: ${exportFileName}`;
    setStatus(successMessage, "success");

    if (runtimeState.workspaceApi?.extension && typeof runtimeState.workspaceApi.extension.setStatusMessage === "function") {
      await runtimeState.workspaceApi.extension.setStatusMessage(successMessage);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Report JSON export failed: ${errorMessage}`, "error");
  }
}

/*
Purpose:
Create BCF topics directly inside Trimble Connect from user-selected findings
using Topics API (BCF 3.0), with one topic per selected issue row.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Opens informational or configuration modal.
- Executes Topics API requests to create topics/viewpoints.
- Updates status and host extension status message.
*/
async function exportLatestBcfDraftAsJson() {
  if (runtimeState.isCreatingBcfTopics) {
    setStatus("BCF topic creation is already running.", "warning");
    return;
  }

  if (runtimeState.isLoadingFiles || runtimeState.isDownloadingSelectedFile || runtimeState.isRunningCheck) {
    setStatus("Wait until current operation finishes before creating BCFs.", "warning");
    return;
  }

  if (!runtimeState.latestCheckResult || !runtimeState.downloadedIfcFile) {
    setStatus("Run one checker execution before creating BCFs.", "warning");
    return;
  }

  const selectedIssueSelectors = getSelectedBcfIssueSelectors();
  if (selectedIssueSelectors.length === 0) {
    await openBcfInformationModal(
      "Select at least one error or warning from report results before creating BCF topics.",
    );
    setStatus("Select at least one error or warning from report results before creating BCFs.", "warning");
    return;
  }

  const selectedIssueRows = buildSelectedIssueRowsForBcfCreation({
    reportData: runtimeState.latestCheckResult,
    selectedIssueSelectors,
  });
  if (selectedIssueRows.length === 0) {
    setStatus("Selected errors/warnings were not found in current report. Update selections and try again.", "warning");
    return;
  }

  runtimeState.isCreatingBcfTopics = true;
  updateRefreshButtonState();
  updateDownloadButtonState();
  updateEditCheckSettingsButtonState();
  updateClearModelButtonState();
  updateReportExportActionButtonState();

  try {
    const workspaceApi = await connectWorkspaceApi();
    const accessToken = isNonEmptyString(runtimeState.accessToken)
      ? runtimeState.accessToken
      : await ensureAccessToken(workspaceApi);

    setStatus("Resolving Topics API host for current project...", "info");
    const topicsApiBaseUrl = await resolveTopicsApiBaseUrlForProject(accessToken, runtimeState.currentProjectId);

    setStatus("Loading project-specific BCF extension options...", "info");
    const extensionOptions = await loadProjectBcfExtensionOptions(
      topicsApiBaseUrl,
      accessToken,
      runtimeState.currentProjectId,
    );

    const canCreateTopics =
      extensionOptions.projectActions.length === 0 || extensionOptions.projectActions.includes("createTopic");
    if (!canCreateTopics) {
      setStatus("Current user does not have createTopic permission in Topics API project authorization.", "error");
      return;
    }

    const canUpdateTopicFiles =
      extensionOptions.topicActions.length === 0 || extensionOptions.topicActions.includes("updateFiles");
    if (!canUpdateTopicFiles) {
      setStatus(
        "Current user does not have updateFiles permission required to link created topics to model file headers.",
        "error",
      );
      return;
    }

    const creationRequest = await openBcfTopicCreationModal(selectedIssueRows, extensionOptions);
    if (!creationRequest) {
      setStatus("Create BCFs action was cancelled.", "info");
      return;
    }

    if (!Array.isArray(creationRequest.topics) || creationRequest.topics.length === 0) {
      setStatus("No topics were selected in modal. Create BCFs action was cancelled.", "warning");
      return;
    }

    const bcfLengthUnitToMeters = resolveBcfLengthUnitToMetersFromCheckResult(runtimeState.latestCheckResult);
    creationRequest.generic = {
      ...(creationRequest.generic || {}),
      lengthUnitToMeters: bcfLengthUnitToMeters,
    };

    setStatus("Resolving selected model file reference for topic linking...", "info");
    const topicFileReference = await resolveTopicFileReferenceForCurrentModel(
      topicsApiBaseUrl,
      accessToken,
      runtimeState.currentProjectId,
      runtimeState.downloadedIfcFile,
      runtimeState.latestCheckResult,
    );

    setStatus(`Creating ${creationRequest.topics.length} BCF topic(s) in Trimble Connect...`, "info");
    const creationResult = await createBcfTopicsFromModalRequest({
      topicsApiBaseUrl,
      accessToken,
      projectId: runtimeState.currentProjectId,
      creationRequest,
      topicFileReference,
    });

    if (creationResult.createdTopicCount <= 0) {
      const firstFailureMessage = creationResult.failedTopics[0]?.error || "No topics were created.";
      setStatus(`Create BCFs failed: ${firstFailureMessage}`, "error");
      return;
    }

    const failedCount = creationResult.failedTopics.length;
    const creationSeverity = failedCount > 0 ? "warning" : "success";
    const successMessage =
      failedCount > 0
        ? `Created ${creationResult.createdTopicCount} topic(s), linked ${creationResult.linkedTopicFileCount} topic(s) to model files, created ${creationResult.createdViewpointCount} viewpoint(s), and ${failedCount} topic(s) failed.`
        : `Created ${creationResult.createdTopicCount} topic(s), linked ${creationResult.linkedTopicFileCount} topic(s) to model files, and created ${creationResult.createdViewpointCount} viewpoint(s) successfully.`;
    setStatus(successMessage, creationSeverity);

    if (runtimeState.workspaceApi?.extension && typeof runtimeState.workspaceApi.extension.setStatusMessage === "function") {
      await runtimeState.workspaceApi.extension.setStatusMessage(successMessage);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Create BCFs failed: ${errorMessage}`, "error");
  } finally {
    runtimeState.isCreatingBcfTopics = false;
    updateRefreshButtonState();
    updateDownloadButtonState();
    updateEditCheckSettingsButtonState();
    updateClearModelButtonState();
    updateReportExportActionButtonState();
  }
}

/*
Purpose:
Run selected-row IFC download flow from table selection to in-memory
ArrayBuffer so next implementation step can consume bytes directly.

Logic:
- Validate selected row metadata.
- Resolve access token and active Core API base URL.
- Request signed download URL via `/files/fs/{fileId}/downloadurl`.
- Fetch signed URL bytes into browser memory.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Executes network requests.
- Stores downloaded file bytes in runtime state.
- Updates status text and extension status message.
*/
async function downloadSelectedIfcFileToMemory() {
  if (
    runtimeState.isDownloadingSelectedFile ||
    runtimeState.isLoadingFiles ||
    runtimeState.isRunningCheck ||
    runtimeState.isCreatingBcfTopics
  ) {
    return;
  }

  const selectedFileEntry = runtimeState.selectedFileEntry;
  if (
    !selectedFileEntry ||
    !isNonEmptyString(selectedFileEntry.fileId) ||
    !isNonEmptyString(selectedFileEntry.versionId)
  ) {
    setStatus("Select one IFC row before downloading.", "warning");
    return;
  }

  const coreApiBaseUrl = runtimeState.activeCoreApiBaseUrl;
  if (!isNonEmptyString(coreApiBaseUrl)) {
    setStatus("Core API host was not resolved yet. Refresh file list first.", "warning");
    return;
  }

  try {
    if (!runtimeState.originalRuleDataset) {
      setStatus("Loading checker rule dataset...", "info");
      runtimeState.originalRuleDataset = await loadOriginalRuleDataset();
    }

    const selectedExecutionOptions = await openCheckSelectionModal(runtimeState.originalRuleDataset);
    if (!selectedExecutionOptions) {
      setStatus("Tarkastuksen valinta peruttiin.", "info");
      return;
    }

    runtimeState.checkExecutionOptions = selectedExecutionOptions;
    const selectionSummary = summarizeCheckExecutionOptions(runtimeState.originalRuleDataset, runtimeState.checkExecutionOptions);
    setStatus(`Tarkastusvalinnat paivitetty. ${selectionSummary}`, "info");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Tarkastusvalintojen avaaminen epaonnistui: ${errorMessage}`, "error");
    return;
  }

  runtimeState.isDownloadingSelectedFile = true;
  updateDownloadButtonState();
  updateReportExportActionButtonState();

  try {
    setStatus(`Resolving signed URL for ${selectedFileEntry.name}...`, "info");
    const accessToken = isNonEmptyString(runtimeState.accessToken)
      ? runtimeState.accessToken
      : await ensureAccessToken(runtimeState.workspaceApi);

    const signedDownloadUrl = await requestSignedDownloadUrl(
      coreApiBaseUrl,
      accessToken,
      selectedFileEntry.fileId,
      selectedFileEntry.versionId,
    );

    setStatus(`Downloading ${selectedFileEntry.name} to browser memory...`, "info");
    const downloadedBuffer = await downloadIfcToBrowserMemory(signedDownloadUrl, selectedFileEntry);

    const successMessage = `Downloaded ${selectedFileEntry.name} (${downloadedBuffer.byteLength} bytes) to browser memory.`;
    setStatus(successMessage, "success");

    if (runtimeState.workspaceApi?.extension && typeof runtimeState.workspaceApi.extension.setStatusMessage === "function") {
      await runtimeState.workspaceApi.extension.setStatusMessage(successMessage);
    }

    dispatchIfcFileDownloadedEvent(runtimeState.downloadedIfcFile);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setStatus(`Selected IFC download failed: ${errorMessage}`, "error");
  } finally {
    runtimeState.isDownloadingSelectedFile = false;
    updateDownloadButtonState();
    updateEditCheckSettingsButtonState();
    updateClearModelButtonState();
    updateReportExportActionButtonState();
  }
}

/*
Purpose:
Render IFC file table rows with selection radio and identifier columns so user
can pick exactly one IFC file while seeing both file and folder ids.

Parameters:
fileEntries (Array<{fileId: string, folderId: string, versionId: string, name: string, path: string}>) - files to render

Returns:
void

Possible side effects:
- Replaces table body content.
- Updates file count text.
*/
function renderFileTable(fileEntries) {
  if (!ui.fileTableBody) {
    return;
  }

  ui.fileTableBody.innerHTML = "";

  const normalizedEntries = Array.isArray(fileEntries)
    ? [...fileEntries]
        .filter((fileEntry) => isIfcFileName(fileEntry.name))
        .sort((leftFile, rightFile) =>
          leftFile.path.localeCompare(rightFile.path, undefined, { sensitivity: "base" }),
        )
    : [];

  if (ui.fileCount) {
    ui.fileCount.textContent = String(normalizedEntries.length);
  }

  const hasPreviousSelection = normalizedEntries.some(
    (fileEntry) => buildFileRowKey(fileEntry) === runtimeState.selectedFileRowKey,
  );
  if (!hasPreviousSelection) {
    setSelectedFileEntry(null);
  } else if (runtimeState.selectedFileRowKey) {
    const matchingSelectedEntry =
      normalizedEntries.find((fileEntry) => buildFileRowKey(fileEntry) === runtimeState.selectedFileRowKey) || null;

    if (matchingSelectedEntry) {
      runtimeState.selectedFileEntry = matchingSelectedEntry;
    }
  }

  if (normalizedEntries.length === 0) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 6;
    emptyCell.className = "empty-cell";
    emptyCell.textContent = "No IFC files found in the current project tree.";

    emptyRow.appendChild(emptyCell);
    ui.fileTableBody.appendChild(emptyRow);
    setSelectedFileEntry(null);
    return;
  }

  normalizedEntries.forEach((fileEntry, fileIndex) => {
    const fileRowKey = buildFileRowKey(fileEntry);
    const tableRow = document.createElement("tr");
    tableRow.dataset.rowKey = fileRowKey;

    const selectCell = document.createElement("td");
    selectCell.className = "select-cell";

    const selectInput = document.createElement("input");
    selectInput.type = "radio";
    selectInput.name = "ifc-file-selection";
    selectInput.value = fileRowKey;
    selectInput.checked = runtimeState.selectedFileRowKey === fileRowKey;
    selectInput.setAttribute("aria-label", `Select file ${fileEntry.name}`);

    selectInput.addEventListener("change", () => {
      setSelectedFileEntry(fileEntry);
      setStatus(`Selected IFC file: ${fileEntry.name}`, "info");
    });

    selectCell.appendChild(selectInput);
    tableRow.appendChild(selectCell);

    const indexCell = document.createElement("td");
    indexCell.textContent = String(fileIndex + 1);
    indexCell.className = "index-cell";

    const nameCell = document.createElement("td");
    nameCell.textContent = fileEntry.name;
    nameCell.title = fileEntry.path;

    const fileIdCell = document.createElement("td");
    fileIdCell.textContent = fileEntry.fileId || "-";
    fileIdCell.className = "identifier-cell";

    const folderIdCell = document.createElement("td");
    folderIdCell.textContent = fileEntry.folderId || "-";
    folderIdCell.className = "identifier-cell";

    const versionIdCell = document.createElement("td");
    versionIdCell.textContent = fileEntry.versionId || "-";
    versionIdCell.className = "identifier-cell";

    if (selectInput.checked) {
      tableRow.classList.add("is-selected");
    }

    tableRow.appendChild(indexCell);
    tableRow.appendChild(nameCell);
    tableRow.appendChild(fileIdCell);
    tableRow.appendChild(folderIdCell);
    tableRow.appendChild(versionIdCell);

    tableRow.addEventListener("click", (clickEvent) => {
      if (clickEvent.target instanceof HTMLInputElement && clickEvent.target.type === "radio") {
        return;
      }

      if (!selectInput.checked) {
        selectInput.checked = true;
        selectInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    ui.fileTableBody.appendChild(tableRow);
  });

  syncFileTableSelectionState();
  renderSelectedFileSummary(runtimeState.selectedFileEntry);
  updateDownloadButtonState();
}

/*
Purpose:
Update project metadata labels so user can confirm which project context was
used for file traversal.

Parameters:
projectName (string) - current project display name
projectId (string) - current project id

Returns:
void

Possible side effects:
- Updates project metadata text fields.
*/
function renderProjectMetadata(projectName, projectId) {
  if (ui.projectName) {
    ui.projectName.textContent = projectName;
  }

  if (ui.projectId) {
    ui.projectId.textContent = projectId;
  }
}

/*
Purpose:
Load and render current project's file table in one explicit workflow so status
messages and UI states stay synchronized.

Parameters:
None

Returns:
Promise<void>

Possible side effects:
- Performs network requests.
- Updates status, project metadata, and table rows.
*/
async function loadAndRenderProjectFiles() {
  if (runtimeState.isLoadingFiles) {
    return;
  }

  setLoadingState(true);

  try {
    setStatus("Connecting to Trimble Connect workspace...", "info");
    const workspaceApi = await connectWorkspaceApi();
    await registerMainMenuIfSupported(workspaceApi);

    const projectContext = await readCurrentProjectContext(workspaceApi);
    runtimeState.currentProjectId = projectContext.projectId;
    runtimeState.currentProjectName = projectContext.projectName;
    renderProjectMetadata(projectContext.projectName, projectContext.projectId);

    setStatus("Requesting access token permission...", "info");
    const accessToken = await ensureAccessToken(workspaceApi);

    setStatus("Loading project folder tree and collecting files...", "info");
    const projectFileLoadResult = await loadProjectFiles(
      accessToken,
      projectContext.projectId,
      projectContext.rootFolderId,
    );
    runtimeState.activeCoreApiBaseUrl = projectFileLoadResult.coreApiBaseUrl;
    runtimeState.latestIfcFileEntries = projectFileLoadResult.fileEntries;

    const selectedRowStillExists = runtimeState.latestIfcFileEntries.some(
      (fileEntry) => buildFileRowKey(fileEntry) === runtimeState.selectedFileRowKey,
    );
    if (!selectedRowStillExists) {
      setSelectedFileEntry(null);
    } else if (!runtimeState.selectedFileEntry && runtimeState.selectedFileRowKey) {
      const matchingSelection =
        runtimeState.latestIfcFileEntries.find(
          (fileEntry) => buildFileRowKey(fileEntry) === runtimeState.selectedFileRowKey,
        ) || null;
      setSelectedFileEntry(matchingSelection);
    }

    renderFileTable(runtimeState.latestIfcFileEntries);

    const successMessage = `Loaded ${runtimeState.latestIfcFileEntries.length} IFC file(s) from project tree.`;
    setStatus(successMessage, "success");

    if (workspaceApi?.extension && typeof workspaceApi.extension.setStatusMessage === "function") {
      await workspaceApi.extension.setStatusMessage(successMessage);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    runtimeState.activeCoreApiBaseUrl = "";
    runtimeState.latestIfcFileEntries = [];
    setSelectedFileEntry(null);
    renderFileTable([]);
    setStatus(`File table loading failed: ${errorMessage}`, "error");
  } finally {
    setLoadingState(false);
  }
}

/*
Purpose:
Initialize lightweight file-index page interactions and trigger first load.

Parameters:
None

Returns:
void

Possible side effects:
- Binds refresh button click handler.
- Binds selected-file download button click handler.
- Binds check-settings edit button click handler.
- Binds clear-model action button click handler.
- Binds report export and Create BCFs action handlers.
- Binds IFC-download completion event handler for automatic checker start.
- Forces check-selection modal hidden state at startup.
- Starts asynchronous project file loading.
*/
function initializePage() {
  ui.refreshButton?.addEventListener("click", () => {
    void loadAndRenderProjectFiles();
  });

  ui.downloadSelectedButton?.addEventListener("click", () => {
    void downloadSelectedIfcFileToMemory();
  });

  ui.editCheckSettingsButton?.addEventListener("click", () => {
    void editCheckSettingsForLoadedModel();
  });

  ui.clearModelButton?.addEventListener("click", () => {
    void clearLoadedModelAndResetWorkflow();
  });

  ui.downloadReportButton?.addEventListener("click", () => {
    void exportLatestCheckReportAsJson();
  });

  ui.exportBcfDraftButton?.addEventListener("click", () => {
    void exportLatestBcfDraftAsJson();
  });

  window.addEventListener(IFC_FILE_DOWNLOADED_EVENT, (event) => {
    void handleIfcFileDownloadedEvent(event);
  });

  clearRenderedReport(ui.reportSummary, ui.reportList);
  if (ui.checkSelectionModal) {
    ui.checkSelectionModal.hidden = true;
  }
  if (ui.bcfCreateModal) {
    ui.bcfCreateModal.hidden = true;
  }
  setSelectedFileEntry(null);
  setFileBrowserExpanded(true);
  updateRefreshButtonState();
  updateDownloadButtonState();
  updateEditCheckSettingsButtonState();
  updateClearModelButtonState();
  updateReportExportActionButtonState();

  void loadAndRenderProjectFiles();
}

initializePage();
