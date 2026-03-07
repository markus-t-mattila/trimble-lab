/*
Purpose:
Execute rule checks in a way that mirrors original bundled checker behavior
while keeping the implementation modular and maintainable.

Logic:
- Rebuild original lookup maps from extracted dataset.
- Perform identification matching against product/system code lists.
- Run required-property evaluation with the same skip conditions and severity
  semantics as original QC function.

Parameters:
This module exports a single public function documented below.

Returns:
Structured report object with grouped findings.

Possible side effects:
None
*/

import {
  COMPONENT_IDENTIFY_LABELS,
  PRODUCT_SPECIAL_SKIP_PROPERTY,
  SYSTEM_IDENTIFY_LABELS,
} from "./rules/ruleIdentityConstants.js";

/*
Purpose:
Create property definition lookup map keyed by property id.

Parameters:
propertyDefinitions (Array<object>) - property definition entries

Returns:
object - id -> definition map

Possible side effects:
None
*/
function mapPropertyDefinitionsById(propertyDefinitions) {
  const mapById = {};

  (propertyDefinitions || []).forEach((definition) => {
    if (definition && definition.id) {
      mapById[definition.id] = definition;
    }
  });

  return mapById;
}

/*
Purpose:
Build effective property state map using defaults from original `dZ` map and
fallback to checked when no explicit state exists.

Parameters:
dataset (object) - extracted original dataset
propertyStateOverrides (object | null) - runtime override map from UI selections

Returns:
object - group -> label -> state

Possible side effects:
None
*/
function buildEffectivePropertyStates(dataset, propertyStateOverrides) {
  const stateOverrides = dataset.defaultPropertyStates || {};
  const effectiveStates = {};
  const explicitOverrides = propertyStateOverrides && typeof propertyStateOverrides === "object" ? propertyStateOverrides : {};

  [...(dataset.productPropertyDefinitions || []), ...(dataset.systemPropertyDefinitions || [])].forEach((definition) => {
    if (!definition || !definition.group || !definition.label) {
      return;
    }

    if (!effectiveStates[definition.group]) {
      effectiveStates[definition.group] = {};
    }

    const overrideState = stateOverrides[definition.group]?.[definition.label];
    const explicitState = explicitOverrides[definition.group]?.[definition.label];
    effectiveStates[definition.group][definition.label] = explicitState || overrideState || "checked";
  });

  return effectiveStates;
}

/*
Purpose:
Create allowed-value sets for component identification keys.

Parameters:
productCodeDefinitions (Array<object>) - product code dataset

Returns:
object - label -> Set

Possible side effects:
None
*/
function buildComponentAllowedValueSets(productCodeDefinitions) {
  const safeProductCodeDefinitions = Array.isArray(productCodeDefinitions) ? productCodeDefinitions : [];

  return {
    "01 Komponentin pääryhmä": new Set(safeProductCodeDefinitions.map((entry) => entry?.hierarchy?.[1]).filter(Boolean)),
    "02 Komponentin alaryhmä": new Set(safeProductCodeDefinitions.map((entry) => entry?.hierarchy?.[2]).filter(Boolean)),
    "03 Komponentin koodi": new Set(safeProductCodeDefinitions.map((entry) => entry?.id).filter(Boolean)),
    "04 Komponentin yleisnimi": new Set(safeProductCodeDefinitions.map((entry) => entry?.name).filter(Boolean)),
    "05 Komponentin yleistunnus": new Set(safeProductCodeDefinitions.map((entry) => entry?.generalId).filter(Boolean)),
  };
}

