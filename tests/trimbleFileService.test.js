import assert from "node:assert/strict";
import test from "node:test";

import { isIfcFileSelection, normalizeSelectedFile } from "../app/workspace/trimbleFileService.js";

/*
Purpose:
Verify file-selection normalization for both documented and fallback payload
formats so Trimble event handling stays stable as API payloads vary.
*/
test("normalizeSelectedFile supports documented data.file payload", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      source: "file-browser",
      file: {
        id: "file-123",
        name: "MainModel.ifc",
        link: "https://example.test/download.ifc",
        type: "FILE",
      },
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "file-123",
    name: "MainModel.ifc",
    link: "https://example.test/download.ifc",
    type: "FILE",
    fileType: "",
    source: "file-browser",
    versionId: null,
  });
});

/*
Purpose:
Keep backward compatibility with legacy direct-data payload shape used in
earlier integration iterations.
*/
test("normalizeSelectedFile supports legacy direct data payload", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      id: "legacy-file",
      name: "LegacyModel.ifc",
      link: "https://example.test/legacy.ifc",
      type: "FILE",
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "legacy-file",
    name: "LegacyModel.ifc",
    link: "https://example.test/legacy.ifc",
    type: "FILE",
    fileType: "",
    source: "",
    versionId: null,
  });
});

/*
Purpose:
Ensure we do not prioritize Trimble detail viewer UI links when payload also
contains a direct API/download-like URL candidate.
*/
test("normalizeSelectedFile prefers non-detailviewer link candidate", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      file: {
        id: "file-detailviewer",
        name: "DetailViewerModel.ifc",
        link: "https://web.connect.trimble.com/projects/example/detailviewer?fileId=file-detailviewer",
        url: "https://api.example.test/files/file-detailviewer/download",
        type: "FILE",
      },
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "file-detailviewer",
    name: "DetailViewerModel.ifc",
    link: "https://api.example.test/files/file-detailviewer/download",
    type: "FILE",
    fileType: "",
    source: "",
    versionId: null,
  });
});

/*
Purpose:
Verify version identifiers are normalized to strings so cache keys and id-based
download fallback logic work with both numeric and string payload values.
*/
test("normalizeSelectedFile normalizes numeric versionId to string", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      file: {
        id: "file-with-version",
        name: "VersionedModel.ifc",
        link: "https://example.test/download.ifc",
        versionId: 42,
        type: "FILE",
      },
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "file-with-version",
    name: "VersionedModel.ifc",
    link: "https://example.test/download.ifc",
    type: "FILE",
    fileType: "",
    source: "",
    versionId: "42",
  });
});

/*
Purpose:
Ensure normalization can recover file/version identifiers from detailviewer URL
query parameters when explicit id fields are missing in payload.
*/
test("normalizeSelectedFile resolves id and versionId from detailviewer query params", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      file: {
        name: "QueryParamModel.ifc",
        link: "https://web.connect.trimble.com/projects/example/detailviewer?fileId=file-query-1&versionId=ver-query-2",
        type: "FILE",
      },
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "file-query-1",
    name: "QueryParamModel.ifc",
    link: "https://web.connect.trimble.com/projects/example/detailviewer?fileId=file-query-1&versionId=ver-query-2",
    type: "FILE",
    fileType: "",
    source: "",
    versionId: "ver-query-2",
  });
});

/*
Purpose:
Verify alternative id fields from payload are accepted so embedded explorer
shape variations still enable viewer-bridge loading path.
*/
test("normalizeSelectedFile accepts fileId and fileVersionId fallback fields", () => {
  const normalizedFile = normalizeSelectedFile({
    data: {
      file: {
        fileId: "fallback-file-id",
        fileVersionId: "fallback-version-id",
        name: "FallbackFieldsModel.ifc",
        url: "https://example.test/fallback.ifc",
        type: "FILE",
      },
    },
  });

  assert.deepEqual(normalizedFile, {
    id: "fallback-file-id",
    name: "FallbackFieldsModel.ifc",
    link: "https://example.test/fallback.ifc",
    type: "FILE",
    fileType: "",
    source: "",
    versionId: "fallback-version-id",
  });
});

/*
Purpose:
Validate IFC file extension checks that guard download and bridge forwarding.
*/
test("isIfcFileSelection returns expected values", () => {
  assert.equal(isIfcFileSelection({ name: "model.ifc" }), true);
  assert.equal(isIfcFileSelection({ name: "MODEL.IFC" }), true);
  assert.equal(isIfcFileSelection({ name: "model-without-extension", fileType: "application/ifc" }), true);
  assert.equal(isIfcFileSelection({ name: "readme.txt" }), false);
  assert.equal(isIfcFileSelection({ name: "" }), false);
  assert.equal(isIfcFileSelection(null), false);
});
