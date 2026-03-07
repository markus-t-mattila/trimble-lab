import assert from "node:assert/strict";
import test from "node:test";

import { runModelChecks } from "../app/checker/checkerEngine.js";

/*
Purpose:
Create one compact dataset fixture that mirrors the same shape used by the
production checker engine while keeping test intent focused and readable.

Parameters:
None

Returns:
object - rule dataset fixture for checker-engine tests

Possible side effects:
None
*/
function createRuleDatasetFixture() {
  return {
    productCodeDefinitions: [
      {
        hierarchy: [null, "HVAC", "Pipes"],
        id: "P-001",
        name: "Main pipe",
        generalId: "PIPE-GEN",
        requiredPropertyIds: ["prod-required-text", "prod-length-type"],
      },
    ],
    systemCodeDefinitions: [
      {
        hierarchy: [null, "Ventilation", "Supply"],
        id: "S-001",
        name: "Supply system",
        generalId: "SYS-GEN",
        requiredPropertyIds: ["sys-required-code"],
      },
    ],
    productPropertyDefinitions: [
      {
        id: "prod-required-text",
        group: "FI_Technical",
        label: "Required text",
        ifcPropertyType: "IfcText",
      },
      {
        id: "prod-length-type",
        group: "FI_Geometry",
        label: "Length",
        ifcPropertyType: "IfcPositiveLengthMeasure",
      },
    ],
    systemPropertyDefinitions: [
      {
        id: "sys-required-code",
        group: "FI_System",
        label: "System code",
        ifcPropertyType: "IfcText",
      },
    ],
    defaultPropertyStates: {},
  };
}

/*
Purpose:
Build a parsed-model fixture with one matched product object (errors + warnings),
one unidentified product object, and one matched system object with valid data.

Parameters:
None

Returns:
object - parsed model fixture for checker-engine tests

Possible side effects:
None
*/
function createParsedModelFixture() {
  return {
    coveringElementIds: new Set(),
    parsedObjects: [
      {
        expressId: 101,
        globalId: "GUID-PRODUCT-1",
        objectName: "Product with deviations",
        ifcTypeName: "IFCPIPESEGMENT",
        isComponentCandidate: true,
        isSystemCandidate: false,
        componentIdentifyValues: {
          "01 Komponentin pääryhmä": "HVAC",
          "02 Komponentin alaryhmä": "Pipes",
          "03 Komponentin koodi": "P-001",
          "04 Komponentin yleisnimi": "Main pipe",
          "05 Komponentin yleistunnus": "PIPE-GEN",
        },
        systemIdentifyValues: {},
        propertiesBySet: {
          FI_Geometry: {
            Length: {
              value: 1250,
              rawType: "IFCTEXT",
            },
          },
        },
      },
      {
        expressId: 102,
        globalId: "GUID-PRODUCT-2",
        objectName: "Unidentified product",
        ifcTypeName: "IFCPIPESEGMENT",
        isComponentCandidate: true,
        isSystemCandidate: false,
        componentIdentifyValues: {
          "01 Komponentin pääryhmä": "HVAC",
          "02 Komponentin alaryhmä": "Pipes",
          "03 Komponentin koodi": "UNKNOWN",
          "04 Komponentin yleisnimi": "Unknown pipe",
          "05 Komponentin yleistunnus": "UNKNOWN",
        },
        systemIdentifyValues: {},
        propertiesBySet: {},
      },
      {
        expressId: 201,
        globalId: "GUID-SYSTEM-1",
        objectName: "Valid system",
        ifcTypeName: "IFCSYSTEM",
        isComponentCandidate: false,
        isSystemCandidate: true,
        componentIdentifyValues: {},
        systemIdentifyValues: {
          "01 Järjestelmälaji": "Ventilation",
          "02 Järjestelmäluokka": "Supply",
          "03 Järjestelmätyypin koodi": "S-001",
          "04 Järjestelmätyyppi": "Supply system",
          "05 Järjestelmätyypin yleistunnus": "SYS-GEN",
        },
        propertiesBySet: {
          FI_System: {
            "System code": {
              value: "S-001",
              rawType: "IFCTEXT",
            },
          },
        },
      },
    ],
  };
}