/*
Purpose:
Create allowed-value sets for system identification keys.

Parameters:
systemCodeDefinitions (Array<object>) - system code dataset

Returns:
object - label -> Set

Possible side effects:
None
*/
function buildSystemAllowedValueSets(systemCodeDefinitions) {
  const safeSystemCodeDefinitions = Array.isArray(systemCodeDefinitions) ? systemCodeDefinitions : [];

  return {
    "01 Järjestelmälaji": new Set(safeSystemCodeDefinitions.map((entry) => entry?.hierarchy?.[1]).filter(Boolean)),
    "02 Järjestelmäluokka": new Set(safeSystemCodeDefinitions.map((entry) => entry?.hierarchy?.[2]).filter(Boolean)),
    "03 Järjestelmätyypin koodi": new Set(safeSystemCodeDefinitions.map((entry) => entry?.id).filter(Boolean)),
    "04 Järjestelmätyyppi": new Set(safeSystemCodeDefinitions.map((entry) => entry?.name).filter(Boolean)),
    "05 Järjestelmätyypin yleistunnus": new Set(safeSystemCodeDefinitions.map((entry) => entry?.generalId).filter(Boolean)),
  };
}

/*
Purpose:
Build identification status map for UI and parity with original checker.

Parameters:
identifyLabels (Array<string>) - ordered identify labels
identifyValues (object) - label -> value map
allowedSets (object) - label -> Set

Returns:
object - label -> { value, isWrong }

Possible side effects:
None
*/
function buildIdentifyStatusMap(identifyLabels, identifyValues, allowedSets) {
  const statusMap = {};
  const safeIdentifyValues = identifyValues && typeof identifyValues === "object" ? identifyValues : {};
  const safeAllowedSets = allowedSets && typeof allowedSets === "object" ? allowedSets : {};

  identifyLabels.forEach((label) => {
    const value = safeIdentifyValues[label];
    const allowedSet = safeAllowedSets[label] instanceof Set ? safeAllowedSets[label] : new Set();
    const valueMissing = value === null || value === undefined || value === "";
    const valueWrong = valueMissing || !allowedSet.has(value);

    statusMap[label] = {
      value: valueMissing ? "Puuttuu" : value,
      isWrong: valueWrong,
    };
  });

  return statusMap;
}

/*
Purpose:
Evaluate required property ids using same conditions as original QC function.

Parameters:
requiredPropertyIds (string[]) - required property ids from code definition
propertyDefinitionById (object) - property definition map
propertiesBySet (object) - grouped object properties
identifyLabels (Array<string>) - identify labels to mark mandatory empty values as errors
expressId (number) - object express id
coveringElementIds (Set<number>) - covering-element map
effectivePropertyStates (object) - group->label->state map

Returns:
Array<object> - issue list

Possible side effects:
None
*/
function evaluateRequiredProperties(
  requiredPropertyIds,
  propertyDefinitionById,
  propertiesBySet,
  identifyLabels,
  expressId,
  coveringElementIds,
  effectivePropertyStates,
) {
  const issues = [];
  if (!Array.isArray(requiredPropertyIds)) {
    return issues;
  }
  const safePropertiesBySet = propertiesBySet && typeof propertiesBySet === "object" ? propertiesBySet : {};
  const safeCoveringElementIds = coveringElementIds instanceof Set ? coveringElementIds : new Set();

  requiredPropertyIds.forEach((propertyId) => {
    const propertyDefinition = propertyDefinitionById[propertyId];
    if (!propertyDefinition) {
      return;
    }

    const propertyState = effectivePropertyStates[propertyDefinition.group]?.[propertyDefinition.label];
    if (propertyState === "unchecked") {
      return;
    }

    if (
      propertyDefinition.group === PRODUCT_SPECIAL_SKIP_PROPERTY.group &&
      propertyDefinition.label === PRODUCT_SPECIAL_SKIP_PROPERTY.label &&
      !safeCoveringElementIds.has(expressId)
    ) {
      return;
    }

    const resolvedProperty = safePropertiesBySet[propertyDefinition.group]?.[propertyDefinition.label];
    const isIdentifyProperty = identifyLabels.includes(propertyDefinition.label);

    if (!resolvedProperty) {
      issues.push({
        type: "missing",
        severity: "error",
        propertyGroup: propertyDefinition.group,
        propertyLabel: propertyDefinition.label,
        message: `${propertyDefinition.group} -> ${propertyDefinition.label}: Property is missing`,
      });
      return;
    }

    const value = resolvedProperty.value;
    const valueMissing = value === null || value === undefined || value === "";
    if (valueMissing) {
      issues.push({
        type: "empty",
        severity: isIdentifyProperty ? "error" : "warning",
        propertyGroup: propertyDefinition.group,
        propertyLabel: propertyDefinition.label,
        message: `${propertyDefinition.group} -> ${propertyDefinition.label}: Value is missing`,
      });
      return;
    }

    if (propertyDefinition.ifcPropertyType && resolvedProperty.rawType !== propertyDefinition.ifcPropertyType.toUpperCase()) {
      issues.push({
        type: "wrong_type",
        severity: "warning",
        propertyGroup: propertyDefinition.group,
        propertyLabel: propertyDefinition.label,
        message: `${propertyDefinition.group} -> ${propertyDefinition.label}: Wrong type (expected ${propertyDefinition.ifcPropertyType}, model has ${resolvedProperty.rawType || "Unknown"})`,
      });
    }
  });

  return issues;
}

