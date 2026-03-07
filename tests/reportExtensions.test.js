import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelectedIssueRowsForBcfCreation,
  buildBcfDraftPayload,
  buildCheckerReportExportPayload,
  buildExportFileName,
} from "../app/reporting/reportExtensions.js";

/*
Purpose:
Verify export filename generation stays deterministic and filesystem-safe so
users get readable artifact names when saving checker outputs.
*/
test("buildExportFileName creates stable slug and UTC timestamp segment", () => {
  const generatedFileName = buildExportFileName(
    {
      name: "Main Model.IFC",
    },
    "check-report",
    "2026-03-07T08:09:10.000Z",
  );

  assert.equal(generatedFileName, "main-model-check-report-20260307-080910.json");
});

/*
Purpose:
Ensure checker report export payload keeps core metadata and report sections so
future API integrations can rely on one canonical export shape.
*/
test("buildCheckerReportExportPayload keeps metadata and report structure", () => {
  const reportPayload = buildCheckerReportExportPayload({
    reportData: {
      summary: {
        checkedObjects: 5,
      },
      checkBreakdown: {
        product: {
          candidateCount: 4,
        },
      },
      executionProfile: {
        scopes: {
          product: true,
        },
      },
      productFindings: [{ name: "Object A", issues: [] }],
      systemFindings: [],
      unknownFindings: [{ scope: "product", name: "Object B" }],
    },
    projectContext: {
      id: "project-1",
      name: "Project One",
    },
    selectedFile: {
      fileId: "file-1",
      versionId: "version-1",
      name: "Main.ifc",
      path: "Root/Main.ifc",
    },
    checkExecutionOptions: {
      enabledScopes: {
        product: true,
        system: false,
      },
    },
    generatedAt: "2026-03-07T09:10:11.000Z",
  });

  assert.equal(reportPayload.schema, "trimble-lab-check-report");
  assert.equal(reportPayload.schemaVersion, "1.0.0");
  assert.equal(reportPayload.project.id, "project-1");
  assert.equal(reportPayload.model.fileId, "file-1");
  assert.equal(reportPayload.summary.checkedObjects, 5);
  assert.equal(reportPayload.findings.product.length, 1);
  assert.equal(reportPayload.findings.unknown.length, 1);
});

/*
Purpose:
Verify BCF draft builder creates one topic per issue and includes synthetic
topic for unidentified findings that do not carry explicit issue rows.
*/
test("buildBcfDraftPayload converts findings into draft topics", () => {
  const bcfDraftPayload = buildBcfDraftPayload({
    reportData: {
      productFindings: [
        {
          name: "Pipe A",
          globalId: "GUID-PIPE-A",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 101,
          isUnidentified: false,
          issues: [
            {
              severity: "error",
              message: "Required property is missing",
              propertyGroup: "FI_Product",
              propertyLabel: "Identifier",
            },
          ],
        },
        {
          name: "Pipe B",
          globalId: "GUID-PIPE-B",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 102,
          isUnidentified: true,
          issues: [],
        },
      ],
      systemFindings: [],
    },
    projectContext: {
      id: "project-2",
      name: "Project Two",
    },
    selectedFile: {
      fileId: "file-2",
      versionId: "version-2",
      name: "Second.ifc",
    },
    generatedAt: "2026-03-07T12:00:00.000Z",
  });

  assert.equal(bcfDraftPayload.schema, "trimble-lab-bcf-draft");
  assert.equal(bcfDraftPayload.statistics.totalTopics, 2);
  assert.equal(bcfDraftPayload.statistics.errorTopics, 1);
  assert.equal(bcfDraftPayload.statistics.warningTopics, 1);
  assert.equal(bcfDraftPayload.topics[0].status, "Open");
  assert.equal(bcfDraftPayload.topics[1].labels.includes("warning"), true);
});