/*
Purpose:
Build a parsed-model fixture where matched product content contains only
warning-severity deviations. This fixture protects the rule that warning-only
objects are still considered structurally correct in breakdown metrics.

Parameters:
None

Returns:
object - parsed model fixture with one warning-only product object

Possible side effects:
None
*/
function createWarningOnlyParsedModelFixture() {
  return {
    coveringElementIds: new Set(),
    parsedObjects: [
      {
        expressId: 301,
        globalId: "GUID-PRODUCT-WARNING-ONLY",
        objectName: "Product with warning only",
        ifcTypeName: "IFCPIPESEGMENT",
        isComponentCandidate: true,
        isSystemCandidate: false,
        componentIdentifyValues: {
          "01 Komponentin pääryhmä": "HVAC",
          "02 Komponentin alaryhmä": "Pipes",
          "03 Komponentin koodi": "P-001",
          "04 Komponentin yleisnimi": "Main pipe",
          "05 Komponentin yleistunnus": "PIPE-GEN",
        },
        systemIdentifyValues: {},
        propertiesBySet: {
          FI_Technical: {
            "Required text": {
              value: "Exists",
              rawType: "IFCTEXT",
            },
          },
          FI_Geometry: {
            Length: {
              value: 1250,
              rawType: "IFCTEXT",
            },
          },
        },
      },
    ],
  };
}

/*
Purpose:
Verify baseline checker result when all scopes/phases are enabled:
- product missing-property error is counted as error
- product wrong-type issue is counted as warning
- unidentified product is still reported
- valid system object does not create false findings
*/
test("runModelChecks separates errors and warnings in baseline flow", () => {
  const result = runModelChecks(createParsedModelFixture(), createRuleDatasetFixture(), null);

  assert.equal(result.summary.checkedObjects, 3);
  assert.equal(result.summary.errorCount, 1);
  assert.equal(result.summary.warningCount, 1);
  assert.equal(result.productFindings.length, 2);
  assert.equal(result.systemFindings.length, 0);
  assert.equal(result.checkBreakdown.product.unidentifiedCount, 1);
  assert.equal(result.checkBreakdown.system.contentCorrectCount, 1);
  assert.equal(result.executionProfile.display.showWarnings, true);
});

/*
Purpose:
Ensure content phase can be disabled independently from identification so users
can run only recognition checks from settings modal selections.
*/
test("runModelChecks honors disabled content phase for product scope", () => {
  const result = runModelChecks(createParsedModelFixture(), createRuleDatasetFixture(), {
    enabledScopes: {
      product: true,
      system: false,
    },
    enabledCheckPhases: {
      productIdentification: true,
      productContent: false,
      systemIdentification: false,
      systemContent: false,
    },
    propertyStates: {},
  });

  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.warningCount, 0);
  assert.equal(result.productFindings.length, 1);
  assert.equal(result.productFindings[0].isUnidentified, true);
  assert.equal(result.checkBreakdown.product.contentIncorrectCount, 0);
  assert.equal(result.checkBreakdown.product.contentCorrectCount, 0);
});

/*
Purpose:
Verify per-property toggle support from check-selection UI by asserting that
unchecked property states suppress both missing and wrong-type findings.
*/
test("runModelChecks skips properties that are unchecked by execution options", () => {
  const result = runModelChecks(createParsedModelFixture(), createRuleDatasetFixture(), {
    enabledScopes: {
      product: true,
      system: false,
    },
    enabledCheckPhases: {
      productIdentification: true,
      productContent: true,
      systemIdentification: false,
      systemContent: false,
    },
    propertyStates: {
      FI_Technical: {
        "Required text": "unchecked",
      },
      FI_Geometry: {
        Length: "unchecked",
      },
    },
  });

  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.warningCount, 0);
  assert.equal(result.productFindings.length, 1);
  assert.equal(result.productFindings[0].isUnidentified, true);
  assert.equal(result.checkBreakdown.product.contentIncorrectCount, 0);
});