/*
Purpose:
Find matching product code definition using original five-key identity match.

Parameters:
productCodeDefinitions (Array<object>) - product code entries
identifyValues (object) - component identify values

Returns:
object | null

Possible side effects:
None
*/
function findMatchingProductCode(productCodeDefinitions, identifyValues) {
  const safeIdentifyValues = identifyValues && typeof identifyValues === "object" ? identifyValues : {};

  return (
    (Array.isArray(productCodeDefinitions) ? productCodeDefinitions : []).find(
      (entry) =>
        entry &&
        Array.isArray(entry.hierarchy) &&
        entry.hierarchy.length >= 3 &&
        entry.hierarchy[1] === safeIdentifyValues["01 Komponentin pääryhmä"] &&
        entry.hierarchy[2] === safeIdentifyValues["02 Komponentin alaryhmä"] &&
        entry.id === safeIdentifyValues["03 Komponentin koodi"] &&
        entry.name === safeIdentifyValues["04 Komponentin yleisnimi"] &&
        entry.generalId === safeIdentifyValues["05 Komponentin yleistunnus"],
    ) || null
  );
}

/*
Purpose:
Find matching system code definition using original five-key identity match.

Parameters:
systemCodeDefinitions (Array<object>) - system code entries
identifyValues (object) - system identify values

Returns:
object | null

Possible side effects:
None
*/
function findMatchingSystemCode(systemCodeDefinitions, identifyValues) {
  const safeIdentifyValues = identifyValues && typeof identifyValues === "object" ? identifyValues : {};

  return (
    (Array.isArray(systemCodeDefinitions) ? systemCodeDefinitions : []).find(
      (entry) =>
        entry &&
        Array.isArray(entry.hierarchy) &&
        entry.hierarchy.length >= 3 &&
        entry.hierarchy[1] === safeIdentifyValues["01 Järjestelmälaji"] &&
        entry.hierarchy[2] === safeIdentifyValues["02 Järjestelmäluokka"] &&
        entry.id === safeIdentifyValues["03 Järjestelmätyypin koodi"] &&
        entry.name === safeIdentifyValues["04 Järjestelmätyyppi"] &&
        entry.generalId === safeIdentifyValues["05 Järjestelmätyypin yleistunnus"],
    ) || null
  );
}