/*
Purpose:
Ensure optional BCF selector filtering keeps only user-selected IFC GUID +
severity combinations so Create BCFs flow exports exactly selected findings.
*/
test("buildBcfDraftPayload filters topics by selected IFC GUID and severity", () => {
  const bcfDraftPayload = buildBcfDraftPayload({
    reportData: {
      productFindings: [
        {
          name: "Pipe A",
          globalId: "GUID-PIPE-A",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 401,
          isUnidentified: false,
          issues: [
            {
              severity: "error",
              message: "Error issue",
              propertyGroup: "FI_Product",
              propertyLabel: "Identifier",
            },
            {
              severity: "warning",
              message: "Warning issue",
              propertyGroup: "FI_Product",
              propertyLabel: "Description",
            },
          ],
        },
        {
          name: "Pipe B",
          globalId: "GUID-PIPE-B",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 402,
          isUnidentified: false,
          issues: [
            {
              severity: "warning",
              message: "Pipe B warning",
              propertyGroup: "FI_Product",
              propertyLabel: "Comment",
            },
          ],
        },
      ],
      systemFindings: [],
    },
    projectContext: {
      id: "project-3",
      name: "Project Three",
    },
    selectedFile: {
      fileId: "file-3",
      versionId: "version-3",
      name: "Third.ifc",
    },
    generatedAt: "2026-03-07T13:00:00.000Z",
    selectedIssueSelectors: [
      { ifcGuid: "GUID-PIPE-A", severity: "error" },
      { ifcGuid: "GUID-PIPE-B", severity: "warning" },
    ],
  });

  assert.equal(bcfDraftPayload.statistics.totalTopics, 2);
  assert.equal(bcfDraftPayload.statistics.errorTopics, 1);
  assert.equal(bcfDraftPayload.statistics.warningTopics, 1);
  assert.equal(
    bcfDraftPayload.topics.every((topic) => {
      const issueSeverity = topic.labels.includes("error") ? "error" : "warning";
      const ifcGuid = topic?.referenceObject?.ifcGuid;
      return (
        (ifcGuid === "GUID-PIPE-A" && issueSeverity === "error") ||
        (ifcGuid === "GUID-PIPE-B" && issueSeverity === "warning")
      );
    }),
    true,
  );
});

/*
Purpose:
Verify issue-row builder used by modal Create BCF flow keeps selection filtering
and carries placement-point metadata for marker/camera payload generation.
*/
test("buildSelectedIssueRowsForBcfCreation returns filtered rows with placement points", () => {
  const selectedIssueRows = buildSelectedIssueRowsForBcfCreation({
    reportData: {
      productFindings: [
        {
          name: "Pipe A",
          globalId: "GUID-PIPE-A",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 601,
          placementPoint: {
            x: 10,
            y: 20,
            z: 30,
          },
          issues: [
            {
              severity: "error",
              message: "Pipe A error",
              propertyGroup: "FI_Product",
              propertyLabel: "Identifier",
            },
          ],
        },
        {
          name: "Pipe B",
          globalId: "GUID-PIPE-B",
          ifcEntity: "IFCPIPESEGMENT",
          expressId: 602,
          placementPoint: {
            x: 1,
            y: 2,
            z: 3,
          },
          issues: [
            {
              severity: "warning",
              message: "Pipe B warning",
              propertyGroup: "FI_Product",
              propertyLabel: "Comment",
            },
          ],
        },
      ],
      systemFindings: [],
    },
    selectedIssueSelectors: [{ ifcGuid: "GUID-PIPE-B", severity: "warning" }],
  });

  assert.equal(selectedIssueRows.length, 1);
  assert.equal(selectedIssueRows[0].globalId, "GUID-PIPE-B");
  assert.equal(selectedIssueRows[0].severity, "warning");
  assert.equal(selectedIssueRows[0].rowId.startsWith("GUID-PIPE-B::warning::"), true);
  assert.deepEqual(selectedIssueRows[0].placementPoint, {
    x: 1,
    y: 2,
    z: 3,
  });
});
