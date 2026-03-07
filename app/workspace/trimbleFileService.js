/*
Purpose:
Handle all file-related logic for Trimble Connect integration, including event
payload normalization and secure download attempts.

Logic:
- Validate that selected item is an IFC file.
- Prefer direct file link download with bearer token.
- Detect `detailviewer` links that are UI routes instead of binary endpoints.
- Fallback to file-id based Core API endpoint attempts when direct link fails.

Parameters:
This module exposes helper functions; details are documented per function.

Returns:
Utilities for selected file handling and downloading.

Possible side effects:
- Performs network requests with fetch.
*/

/*
Purpose:
Keep string validation in one place so URL and payload checks stay explicit and
do not duplicate fragile `typeof` + trim checks across helper functions.

Parameters:
value (unknown) - value that may or may not contain user/API text

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
Normalize optional scalar payload value into stable non-empty string or null.

Logic:
- Preserve null/undefined as null.
- Convert numbers and other scalar values to string for consistent id handling.
- Trim whitespace and reject empty results.

Parameters:
value (unknown) - payload value that may represent id/version/source text

Returns:
string | null - normalized string or null when not usable

Possible side effects:
None
*/
function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedString = String(value).trim();
  return normalizedString !== "" ? normalizedString : null;
}

/*
Purpose:
Pick the first usable identifier string from a prioritized list of candidates.

Logic:
- Iterate candidates in explicit priority order.
- Normalize every candidate through one shared scalar-to-string converter.
- Return immediately once a non-empty value is found.

Parameters:
candidates (unknown[]) - possible identifier values in priority order

Returns:
string | null - first usable identifier string

Possible side effects:
None
*/
function pickFirstIdentifier(candidates) {
  if (!Array.isArray(candidates)) {
    return null;
  }

  for (const candidateValue of candidates) {
    const normalizedCandidate = normalizeOptionalString(candidateValue);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }
  }

  return null;
}