/*
Purpose:
Verify explicit warning-visibility toggle is carried into execution profile so
report rendering can hide warning columns and warning controls deterministically.
*/
test("runModelChecks exposes showWarnings=false in execution profile when requested", () => {
  const result = runModelChecks(createParsedModelFixture(), createRuleDatasetFixture(), {
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
    propertyStates: {},
  });

  assert.equal(result.executionProfile.display.showWarnings, false);
});

/*
Purpose:
Ensure breakdown logic treats warning-only objects as structurally correct:
- warning findings are still reported for user visibility
- incorrect-content counter increments only when at least one error exists
*/
test("runModelChecks counts warning-only content as correct in breakdown", () => {
  const result = runModelChecks(createWarningOnlyParsedModelFixture(), createRuleDatasetFixture(), {
    enabledScopes: {
      product: true,
      system: false,
    },
    enabledCheckPhases: {
      productIdentification: true,
      productContent: true,
      systemIdentification: false,
      systemContent: false,
    },
    propertyStates: {},
  });

  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.warningCount, 1);
  assert.equal(result.productFindings.length, 1);
  assert.equal(result.productFindings[0].issues.every((issue) => issue.severity === "warning"), true);
  assert.equal(result.checkBreakdown.product.matchedCount, 1);
  assert.equal(result.checkBreakdown.product.contentCorrectCount, 1);
  assert.equal(result.checkBreakdown.product.contentIncorrectCount, 0);
});

/*
Purpose:
Ensure checker result carries parser-level model context values so downstream
BCF integrations can link created topics to IFC project identifiers.
*/
test("runModelChecks exposes parser model context in result payload", () => {
  const parsedModel = createParsedModelFixture();
  parsedModel.modelContext = {
    ifcProjectGlobalId: "0J$yPqHBD12v72y4qF6XcD",
    ifcProjectName: "Office Building",
  };

  const result = runModelChecks(parsedModel, createRuleDatasetFixture(), null);

  assert.equal(result.modelContext.ifcProjectGlobalId, "0J$yPqHBD12v72y4qF6XcD");
  assert.equal(result.modelContext.ifcProjectName, "Office Building");
});

/*
Purpose:
Ensure checker engine stays fail-safe when caller accidentally passes missing
or malformed inputs. This protects public extension runtime from hard crashes
and guarantees one predictable empty-report shape instead.
*/
test("runModelChecks tolerates missing parsed model and dataset inputs", () => {
  const result = runModelChecks(null, null, null);

  assert.equal(result.summary.checkedObjects, 0);
  assert.equal(result.summary.productFindings, 0);
  assert.equal(result.summary.systemFindings, 0);
  assert.equal(result.summary.totalIssues, 0);
  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.warningCount, 0);
  assert.equal(result.summary.unidentifiedFindings, 0);
  assert.deepEqual(result.productFindings, []);
  assert.deepEqual(result.systemFindings, []);
  assert.equal(result.executionProfile.scopes.product, true);
  assert.equal(result.executionProfile.scopes.system, true);
});

/*
Purpose:
Verify malformed parsed-object rows do not throw when optional nested maps are
missing. The checker should still count candidate rows and emit unidentified
findings when identification phase is enabled.
*/
test("runModelChecks handles malformed parsed objects without throwing", () => {
  const result = runModelChecks(
    {
      parsedObjects: [
        {
          isComponentCandidate: true,
          isSystemCandidate: true,
          objectName: "Malformed object",
        },
      ],
    },
    createRuleDatasetFixture(),
    {
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
      propertyStates: {},
    },
  );

  assert.equal(result.summary.checkedObjects, 1);
  assert.equal(result.productFindings.length, 1);
  assert.equal(result.systemFindings.length, 1);
  assert.equal(result.productFindings[0].isUnidentified, true);
  assert.equal(result.systemFindings[0].isUnidentified, true);
});