/*
Purpose:
Run original-style checks for both product and system scopes.

Parameters:
parsedModel (object) - parser result from webIfcModelParser
ruleDataset (object) - extracted original dataset
checkExecutionOptions (object | null) - user-selected scope/property execution options

Returns:
{
  summary: object,
  modelContext: {
    ifcProjectGlobalId: string,
    ifcProjectName: string,
    ifcLengthUnitToMeters: number
  },
  productFindings: Array<object>,
  systemFindings: Array<object>,
  totalFindings: Array<object>,
  checkBreakdown: object,
  executionProfile: {
    scopes: object,
    phases: object,
    display: { showWarnings: boolean }
  }
}

Possible side effects:
None
*/
export function runModelChecks(parsedModel, ruleDataset, checkExecutionOptions = null) {
  const safeRuleDataset = ruleDataset && typeof ruleDataset === "object" ? ruleDataset : {};
  const safeParsedModel = parsedModel && typeof parsedModel === "object" ? parsedModel : {};
  const parsedObjects = Array.isArray(safeParsedModel.parsedObjects) ? safeParsedModel.parsedObjects : [];
  const coveringElementIds = safeParsedModel.coveringElementIds instanceof Set ? safeParsedModel.coveringElementIds : new Set();

  const productCodeDefinitions = Array.isArray(safeRuleDataset.productCodeDefinitions)
    ? safeRuleDataset.productCodeDefinitions
    : [];
  const systemCodeDefinitions = Array.isArray(safeRuleDataset.systemCodeDefinitions)
    ? safeRuleDataset.systemCodeDefinitions
    : [];

  const productPropertyById = mapPropertyDefinitionsById(safeRuleDataset.productPropertyDefinitions || []);
  const systemPropertyById = mapPropertyDefinitionsById(safeRuleDataset.systemPropertyDefinitions || []);

  const enabledScopes = checkExecutionOptions?.enabledScopes || {};
  const isProductScopeEnabled = enabledScopes.product !== false;
  const isSystemScopeEnabled = enabledScopes.system !== false;
  const enabledCheckPhases = checkExecutionOptions?.enabledCheckPhases || {};
  const isProductIdentificationEnabled = isProductScopeEnabled && enabledCheckPhases.productIdentification !== false;
  const isProductContentEnabled = isProductScopeEnabled && enabledCheckPhases.productContent !== false;
  const isSystemIdentificationEnabled = isSystemScopeEnabled && enabledCheckPhases.systemIdentification !== false;
  const isSystemContentEnabled = isSystemScopeEnabled && enabledCheckPhases.systemContent !== false;
  const showWarningsInReport = checkExecutionOptions?.showWarnings !== false;

  const effectivePropertyStates = buildEffectivePropertyStates(
    safeRuleDataset,
    checkExecutionOptions?.propertyStates || null,
  );
  const componentAllowedSets = buildComponentAllowedValueSets(productCodeDefinitions);
  const systemAllowedSets = buildSystemAllowedValueSets(systemCodeDefinitions);
  const normalizedModelContext = {
    ifcProjectGlobalId: String(safeParsedModel?.modelContext?.ifcProjectGlobalId || "").trim(),
    ifcProjectName: String(safeParsedModel?.modelContext?.ifcProjectName || "").trim(),
    ifcLengthUnitToMeters:
      Number.isFinite(Number(safeParsedModel?.modelContext?.ifcLengthUnitToMeters)) &&
      Number(safeParsedModel?.modelContext?.ifcLengthUnitToMeters) > 0
        ? Number(safeParsedModel?.modelContext?.ifcLengthUnitToMeters)
        : 1,
  };

  const productFindings = [];
  const systemFindings = [];
  const allUnknownFindings = [];
  const checkBreakdown = {
    product: {
      scopeEnabled: isProductScopeEnabled,
      identificationEnabled: isProductIdentificationEnabled,
      contentEnabled: isProductContentEnabled,
      candidateCount: 0,
      matchedCount: 0,
      identifiedCount: 0,
      unidentifiedCount: 0,
      contentCorrectCount: 0,
      contentIncorrectCount: 0,
    },
    system: {
      scopeEnabled: isSystemScopeEnabled,
      identificationEnabled: isSystemIdentificationEnabled,
      contentEnabled: isSystemContentEnabled,
      candidateCount: 0,
      matchedCount: 0,
      identifiedCount: 0,
      unidentifiedCount: 0,
      contentCorrectCount: 0,
      contentIncorrectCount: 0,
    },
  };

  parsedObjects.forEach((parsedObject) => {
    const normalizedParsedObject = parsedObject && typeof parsedObject === "object" ? parsedObject : {};
    const normalizedComponentIdentifyValues =
      normalizedParsedObject.componentIdentifyValues && typeof normalizedParsedObject.componentIdentifyValues === "object"
        ? normalizedParsedObject.componentIdentifyValues
        : {};
    const normalizedSystemIdentifyValues =
      normalizedParsedObject.systemIdentifyValues && typeof normalizedParsedObject.systemIdentifyValues === "object"
        ? normalizedParsedObject.systemIdentifyValues
        : {};
    const normalizedPropertiesBySet =
      normalizedParsedObject.propertiesBySet && typeof normalizedParsedObject.propertiesBySet === "object"
        ? normalizedParsedObject.propertiesBySet
        : {};

    const cleanObjectName =
      normalizedParsedObject.objectName && normalizedParsedObject.objectName.trim() !== ""
        ? normalizedParsedObject.objectName
        : "Unnamed";
    const systemObjectName =
      normalizedParsedObject.objectName && normalizedParsedObject.objectName.trim() !== ""
        ? normalizedParsedObject.objectName
        : "Unnamed";

    if (isProductScopeEnabled && normalizedParsedObject.isComponentCandidate) {
      checkBreakdown.product.candidateCount += 1;
      const matchedProductCode = findMatchingProductCode(productCodeDefinitions, normalizedComponentIdentifyValues);
      const identifyStatus = buildIdentifyStatusMap(
        COMPONENT_IDENTIFY_LABELS,
        normalizedComponentIdentifyValues,
        componentAllowedSets,
      );

      if (matchedProductCode) {
        checkBreakdown.product.matchedCount += 1;

        if (isProductIdentificationEnabled) {
          checkBreakdown.product.identifiedCount += 1;
        }

        if (isProductContentEnabled) {
          const issues = evaluateRequiredProperties(
            matchedProductCode.requiredPropertyIds,
            productPropertyById,
            normalizedPropertiesBySet,
            COMPONENT_IDENTIFY_LABELS,
            normalizedParsedObject.expressId,
            coveringElementIds,
            effectivePropertyStates,
          );
          const hasContentErrors = issues.some((issue) => issue?.severity === "error");

          if (hasContentErrors) {
            checkBreakdown.product.contentIncorrectCount += 1;
          } else {
            checkBreakdown.product.contentCorrectCount += 1;
          }

          if (issues.length > 0) {
            productFindings.push({
              name: cleanObjectName,
              globalId: normalizedParsedObject.globalId,
              issues,
              level3Key: normalizedComponentIdentifyValues["04 Komponentin yleisnimi"] || "Not defined",
              isUnidentified: false,
              identifyProps: identifyStatus,
              ifcEntity: normalizedParsedObject.ifcTypeName,
              expressId: normalizedParsedObject.expressId,
              placementPoint: normalizedParsedObject.placementPoint || null,
            });
          }
        }
      } else if (isProductIdentificationEnabled) {
        checkBreakdown.product.unidentifiedCount += 1;
        const unknownFinding = {
          name: cleanObjectName,
          globalId: normalizedParsedObject.globalId,
          issues: [],
          level3Key: normalizedComponentIdentifyValues["04 Komponentin yleisnimi"] || "Not defined",
          isUnidentified: true,
          identifyProps: identifyStatus,
          ifcEntity: normalizedParsedObject.ifcTypeName,
          expressId: normalizedParsedObject.expressId,
          placementPoint: normalizedParsedObject.placementPoint || null,
        };

        productFindings.push(unknownFinding);
        allUnknownFindings.push({
          scope: "product",
          name: cleanObjectName,
          globalId: normalizedParsedObject.globalId,
        });
      }
    }

    if (isSystemScopeEnabled && normalizedParsedObject.isSystemCandidate) {
      checkBreakdown.system.candidateCount += 1;
      const matchedSystemCode = findMatchingSystemCode(systemCodeDefinitions, normalizedSystemIdentifyValues);
      const identifyStatus = buildIdentifyStatusMap(
        SYSTEM_IDENTIFY_LABELS,
        normalizedSystemIdentifyValues,
        systemAllowedSets,
      );

      if (matchedSystemCode) {
        checkBreakdown.system.matchedCount += 1;

        if (isSystemIdentificationEnabled) {
          checkBreakdown.system.identifiedCount += 1;
        }

        if (isSystemContentEnabled) {
          const issues = evaluateRequiredProperties(
            matchedSystemCode.requiredPropertyIds,
            systemPropertyById,
            normalizedPropertiesBySet,
            SYSTEM_IDENTIFY_LABELS,
            normalizedParsedObject.expressId,
            coveringElementIds,
            effectivePropertyStates,
          );
          const hasContentErrors = issues.some((issue) => issue?.severity === "error");

          if (hasContentErrors) {
            checkBreakdown.system.contentIncorrectCount += 1;
          } else {
            checkBreakdown.system.contentCorrectCount += 1;
          }

          if (issues.length > 0) {
            systemFindings.push({
              name: systemObjectName,
              globalId: normalizedParsedObject.globalId,
              issues,
              level3Key: normalizedSystemIdentifyValues["04 Järjestelmätyyppi"] || "Not defined",
              isUnidentified: false,
              identifyProps: identifyStatus,
              ifcEntity: normalizedParsedObject.ifcTypeName,
              expressId: normalizedParsedObject.expressId,
              placementPoint: normalizedParsedObject.placementPoint || null,
            });
          }
        }
      } else if (isSystemIdentificationEnabled) {
        checkBreakdown.system.unidentifiedCount += 1;
        const unknownFinding = {
          name: systemObjectName,
          globalId: normalizedParsedObject.globalId,
          issues: [],
          level3Key: normalizedSystemIdentifyValues["04 Järjestelmätyyppi"] || "Not defined",
          isUnidentified: true,
          identifyProps: identifyStatus,
          ifcEntity: normalizedParsedObject.ifcTypeName,
          expressId: normalizedParsedObject.expressId,
          placementPoint: normalizedParsedObject.placementPoint || null,
        };

        systemFindings.push(unknownFinding);
        allUnknownFindings.push({
          scope: "system",
          name: systemObjectName,
          globalId: normalizedParsedObject.globalId,
        });
      }
    }
  });

  const totalIssues = [...productFindings, ...systemFindings].reduce((sum, finding) => sum + finding.issues.length, 0);
  const errorCount = [...productFindings, ...systemFindings].reduce(
    (sum, finding) => sum + finding.issues.filter((issue) => issue.severity === "error").length,
    0,
  );
  const warningCount = [...productFindings, ...systemFindings].reduce(
    (sum, finding) => sum + finding.issues.filter((issue) => issue.severity === "warning").length,
    0,
  );

  return {
    summary: {
      checkedObjects: parsedObjects.length,
      productFindings: productFindings.length,
      systemFindings: systemFindings.length,
      totalIssues,
      errorCount,
      warningCount,
      unidentifiedFindings: allUnknownFindings.length,
    },
    modelContext: normalizedModelContext,
    productFindings,
    systemFindings,
    totalFindings: [...productFindings, ...systemFindings],
    unknownFindings: allUnknownFindings,
    checkBreakdown,
    executionProfile: {
      scopes: {
        product: isProductScopeEnabled,
        system: isSystemScopeEnabled,
      },
      phases: {
        productIdentification: isProductIdentificationEnabled,
        productContent: isProductContentEnabled,
        systemIdentification: isSystemIdentificationEnabled,
        systemContent: isSystemContentEnabled,
      },
      display: {
        showWarnings: showWarningsInReport,
      },
    },
  };
}