/*
Purpose:
Read one identifier from URL query parameters with case-insensitive key
matching so payload works even when source uses different naming style.

Parameters:
fileUrlString (string) - URL that may contain file/version parameters
parameterNames (string[]) - accepted query key names in priority order

Returns:
string | null - query parameter value when available

Possible side effects:
None
*/
function readIdentifierFromUrlQuery(fileUrlString, parameterNames) {
  if (!isNonEmptyString(fileUrlString) || !Array.isArray(parameterNames) || parameterNames.length === 0) {
    return null;
  }

  try {
    /*
    Purpose of this fallback:
    Node-based tests do not provide `window.location.origin`, but URL parsing
    still needs an absolute base for relative links. We intentionally use one
    stable placeholder origin so query parsing behaves the same in browser and
    test environments.
    */
    const fallbackBaseOrigin = "https://connect.trimble.invalid";
    const runtimeBaseOrigin =
      typeof window !== "undefined" && window?.location?.origin
        ? window.location.origin
        : fallbackBaseOrigin;
    const parsedUrl = new URL(fileUrlString, runtimeBaseOrigin);
    for (const parameterName of parameterNames) {
      const normalizedParameterName = String(parameterName || "").toLowerCase();
      if (!normalizedParameterName) {
        continue;
      }

      for (const [queryKey, queryValue] of parsedUrl.searchParams.entries()) {
        if (String(queryKey).toLowerCase() !== normalizedParameterName) {
          continue;
        }

        const normalizedValue = normalizeOptionalString(queryValue);
        if (normalizedValue) {
          return normalizedValue;
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
Detect links that point to Trimble Connect detail-view UI routes rather than to
raw downloadable file bytes.

Logic:
The embedded file explorer often returns `.../detailviewer?...` links. Those
routes are intended for browser navigation and are blocked for cross-origin
programmatic fetches in extension contexts.

Parameters:
urlString (string) - candidate URL from file payload

Returns:
boolean - true when URL looks like a detail viewer route

Possible side effects:
None
*/
function isDetailViewerUrl(urlString) {
  if (!isNonEmptyString(urlString)) {
    return false;
  }

  const normalizedCandidate = urlString.toLowerCase();
  return normalizedCandidate.includes("/detailviewer") || normalizedCandidate.includes("detailviewer?");
}

/*
Purpose:
Choose the most promising link-like field from file payload while avoiding
known non-download UI routes when alternatives exist.

Logic:
- Gather candidate fields in order of expected download usefulness.
- Prefer first non-detailviewer link.
- If every candidate is a detailviewer URL, return first available so caller
  can still attempt fallback strategies.

Parameters:
sourceFile (object) - file-like payload object

Returns:
string - chosen link candidate or empty string

Possible side effects:
None
*/
function selectBestLinkCandidate(sourceFile) {
  const linkCandidates = [
    sourceFile.downloadUrl,
    sourceFile.url,
    sourceFile.href,
    sourceFile.self,
    sourceFile.link,
  ].filter((candidateValue) => isNonEmptyString(candidateValue));

  if (linkCandidates.length === 0) {
    return "";
  }

  const nonDetailViewerCandidate = linkCandidates.find(
    (candidateValue) => !isDetailViewerUrl(candidateValue),
  );

  return nonDetailViewerCandidate || linkCandidates[0];
}

/*
Purpose:
Build one normalized file descriptor regardless of whether the event payload
uses `data.file` (Trimble documentation shape) or legacy direct `data`.

Logic:
- Prefer `data.file` because it matches current Workspace API docs.
- Fallback to `data` to stay compatible with older payload variants.
- Select the best available link field and preserve id/version metadata for
  API-based download fallback.

Parameters:
eventArguments (object) - event payload from Workspace API

Returns:
object | null - normalized descriptor or null when payload does not contain file data

Possible side effects:
None
*/
function buildNormalizedFileDescriptor(eventArguments) {
  if (!eventArguments || !eventArguments.data) {
    return null;
  }

  const dataPayload = eventArguments.data;
  const sourceFile = dataPayload.file || dataPayload;
  if (!sourceFile) {
    return null;
  }

  const downloadLink = selectBestLinkCandidate(sourceFile);

  const normalizedId = pickFirstIdentifier([
    sourceFile.id,
    sourceFile.fileId,
    sourceFile.modelId,
    sourceFile.sourceId,
    sourceFile.documentId,
    sourceFile.runtimeId,
    readIdentifierFromUrlQuery(downloadLink, ["fileId", "modelId", "id", "sourceId"]),
  ]);

  const normalizedVersionId = pickFirstIdentifier([
    sourceFile.versionId,
    sourceFile.fileVersionId,
    sourceFile.latestVersionId,
    sourceFile.version,
    readIdentifierFromUrlQuery(downloadLink, ["versionId", "modelVersionId", "latestVersionId"]),
  ]);

  return {
    id: normalizedId,
    name: normalizeOptionalString(sourceFile.name) || "",
    link: downloadLink,
    type: normalizeOptionalString(sourceFile.type) || "",
    fileType:
      normalizeOptionalString(sourceFile.fileType) ||
      normalizeOptionalString(sourceFile.mimeType) ||
      normalizeOptionalString(sourceFile.format) ||
      normalizeOptionalString(sourceFile.extension) ||
      "",
    source: normalizeOptionalString(dataPayload.source) || "",
    versionId: normalizedVersionId,
  };
}

/*
Purpose:
Normalize file selection payload coming from Workspace events so downstream code
can use one stable object shape.

Parameters:
eventArguments (object) - event payload from extension.fileSelected or extension.fileViewClicked

Returns:
object | null - normalized object with id/name/link/type, or null when missing

Possible side effects:
None
*/
export function normalizeSelectedFile(eventArguments) {
  return buildNormalizedFileDescriptor(eventArguments);
}

/*
Purpose:
Check whether a selected item is an IFC file that this checker can process.

Parameters:
selectedFile (object) - normalized selected file descriptor

Returns:
boolean

Possible side effects:
None
*/
export function isIfcFileSelection(selectedFile) {
  if (!selectedFile || typeof selectedFile !== "object") {
    return false;
  }

  if (typeof selectedFile.name === "string" && selectedFile.name.toLowerCase().endsWith(".ifc")) {
    return true;
  }

  const typeHints = [
    selectedFile.fileType,
    selectedFile.mimeType,
    selectedFile.format,
    selectedFile.extension,
    selectedFile.type,
  ]
    .map((candidateHint) => (typeof candidateHint === "string" ? candidateHint.toLowerCase() : ""))
    .filter(Boolean);

  return typeHints.some((candidateHint) => candidateHint.includes("ifc"));
}

/*
Purpose:
Resolve a download URL into an absolute URL so fetch works reliably even if the
event payload provides a relative path.

Parameters:
fileLink (string) - link from normalized file descriptor

Returns:
string - absolute URL for fetch

Possible side effects:
None
*/
function resolveDownloadUrl(fileLink) {
  return new URL(fileLink, window.location.origin).toString();
}

/*
Purpose:
Build request headers for authorized API and binary requests.

Parameters:
accessToken (string | null) - bearer token from permission/event flow
acceptHeader (string) - Accept header value used for request intent

Returns:
object - fetch-compatible header map

Possible side effects:
None
*/
function buildRequestHeaders(accessToken, acceptHeader) {
  const headers = {
    Accept: acceptHeader,
  };

  if (isNonEmptyString(accessToken)) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return headers;
}

/*
Purpose:
Attempt one fetch request and return ArrayBuffer when successful while also
capturing network-level errors such as CORS/preflight failures.

Parameters:
downloadUrl (string) - absolute download URL
headers (object) - request headers
credentialsMode ("omit" | "include" | "same-origin") - fetch credentials mode

Returns:
Promise<{ ok: boolean, status: number, data: ArrayBuffer | null, errorMessage: string }>

Possible side effects:
- Executes HTTP request.
*/
async function tryDownload(downloadUrl, headers = {}, credentialsMode = "omit") {
  let response = null;

  try {
    response = await fetch(downloadUrl, {
      method: "GET",
      headers,
      credentials: credentialsMode,
    });
  } catch (fetchError) {
    return {
      ok: false,
      status: 0,
      data: null,
      errorMessage: fetchError instanceof Error ? fetchError.message : String(fetchError),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data: null,
      errorMessage: "",
      contentType: response.headers.get("content-type") || "",
    };
  }

  return {
    ok: true,
    status: response.status,
    data: await response.arrayBuffer(),
    errorMessage: "",
    contentType: response.headers.get("content-type") || "",
  };
}

/*
Purpose:
Decode a small UTF-8 text prefix from downloaded bytes so payload type can be
identified without converting the full file into string form.

Parameters:
binaryData (ArrayBuffer) - downloaded payload bytes
maximumBytes (number) - prefix length used for text sniffing

Returns:
string - decoded text prefix

Possible side effects:
None
*/
function decodeTextPrefix(binaryData, maximumBytes = 8192) {
  if (!(binaryData instanceof ArrayBuffer)) {
    return "";
  }

  const probeSlice = new Uint8Array(binaryData, 0, Math.min(maximumBytes, binaryData.byteLength));
  return new TextDecoder("utf-8", { fatal: false }).decode(probeSlice);
}

/*
Purpose:
Inspect downloaded payload and decide whether it looks like IFC STEP content,
instead of metadata JSON/HTML or other unsupported formats.

Logic:
- IFC STEP files should contain `ISO-10303-21` near beginning.
- Reject JSON/HTML payloads that indicate metadata endpoints.
- Reject ZIP payloads (`PK`) because web-ifc in this flow expects plain IFC.

Parameters:
binaryData (ArrayBuffer) - downloaded payload bytes
contentType (string) - HTTP response content type

Returns:
{ isValid: boolean, reason: string } - validation result

Possible side effects:
None
*/
function validateIfcPayload(binaryData, contentType = "") {
  if (!(binaryData instanceof ArrayBuffer) || binaryData.byteLength === 0) {
    return {
      isValid: false,
      reason: "Downloaded payload was empty.",
    };
  }

  const bytes = new Uint8Array(binaryData);
  const hasZipSignature = bytes.byteLength >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (hasZipSignature) {
    return {
      isValid: false,
      reason: "Downloaded file is ZIP-compressed. Provide plain .ifc content for web-ifc parser.",
    };
  }

  const normalizedContentType = String(contentType || "").toLowerCase();
  const prefixText = decodeTextPrefix(binaryData).trimStart();
  const normalizedPrefix = prefixText.toLowerCase();

  if (normalizedContentType.includes("application/json") || normalizedPrefix.startsWith("{") || normalizedPrefix.startsWith("[")) {
    return {
      isValid: false,
      reason: "Downloaded payload was JSON metadata instead of IFC file bytes.",
    };
  }

  if (normalizedPrefix.startsWith("<!doctype html") || normalizedPrefix.startsWith("<html")) {
    return {
      isValid: false,
      reason: "Downloaded payload was HTML page instead of IFC file bytes.",
    };
  }

  if (!prefixText.includes("ISO-10303-21")) {
    return {
      isValid: false,
      reason: "Downloaded payload does not contain IFC STEP header (ISO-10303-21).",
    };
  }

  return {
    isValid: true,
    reason: "",
  };
}

/*
Purpose:
Attempt one JSON fetch request and return parsed data when successful.

Parameters:
requestUrl (string) - absolute metadata endpoint URL
headers (object) - request headers
credentialsMode ("omit" | "include" | "same-origin") - fetch credentials mode

Returns:
Promise<{ ok: boolean, status: number, data: object | null, errorMessage: string }>

Possible side effects:
- Executes HTTP request.
*/
async function tryReadJson(requestUrl, headers = {}, credentialsMode = "omit") {
  let response = null;

  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers,
      credentials: credentialsMode,
    });
  } catch (fetchError) {
    return {
      ok: false,
      status: 0,
      data: null,
      errorMessage: fetchError instanceof Error ? fetchError.message : String(fetchError),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data: null,
      errorMessage: "",
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    return {
      ok: false,
      status: response.status,
      data: null,
      errorMessage: "Response was not JSON.",
    };
  }

  try {
    const parsedJson = await response.json();
    return {
      ok: true,
      status: response.status,
      data: parsedJson,
      errorMessage: "",
    };
  } catch (parseError) {
    return {
      ok: false,
      status: response.status,
      data: null,
      errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}

/*
Purpose:
Add URL candidate to list once and keep insertion order stable for deterministic
fallback behavior and easier debug traces.

Parameters:
candidates (Array<string>) - mutable destination list
seenCandidates (Set<string>) - de-duplication set
candidateUrl (string) - potential URL

Returns:
void

Possible side effects:
- Mutates provided list and set.
*/
function pushUniqueUrlCandidate(candidates, seenCandidates, candidateUrl) {
  if (!isNonEmptyString(candidateUrl)) {
    return;
  }

  if (seenCandidates.has(candidateUrl)) {
    return;
  }

  seenCandidates.add(candidateUrl);
  candidates.push(candidateUrl);
}

/*
Purpose:
Build candidate Core API base URLs for file-id-based fallback downloads.

Logic:
- Start with known global/region app hosts used by Trimble Connect Core API.
- Derive host-specific candidate from selected file link when possible.
- Keep de-duplicated deterministic order.

Parameters:
selectedFileLink (string) - link payload from selected file

Returns:
Array<string> - candidate Core API base URLs

Possible side effects:
None
*/
function buildCoreApiBaseUrlCandidates(selectedFileLink) {
  const baseUrlCandidates = [];
  const seenCandidates = new Set();

  const staticCandidates = [
    "https://app.connect.trimble.com/tc/api/2.0",
    "https://app21.connect.trimble.com/tc/api/2.0",
    "https://app31.connect.trimble.com/tc/api/2.0",
    "https://app32.connect.trimble.com/tc/api/2.0",
  ];

  staticCandidates.forEach((candidateBaseUrl) => {
    pushUniqueUrlCandidate(baseUrlCandidates, seenCandidates, candidateBaseUrl);
  });

  if (!isNonEmptyString(selectedFileLink)) {
    return baseUrlCandidates;
  }

  try {
    const selectedLinkUrl = new URL(selectedFileLink, window.location.origin);
    const selectedLinkHost = selectedLinkUrl.host;

    if (selectedLinkHost.startsWith("web.")) {
      const derivedAppHost = selectedLinkHost.replace(/^web\./, "app.");
      pushUniqueUrlCandidate(baseUrlCandidates, seenCandidates, `https://${derivedAppHost}/tc/api/2.0`);
    }
  } catch (urlError) {
    // Ignore host-derivation errors and keep static fallback candidates.
  }

  return baseUrlCandidates;
}

/*
Purpose:
Collect all string URL values recursively from metadata payload so file download
links can be discovered despite shape differences between API responses.

Parameters:
value (unknown) - metadata payload or nested value
collectedUrls (Array<string>) - mutable URL result list
visitedObjects (Set<object>) - recursion guard against cyclic references

Returns:
void

Possible side effects:
- Mutates provided list.
*/
function collectUrlStrings(value, collectedUrls, visitedObjects) {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      collectedUrls.push(value);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  if (visitedObjects.has(value)) {
    return;
  }

  visitedObjects.add(value);

  if (Array.isArray(value)) {
    value.forEach((arrayItem) => {
      collectUrlStrings(arrayItem, collectedUrls, visitedObjects);
    });
    return;
  }

  Object.values(value).forEach((nestedValue) => {
    collectUrlStrings(nestedValue, collectedUrls, visitedObjects);
  });
}

/*
Purpose:
Pick the most promising direct download URL from metadata response payload.

Logic:
- Collect all nested URL strings.
- Prefer non-detailviewer URLs because those are fetchable binary candidates.
- Prefer URLs containing "download" keyword when available.

Parameters:
metadataResponse (object) - parsed metadata response body

Returns:
string - chosen download URL candidate or empty string

Possible side effects:
None
*/
function pickDownloadUrlFromMetadata(metadataResponse) {
  const discoveredUrls = [];
  collectUrlStrings(metadataResponse, discoveredUrls, new Set());

  if (discoveredUrls.length === 0) {
    return "";
  }

  const scoredCandidates = discoveredUrls.map((candidateUrl) => {
    let score = 0;

    if (!isDetailViewerUrl(candidateUrl)) {
      score += 100;
    }
    if (candidateUrl.toLowerCase().includes("download")) {
      score += 20;
    }
    if (candidateUrl.toLowerCase().endsWith(".ifc")) {
      score += 10;
    }

    return {
      candidateUrl,
      score,
    };
  });

  scoredCandidates.sort((leftCandidate, rightCandidate) => rightCandidate.score - leftCandidate.score);
  return scoredCandidates[0]?.candidateUrl || "";
}

/*
Purpose:
Build metadata endpoint candidates that may expose direct download URL fields
for a given project + file id combination.

Parameters:
coreApiBaseUrl (string) - base URL to Core API host
projectId (string) - current project id
fileId (string) - selected file id
versionId (string | null) - selected file version id when available

Returns:
Array<string> - metadata endpoint candidates

Possible side effects:
None
*/
function buildCoreMetadataEndpointCandidates(coreApiBaseUrl, projectId, fileId, versionId) {
  const endpointCandidates = [
    `${coreApiBaseUrl}/projects/${projectId}/files/${fileId}`,
    `${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/versions`,
    `${coreApiBaseUrl}/files/${fileId}`,
  ];

  if (isNonEmptyString(versionId)) {
    endpointCandidates.unshift(`${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/versions/${versionId}`);
    endpointCandidates.push(`${coreApiBaseUrl}/files/${fileId}/versions/${versionId}`);
  }

  return endpointCandidates;
}

/*
Purpose:
Build direct binary endpoint candidates that might return IFC bytes directly
without requiring an additional metadata resolution request.

Parameters:
coreApiBaseUrl (string) - base URL to Core API host
projectId (string) - current project id
fileId (string) - selected file id
versionId (string | null) - selected file version id when available

Returns:
Array<string> - binary endpoint candidates

Possible side effects:
None
*/
function buildCoreBinaryEndpointCandidates(coreApiBaseUrl, projectId, fileId, versionId) {
  const endpointCandidates = [
    `${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/download`,
    `${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/content`,
    `${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/versions/latest/download`,
    `${coreApiBaseUrl}/files/${fileId}/download`,
    `${coreApiBaseUrl}/files/${fileId}/content`,
  ];

  if (isNonEmptyString(versionId)) {
    endpointCandidates.unshift(`${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/versions/${versionId}/download`);
    endpointCandidates.push(`${coreApiBaseUrl}/projects/${projectId}/files/${fileId}/versions/${versionId}/content`);
    endpointCandidates.push(`${coreApiBaseUrl}/files/${fileId}/versions/${versionId}/download`);
  }

  return endpointCandidates;
}

/*
Purpose:
Try to download IFC bytes by resolving file-id-based Core API metadata and/or
binary endpoints when direct selected-file link is not fetchable.

Logic:
1) Iterate Core API host candidates.
2) Try metadata endpoints and extract best download URL from response payload.
3) Try direct binary endpoints as a second route.
4) Return first successful ArrayBuffer result.

Parameters:
selectedFile (object) - normalized selected file descriptor
projectId (string) - current Trimble project id
accessToken (string) - bearer token

Returns:
Promise<{ ok: boolean, data: ArrayBuffer | null, diagnostics: Array<string> }>

Possible side effects:
- Performs multiple network requests across fallback endpoints.
*/
async function tryDownloadViaFileIdCoreApi(selectedFile, projectId, accessToken) {
  const diagnostics = [];
  const fileId = selectedFile?.id;
  const versionId = selectedFile?.versionId || null;

  if (!isNonEmptyString(projectId) || !isNonEmptyString(fileId) || !isNonEmptyString(accessToken)) {
    diagnostics.push("Core API id-based fallback was skipped because projectId, fileId or access token was missing.");
    return {
      ok: false,
      data: null,
      diagnostics,
    };
  }

  const coreApiBaseUrls = buildCoreApiBaseUrlCandidates(selectedFile.link);
  const jsonHeaders = buildRequestHeaders(accessToken, "application/json");
  const binaryHeaders = buildRequestHeaders(accessToken, "application/octet-stream,*/*");

  for (const coreApiBaseUrl of coreApiBaseUrls) {
    const metadataEndpoints = buildCoreMetadataEndpointCandidates(coreApiBaseUrl, projectId, fileId, versionId);
    for (const metadataEndpoint of metadataEndpoints) {
      const metadataAttempt = await tryReadJson(metadataEndpoint, jsonHeaders, "omit");
      diagnostics.push(`Metadata ${metadataEndpoint} -> ${metadataAttempt.status || "network-error"}`);

      if (!metadataAttempt.ok || !metadataAttempt.data) {
        continue;
      }

      const discoveredDownloadUrl = pickDownloadUrlFromMetadata(metadataAttempt.data);
      if (!isNonEmptyString(discoveredDownloadUrl)) {
        continue;
      }

      const resolvedDownloadUrl = resolveDownloadUrl(discoveredDownloadUrl);
      const downloadAttempt = await tryDownload(resolvedDownloadUrl, binaryHeaders, "omit");
      diagnostics.push(`Metadata URL download ${resolvedDownloadUrl} -> ${downloadAttempt.status || "network-error"}`);

      if (downloadAttempt.ok) {
        const payloadValidation = validateIfcPayload(downloadAttempt.data, downloadAttempt.contentType);
        if (!payloadValidation.isValid) {
          diagnostics.push(`Metadata URL payload rejected: ${payloadValidation.reason}`);
          continue;
        }

        return {
          ok: true,
          data: downloadAttempt.data,
          diagnostics,
        };
      }
    }

    const binaryEndpoints = buildCoreBinaryEndpointCandidates(coreApiBaseUrl, projectId, fileId, versionId);
    for (const binaryEndpoint of binaryEndpoints) {
      const binaryAttempt = await tryDownload(binaryEndpoint, binaryHeaders, "omit");
      diagnostics.push(`Binary ${binaryEndpoint} -> ${binaryAttempt.status || "network-error"}`);

      if (binaryAttempt.ok) {
        const payloadValidation = validateIfcPayload(binaryAttempt.data, binaryAttempt.contentType);
        if (!payloadValidation.isValid) {
          diagnostics.push(`Binary payload rejected: ${payloadValidation.reason}`);
          continue;
        }

        return {
          ok: true,
          data: binaryAttempt.data,
          diagnostics,
        };
      }
    }
  }

  return {
    ok: false,
    data: null,
    diagnostics,
  };
}

/*
Purpose:
Attempt direct selected-link download using both authorized and implicit-auth
requests while returning detailed diagnostics for caller-facing error output.

Parameters:
resolvedDownloadUrl (string) - absolute URL candidate
accessToken (string | null) - bearer token from permission flow

Returns:
Promise<{ ok: boolean, data: ArrayBuffer | null, diagnostics: Array<string> }>

Possible side effects:
- Executes one or two HTTP requests.
*/
async function tryDirectLinkDownload(resolvedDownloadUrl, accessToken) {
  const diagnostics = [];
  const authorizedHeaders = buildRequestHeaders(accessToken, "application/octet-stream,*/*");

  const authorizedAttempt = await tryDownload(resolvedDownloadUrl, authorizedHeaders, "omit");
  diagnostics.push(
    `Direct authorized ${resolvedDownloadUrl} -> ${
      authorizedAttempt.status || authorizedAttempt.errorMessage || "network-error"
    }`,
  );
  if (authorizedAttempt.ok) {
    const payloadValidation = validateIfcPayload(authorizedAttempt.data, authorizedAttempt.contentType);
    if (!payloadValidation.isValid) {
      diagnostics.push(`Direct authorized payload rejected: ${payloadValidation.reason}`);
    } else {
      return {
        ok: true,
        data: authorizedAttempt.data,
        diagnostics,
      };
    }
  }

  // Cookie-based fallback is still useful for some environments where links are
  // browser-session authorized instead of bearer-token authorized.
  const fallbackAttempt = await tryDownload(resolvedDownloadUrl, {}, "include");
  diagnostics.push(
    `Direct fallback ${resolvedDownloadUrl} -> ${fallbackAttempt.status || fallbackAttempt.errorMessage || "network-error"}`,
  );
  if (fallbackAttempt.ok) {
    const payloadValidation = validateIfcPayload(fallbackAttempt.data, fallbackAttempt.contentType);
    if (!payloadValidation.isValid) {
      diagnostics.push(`Direct fallback payload rejected: ${payloadValidation.reason}`);
      return {
        ok: false,
        data: null,
        diagnostics,
      };
    }

    return {
      ok: true,
      data: fallbackAttempt.data,
      diagnostics,
    };
  }

  return {
    ok: false,
    data: null,
    diagnostics,
  };
}

/*
Purpose:
Convert diagnostics list to one concise string so caller can display a compact,
actionable error message without losing technical trace points.

Parameters:
diagnostics (Array<string>) - collected fallback trace lines

Returns:
string - compact joined diagnostics

Possible side effects:
None
*/
function formatDiagnosticsSummary(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return "";
  }

  const diagnosticsLimit = 12;
  const trimmedDiagnostics = diagnostics.slice(0, diagnosticsLimit);
  const hasMoreDiagnostics = diagnostics.length > diagnosticsLimit;
  const diagnosticsSuffix = hasMoreDiagnostics ? ` | ... (+${diagnostics.length - diagnosticsLimit} more attempts)` : "";

  return `${trimmedDiagnostics.join(" | ")}${diagnosticsSuffix}`;
}

/*
Purpose:
Check whether link is present and resolves to valid absolute URL.

Parameters:
selectedFile (object) - normalized selected file descriptor

Returns:
string - resolved URL or empty string

Possible side effects:
None
*/
function resolveSelectedFileLink(selectedFile) {
  if (!selectedFile || !isNonEmptyString(selectedFile.link)) {
    return "";
  }

  try {
    return resolveDownloadUrl(selectedFile.link);
  } catch (urlError) {
    return "";
  }
}

/*
Purpose:
Decide whether Core API fallback requests are technically reasonable from the
current extension origin.

Logic:
Direct browser calls to `app*.connect.trimble.com` are usually blocked by CORS
when extension is hosted on third-party domains (for example GitHub Pages). In
that case, retrying many Core API endpoints only creates noise and delays.

Parameters:
None

Returns:
boolean - true when current origin is within connect.trimble.com domain

Possible side effects:
None
*/
function canUseCoreApiFallbackFromCurrentOrigin() {
  const currentHostName = window.location.hostname.toLowerCase();
  return currentHostName === "connect.trimble.com" || currentHostName.endsWith(".connect.trimble.com");
}

/*
Purpose:
Download selected IFC content into ArrayBuffer so it can be sent to the active
checker pipeline in-memory without writing to disk.

Logic:
1) Resolve direct link and prefer it when it is not a detailviewer route.
2) If direct route fails, use projectId + fileId Core API fallback.
3) As last resort, attempt direct route even when it is a detailviewer URL.

Parameters:
selectedFile (object) - normalized selected file descriptor
accessToken (string | null) - bearer token from Trimble permission event
projectId (string) - current Trimble project id

Returns:
Promise<ArrayBuffer>

Possible side effects:
- Executes multiple HTTP requests across fallback routes.
- Throws when all download strategies fail.
*/
export async function downloadSelectedIfcAsArrayBuffer(selectedFile, accessToken, projectId = "") {
  if (!selectedFile) {
    throw new Error("Selected file is missing.");
  }

  const collectedDiagnostics = [];
  const resolvedLinkUrl = resolveSelectedFileLink(selectedFile);
  const hasNonDetailViewerLink = isNonEmptyString(resolvedLinkUrl) && !isDetailViewerUrl(resolvedLinkUrl);

  if (hasNonDetailViewerLink) {
    const directAttempt = await tryDirectLinkDownload(resolvedLinkUrl, accessToken);
    collectedDiagnostics.push(...directAttempt.diagnostics);
    if (directAttempt.ok) {
      return directAttempt.data;
    }
  } else if (isNonEmptyString(resolvedLinkUrl)) {
    collectedDiagnostics.push("Selected file link points to detailviewer UI route, not direct IFC bytes.");
  }

  if (canUseCoreApiFallbackFromCurrentOrigin()) {
    const coreApiAttempt = await tryDownloadViaFileIdCoreApi(selectedFile, projectId, accessToken);
    collectedDiagnostics.push(...coreApiAttempt.diagnostics);
    if (coreApiAttempt.ok) {
      return coreApiAttempt.data;
    }
  } else {
    collectedDiagnostics.push(
      `Core API fallback skipped for origin ${window.location.origin} because cross-origin browser fetch is blocked by CORS.`,
    );
  }

  if (isNonEmptyString(resolvedLinkUrl) && !hasNonDetailViewerLink) {
    const lastResortDirectAttempt = await tryDirectLinkDownload(resolvedLinkUrl, accessToken);
    collectedDiagnostics.push(...lastResortDirectAttempt.diagnostics);
    if (lastResortDirectAttempt.ok) {
      return lastResortDirectAttempt.data;
    }
  }

  throw new Error(
    `IFC download failed for file id "${selectedFile.id || "unknown"}". ${
      formatDiagnosticsSummary(collectedDiagnostics)
    } Select IFC from a source that provides direct downloadable link (not detailviewer URL).`,
  );
}
