import { WEB_IFC_WASM_PATH } from "../config/webIfcRuntime.js";
import {
  COMPONENT_GROUP_NAME,
  COMPONENT_IDENTIFY_LABELS,
  SYSTEM_GROUP_NAME,
  SYSTEM_IDENTIFY_LABELS,
} from "./rules/ruleIdentityConstants.js";

/*
Purpose:
Parse IFC models with a data flow aligned to the original bundled checker so
rule evaluation can run against equivalent object and PropertySet structures.

Logic:
- Build PropertySet mappings from both object-level and type-level relations.
- Preserve entity-type filtering based on original component/system type lists.
- Preserve covering-element mapping used by one special FI_Tuote rule case.

Parameters:
This module exports helper functions; parameters are documented per function.

Returns:
Parsed object records and helper maps for checker engine.

Possible side effects:
- Initializes and uses web-ifc runtime.
*/

let ifcApiInstance = null;
let ifcTypeNameByCode = null;
let ifcTypeCodeByName = null;

const IFC_SI_PREFIX_SCALE = Object.freeze({
  EXA: 1e18,
  PETA: 1e15,
  TERA: 1e12,
  GIGA: 1e9,
  MEGA: 1e6,
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
  NANO: 1e-9,
  PICO: 1e-12,
  FEMTO: 1e-15,
  ATTO: 1e-18,
});

/*
Purpose:
Build bidirectional IFC type maps from global web-ifc namespace.

Parameters:
webIfcNamespace (object) - global WebIFC namespace

Returns:
{ typeNameByCode: Map<number, string>, typeCodeByName: Map<string, number> }

Possible side effects:
None
*/
function buildIfcTypeMaps(webIfcNamespace) {
  const typeNameByCode = new Map();
  const typeCodeByName = new Map();

  Object.entries(webIfcNamespace).forEach(([constantName, constantValue]) => {
    if (Number.isInteger(constantValue) && constantName.startsWith("IFC")) {
      typeNameByCode.set(constantValue, constantName);
      typeCodeByName.set(constantName, constantValue);
    }
  });

  return {
    typeNameByCode,
    typeCodeByName,
  };
}

/*
Purpose:
Unwrap IFC attribute wrappers (`{ value: ... }`) into plain values.

Parameters:
stepValue (unknown) - IFC attribute value

Returns:
unknown

Possible side effects:
None
*/
function unwrapStepValue(stepValue) {
  if (stepValue && typeof stepValue === "object" && "value" in stepValue) {
    return stepValue.value;
  }

  return stepValue;
}

/*
Purpose:
Normalize one coordinate candidate from IFC placement data into finite number so
placement extraction can safely skip malformed values without breaking parsing.

Parameters:
coordinateCandidate (unknown) - coordinate value candidate

Returns:
number | null - normalized finite number, or null when value is invalid

Possible side effects:
None
*/
function normalizeIfcCoordinateValue(coordinateCandidate) {
  const rawValue = unwrapStepValue(coordinateCandidate);
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

/*
Purpose:
Normalize IFC enum-like values into plain uppercase literals so unit and
placement parsing can compare values reliably across schema/runtime variants.

Logic:
- IFC enums can arrive as bare strings, wrapped `{ value }` objects, or dotted
  literals like `.LENGTHUNIT.`.
- This helper unwraps, trims, uppercases, and removes optional dot wrappers.

Parameters:
enumCandidate (unknown) - IFC enum-like value candidate

Returns:
string - normalized enum literal, or empty string when value is unusable

Possible side effects:
None
*/
function normalizeIfcEnumLiteral(enumCandidate) {
  const rawValue = unwrapStepValue(enumCandidate);
  const normalizedValue = String(rawValue || "")
    .trim()
    .toUpperCase();
  if (!normalizedValue) {
    return "";
  }

  if (normalizedValue.startsWith(".") && normalizedValue.endsWith(".")) {
    return normalizedValue.slice(1, -1);
  }

  return normalizedValue;
}

/*
Purpose:
Map IFC SI prefix literal into numeric scale factor so length-unit conversion to
meters can convert model coordinates into BCF-friendly SI meter values.

Parameters:
prefixCandidate (unknown) - IFC SI prefix candidate (`MILLI`, `CENTI`, ...)

Returns:
number - scale multiplier relative to one meter

Possible side effects:
None
*/
function resolveIfcSiPrefixScale(prefixCandidate) {
  const normalizedPrefix = normalizeIfcEnumLiteral(prefixCandidate);
  if (!normalizedPrefix) {
    return 1;
  }

  return IFC_SI_PREFIX_SCALE[normalizedPrefix] || 1;
}

/*
Purpose:
Resolve IFC length-unit scale factor from current project units so downstream
BCF marker/camera payloads can convert model coordinates into meters.

Logic:
- Read `IfcProject.UnitsInContext`.
- Scan `IfcUnitAssignment.Units` for `LENGTHUNIT`.
- Support `IfcSIUnit` directly (`METRE` + optional prefix).
- Support `IfcConversionBasedUnit` through `ConversionFactor` when available.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
projectLine (object | null) - IFCPROJECT line payload

Returns:
number | null - meters per one model length unit, or null when unresolved

Possible side effects:
None
*/
function resolveIfcLengthUnitToMeters(ifcApi, modelId, projectLine) {
  if (!projectLine || typeof projectLine !== "object") {
    return null;
  }

  const unitAssignmentId = unwrapStepValue(projectLine.UnitsInContext);
  if (!Number.isInteger(unitAssignmentId) || unitAssignmentId <= 0) {
    return null;
  }

  const unitAssignmentLine = safeGetLine(ifcApi, modelId, unitAssignmentId);
  const unitReferences = Array.isArray(unitAssignmentLine?.Units) ? unitAssignmentLine.Units : [];

  for (const unitReference of unitReferences) {
    const unitId = unwrapStepValue(unitReference);
    if (!Number.isInteger(unitId) || unitId <= 0) {
      continue;
    }

    const lengthUnitLine = safeGetLine(ifcApi, modelId, unitId);
    if (!lengthUnitLine || typeof lengthUnitLine !== "object") {
      continue;
    }

    const normalizedUnitType = normalizeIfcEnumLiteral(lengthUnitLine.UnitType);
    if (normalizedUnitType !== "LENGTHUNIT") {
      continue;
    }

    const normalizedUnitName = normalizeIfcEnumLiteral(lengthUnitLine.Name);
    if (normalizedUnitName === "METRE") {
      const siPrefixScale = resolveIfcSiPrefixScale(lengthUnitLine.Prefix);
      return Number.isFinite(siPrefixScale) && siPrefixScale > 0 ? siPrefixScale : 1;
    }

    const conversionFactorId = unwrapStepValue(lengthUnitLine.ConversionFactor);
    if (!Number.isInteger(conversionFactorId) || conversionFactorId <= 0) {
      continue;
    }

    const conversionFactorLine = safeGetLine(ifcApi, modelId, conversionFactorId);
    if (!conversionFactorLine || typeof conversionFactorLine !== "object") {
      continue;
    }

    const conversionValue = Number(unwrapStepValue(conversionFactorLine.ValueComponent));
    if (!Number.isFinite(conversionValue) || conversionValue <= 0) {
      continue;
    }

    let unitComponentScale = 1;
    const unitComponentId = unwrapStepValue(conversionFactorLine.UnitComponent);
    if (Number.isInteger(unitComponentId) && unitComponentId > 0) {
      const unitComponentLine = safeGetLine(ifcApi, modelId, unitComponentId);
      const componentUnitName = normalizeIfcEnumLiteral(unitComponentLine?.Name);
      if (componentUnitName === "METRE") {
        unitComponentScale = resolveIfcSiPrefixScale(unitComponentLine?.Prefix);
      }
    }

    const normalizedLengthUnitScale = conversionValue * unitComponentScale;
    if (Number.isFinite(normalizedLengthUnitScale) && normalizedLengthUnitScale > 0) {
      return normalizedLengthUnitScale;
    }
  }

  return null;
}

/*
Purpose:
Extract XYZ coordinate object from IFC cartesian-point `Coordinates` payload so
placement logic can work with one predictable `{ x, y, z }` shape.

Logic:
- Read first three coordinates from IFC payload.
- Fail fast when any axis is missing or non-numeric.

Parameters:
coordinatesPayload (unknown) - IFC coordinates payload from cartesian point line

Returns:
{ x: number, y: number, z: number } | null - normalized coordinate object

Possible side effects:
None
*/
function extractCartesianPointFromCoordinatesPayload(coordinatesPayload) {
  if (!Array.isArray(coordinatesPayload)) {
    return null;
  }

  const normalizedX = normalizeIfcCoordinateValue(coordinatesPayload[0]);
  const normalizedY = normalizeIfcCoordinateValue(coordinatesPayload[1]);
  const normalizedZ = normalizeIfcCoordinateValue(coordinatesPayload[2]);

  if (normalizedX === null || normalizedY === null || normalizedZ === null) {
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
Normalize one IFC transformation matrix candidate into finite JavaScript number
array so placement calculations can safely trust matrix shape and values.

Parameters:
matrixCandidate (unknown) - matrix candidate from web-ifc runtime

Returns:
number[] | null - normalized 4x4 matrix (length 16) or null when invalid

Possible side effects:
None
*/
function normalizeIfcTransformationMatrix(matrixCandidate) {
  if (!matrixCandidate || typeof matrixCandidate.length !== "number") {
    return null;
  }

  if (matrixCandidate.length < 16) {
    return null;
  }

  const normalizedMatrix = [];
  for (let matrixIndex = 0; matrixIndex < 16; matrixIndex += 1) {
    const numericValue = Number(matrixCandidate[matrixIndex]);
    if (!Number.isFinite(numericValue)) {
      return null;
    }
    normalizedMatrix.push(numericValue);
  }

  return normalizedMatrix;
}

/*
Purpose:
Infer matrix indexing convention from IFC affine transform payload so point
transformation can read translation and orientation values from correct slots.

Logic:
- IFC affine transforms should keep either last row or last column near
  `[0, 0, 0, 1]` depending matrix layout convention.
- Compare both candidates and pick the convention with smaller "affine error".

Parameters:
matrixValues (number[]) - normalized 4x4 matrix values

Returns:
"column-major" | "row-major" - inferred matrix indexing convention

Possible side effects:
None
*/
function inferIfcMatrixConvention(matrixValues) {
  const columnMajorAffineError = Math.abs(matrixValues[3]) + Math.abs(matrixValues[7]) + Math.abs(matrixValues[11]);
  const rowMajorAffineError = Math.abs(matrixValues[12]) + Math.abs(matrixValues[13]) + Math.abs(matrixValues[14]);
  return columnMajorAffineError <= rowMajorAffineError ? "column-major" : "row-major";
}

/*
Purpose:
Transform one XYZ point with IFC 4x4 matrix while honoring inferred matrix
convention, so placement-point conversion can support different runtime layouts.

Parameters:
matrixValues (number[]) - normalized 4x4 matrix values
pointCandidate (object) - source point `{ x, y, z }`
matrixConvention ("column-major" | "row-major") - inferred matrix convention

Returns:
{ x: number, y: number, z: number } | null - transformed finite XYZ point

Possible side effects:
None
*/
function transformPointWithIfcMatrix(matrixValues, pointCandidate, matrixConvention) {
  const normalizedPoint = extractCartesianPointFromCoordinatesPayload([
    pointCandidate?.x,
    pointCandidate?.y,
    pointCandidate?.z,
  ]);
  if (!normalizedPoint) {
    return null;
  }

  let transformedX = 0;
  let transformedY = 0;
  let transformedZ = 0;
  let transformedW = 1;

  if (matrixConvention === "row-major") {
    transformedX =
      normalizedPoint.x * matrixValues[0] +
      normalizedPoint.y * matrixValues[1] +
      normalizedPoint.z * matrixValues[2] +
      matrixValues[3];
    transformedY =
      normalizedPoint.x * matrixValues[4] +
      normalizedPoint.y * matrixValues[5] +
      normalizedPoint.z * matrixValues[6] +
      matrixValues[7];
    transformedZ =
      normalizedPoint.x * matrixValues[8] +
      normalizedPoint.y * matrixValues[9] +
      normalizedPoint.z * matrixValues[10] +
      matrixValues[11];
    transformedW =
      normalizedPoint.x * matrixValues[12] +
      normalizedPoint.y * matrixValues[13] +
      normalizedPoint.z * matrixValues[14] +
      matrixValues[15];
  } else {
    transformedX =
      matrixValues[0] * normalizedPoint.x +
      matrixValues[4] * normalizedPoint.y +
      matrixValues[8] * normalizedPoint.z +
      matrixValues[12];
    transformedY =
      matrixValues[1] * normalizedPoint.x +
      matrixValues[5] * normalizedPoint.y +
      matrixValues[9] * normalizedPoint.z +
      matrixValues[13];
    transformedZ =
      matrixValues[2] * normalizedPoint.x +
      matrixValues[6] * normalizedPoint.y +
      matrixValues[10] * normalizedPoint.z +
      matrixValues[14];
    transformedW =
      matrixValues[3] * normalizedPoint.x +
      matrixValues[7] * normalizedPoint.y +
      matrixValues[11] * normalizedPoint.z +
      matrixValues[15];
  }

  if (!Number.isFinite(transformedX) || !Number.isFinite(transformedY) || !Number.isFinite(transformedZ)) {
    return null;
  }

  if (Number.isFinite(transformedW) && Math.abs(transformedW) > 0.000001) {
    transformedX /= transformedW;
    transformedY /= transformedW;
    transformedZ /= transformedW;
  }

  if (!Number.isFinite(transformedX) || !Number.isFinite(transformedY) || !Number.isFinite(transformedZ)) {
    return null;
  }

  return {
    x: transformedX,
    y: transformedY,
    z: transformedZ,
  };
}

/*
Purpose:
Load one normalized coordination transform once per parse run so placement-point
resolution can reuse matrix payload for every object without repeated API calls.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id

Returns:
{ matrixValues: number[], matrixConvention: "column-major" | "row-major" } | null

Possible side effects:
None
*/
function loadIfcCoordinationTransform(ifcApi, modelId) {
  if (typeof ifcApi?.GetCoordinationMatrix !== "function") {
    return null;
  }

  let coordinationMatrix = null;
  try {
    coordinationMatrix = ifcApi.GetCoordinationMatrix(modelId);
  } catch (error) {
    return null;
  }

  const normalizedCoordinationMatrix = normalizeIfcTransformationMatrix(coordinationMatrix);
  if (!normalizedCoordinationMatrix) {
    return null;
  }

  return {
    matrixValues: normalizedCoordinationMatrix,
    matrixConvention: inferIfcMatrixConvention(normalizedCoordinationMatrix),
  };
}

/*
Purpose:
Resolve object placement point from web-ifc world transform matrix and optional
coordination matrix so BCF marker/camera coordinates align with viewer model
coordinates, including placement rotations and coordinate-origin shifts.

Logic:
- Read object `ObjectPlacement`.
- Resolve world transform matrix for the placement id.
- Transform local origin `(0,0,0)` to world point using inferred convention.
- Apply coordination matrix when runtime exposes one.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
objectLine (object | null) - IFC object line
cachedCoordinationTransform (object | null) - preloaded coordination transform

Returns:
{ x: number, y: number, z: number } | null - placement point from transform matrices

Possible side effects:
None
*/
function readObjectPlacementPointFromWorldTransform(ifcApi, modelId, objectLine, cachedCoordinationTransform) {
  if (!objectLine || typeof objectLine !== "object") {
    return null;
  }

  if (typeof ifcApi?.GetWorldTransformMatrix !== "function") {
    return null;
  }

  const rootPlacementId = unwrapStepValue(objectLine.ObjectPlacement);
  if (!Number.isInteger(rootPlacementId) || rootPlacementId <= 0) {
    return null;
  }

  let worldTransformMatrix = null;
  try {
    worldTransformMatrix = ifcApi.GetWorldTransformMatrix(modelId, rootPlacementId);
  } catch (error) {
    return null;
  }

  const normalizedWorldMatrix = normalizeIfcTransformationMatrix(worldTransformMatrix);
  if (!normalizedWorldMatrix) {
    return null;
  }

  const worldMatrixConvention = inferIfcMatrixConvention(normalizedWorldMatrix);
  let resolvedPoint = transformPointWithIfcMatrix(
    normalizedWorldMatrix,
    { x: 0, y: 0, z: 0 },
    worldMatrixConvention,
  );
  if (!resolvedPoint) {
    return null;
  }

  if (!cachedCoordinationTransform) {
    return resolvedPoint;
  }
  const coordinatedPoint = transformPointWithIfcMatrix(
    cachedCoordinationTransform.matrixValues,
    resolvedPoint,
    cachedCoordinationTransform.matrixConvention,
  );
  return coordinatedPoint || resolvedPoint;
}

/*
Purpose:
Extract approximate model-space placement point for one IFC object by walking
local placement chain and summing relative cartesian offsets.

Logic:
- Resolve object `ObjectPlacement`.
- Traverse `PlacementRelTo` chain until root or loop protection.
- Read `RelativePlacement -> Location -> Coordinates` at each level.
- Sum offsets to produce one approximate absolute point in model space.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
objectLine (object | null) - IFC object line

Returns:
{ x: number, y: number, z: number } | null - resolved placement point when available

Possible side effects:
None
*/
function readApproximateObjectPlacementPointBySummingOffsets(ifcApi, modelId, objectLine) {
  if (!objectLine || typeof objectLine !== "object") {
    return null;
  }

  const rootPlacementId = unwrapStepValue(objectLine.ObjectPlacement);
  if (!Number.isInteger(rootPlacementId) || rootPlacementId <= 0) {
    return null;
  }

  const visitedPlacementIds = new Set();
  let currentPlacementId = rootPlacementId;
  let resolvedPoint = {
    x: 0,
    y: 0,
    z: 0,
  };
  let hasResolvedCoordinate = false;

  while (Number.isInteger(currentPlacementId) && currentPlacementId > 0) {
    if (visitedPlacementIds.has(currentPlacementId)) {
      break;
    }
    visitedPlacementIds.add(currentPlacementId);

    const placementLine = safeGetLine(ifcApi, modelId, currentPlacementId);
    if (!placementLine) {
      break;
    }

    const relativePlacementId = unwrapStepValue(placementLine.RelativePlacement);
    if (Number.isInteger(relativePlacementId) && relativePlacementId > 0) {
      const relativePlacementLine = safeGetLine(ifcApi, modelId, relativePlacementId);
      const locationId = unwrapStepValue(relativePlacementLine?.Location);
      if (Number.isInteger(locationId) && locationId > 0) {
        const locationLine = safeGetLine(ifcApi, modelId, locationId);
        const locationPoint = extractCartesianPointFromCoordinatesPayload(locationLine?.Coordinates);
        if (locationPoint) {
          resolvedPoint = {
            x: resolvedPoint.x + locationPoint.x,
            y: resolvedPoint.y + locationPoint.y,
            z: resolvedPoint.z + locationPoint.z,
          };
          hasResolvedCoordinate = true;
        }
      }
    }

    const parentPlacementId = unwrapStepValue(placementLine.PlacementRelTo);
    if (!Number.isInteger(parentPlacementId) || parentPlacementId <= 0) {
      break;
    }

    currentPlacementId = parentPlacementId;
  }

  return hasResolvedCoordinate ? resolvedPoint : null;
}

/*
Purpose:
Resolve best-effort object placement point for BCF metadata generation.

Logic:
- Prefer world-transform + coordination-matrix based placement because this
  captures placement rotations and coordinate-origin mapping used by viewers.
- Fallback to legacy summed-offset approximation when transform APIs are
  unavailable or matrix payload cannot be resolved.
- If only approximation is available, still try applying coordination matrix so
  large origin shifts are corrected whenever runtime exposes that transform.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
objectLine (object | null) - IFC object line
cachedCoordinationTransform (object | null) - preloaded coordination transform

Returns:
{ x: number, y: number, z: number } | null - resolved placement point when available

Possible side effects:
None
*/
function readObjectPlacementPoint(ifcApi, modelId, objectLine, cachedCoordinationTransform) {
  const worldTransformPoint = readObjectPlacementPointFromWorldTransform(
    ifcApi,
    modelId,
    objectLine,
    cachedCoordinationTransform,
  );
  if (worldTransformPoint) {
    return worldTransformPoint;
  }

  const approximatePoint = readApproximateObjectPlacementPointBySummingOffsets(ifcApi, modelId, objectLine);
  if (!approximatePoint || !cachedCoordinationTransform) {
    return approximatePoint;
  }

  const coordinatedApproximatePoint = transformPointWithIfcMatrix(
    cachedCoordinationTransform.matrixValues,
    approximatePoint,
    cachedCoordinationTransform.matrixConvention,
  );
  return coordinatedApproximatePoint || approximatePoint;
}

/*
Purpose:
Safely read IFC line entity while tolerating isolated malformed references.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
expressId (number) - line id

Returns:
object | null

Possible side effects:
None
*/
function safeGetLine(ifcApi, modelId, expressId) {
  try {
    return ifcApi.GetLine(modelId, expressId);
  } catch (error) {
    return null;
  }
}

/*
Purpose:
Collect ids from web-ifc vector-like response in plain JavaScript array form.

Parameters:
idVector (object) - vector-like object

Returns:
number[]

Possible side effects:
None
*/
function collectIdsFromVector(idVector) {
  if (!idVector || typeof idVector.size !== "function" || typeof idVector.get !== "function") {
    return [];
  }

  const ids = [];
  const vectorLength = idVector.size();
  for (let index = 0; index < vectorLength; index += 1) {
    ids.push(idVector.get(index));
  }

  return ids;
}

/*
Purpose:
Safely request IFC line ids by type and gracefully fallback to empty results
when web-ifc encounters schema/line parsing edge cases.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
typeCode (number | undefined) - IFC entity type code

Returns:
number[] - line ids for requested type

Possible side effects:
None
*/
function safeGetLineIdsWithType(ifcApi, modelId, typeCode) {
  try {
    return collectIdsFromVector(ifcApi.GetLineIDsWithType(modelId, typeCode));
  } catch (error) {
    return [];
  }
}

/*
Purpose:
Safely request all line ids using the most stable API variant available in the
current web-ifc runtime build.

Logic:
- Prefer `GetAllLines` when available.
- Fallback to `GetLineIDsWithType(..., undefined)` for older versions.
- Always handle runtime exceptions and return empty list on failure.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id

Returns:
number[] - all line ids when available

Possible side effects:
None
*/
function safeGetAllLineIds(ifcApi, modelId) {
  try {
    if (typeof ifcApi.GetAllLines === "function") {
      return collectIdsFromVector(ifcApi.GetAllLines(modelId));
    }

    return collectIdsFromVector(ifcApi.GetLineIDsWithType(modelId, undefined));
  } catch (error) {
    return [];
  }
}

/*
Purpose:
Decode a small UTF-8 prefix from IFC byte array for lightweight format checks
before expensive web-ifc operations are executed.

Parameters:
ifcBytes (Uint8Array) - raw downloaded bytes
maximumBytes (number) - prefix byte count to decode

Returns:
string - decoded text prefix

Possible side effects:
None
*/
function decodeIfcTextPrefix(ifcBytes, maximumBytes = 8192) {
  if (!(ifcBytes instanceof Uint8Array) || ifcBytes.byteLength === 0) {
    return "";
  }

  const textSlice = ifcBytes.subarray(0, Math.min(ifcBytes.byteLength, maximumBytes));
  return new TextDecoder("utf-8", { fatal: false }).decode(textSlice);
}

/*
Purpose:
Validate downloaded payload before passing it to web-ifc parser, so runtime
errors from malformed/non-IFC content can be replaced with clear diagnostics.

Logic:
- IFC STEP should contain `ISO-10303-21` near the beginning.
- Reject ZIP payload signature because this flow supports plain IFC only.
- Reject JSON/HTML payloads that usually come from metadata/error endpoints.

Parameters:
ifcBytes (Uint8Array) - downloaded file bytes

Returns:
{ isValid: boolean, reason: string } - validation status and reason

Possible side effects:
None
*/
function validateIfcBinaryPayload(ifcBytes) {
  if (!(ifcBytes instanceof Uint8Array) || ifcBytes.byteLength === 0) {
    return {
      isValid: false,
      reason: "Downloaded IFC payload was empty.",
    };
  }

  const hasZipSignature = ifcBytes.byteLength >= 2 && ifcBytes[0] === 0x50 && ifcBytes[1] === 0x4b;
  if (hasZipSignature) {
    return {
      isValid: false,
      reason: "Downloaded file is ZIP-compressed. This checker expects plain .ifc content.",
    };
  }

  const prefixText = decodeIfcTextPrefix(ifcBytes).trimStart();
  const normalizedPrefix = prefixText.toLowerCase();

  if (normalizedPrefix.startsWith("{") || normalizedPrefix.startsWith("[")) {
    return {
      isValid: false,
      reason: "Downloaded payload appears to be JSON metadata, not IFC bytes.",
    };
  }

  if (normalizedPrefix.startsWith("<!doctype html") || normalizedPrefix.startsWith("<html")) {
    return {
      isValid: false,
      reason: "Downloaded payload appears to be HTML error page, not IFC bytes.",
    };
  }

  if (!prefixText.includes("ISO-10303-21")) {
    return {
      isValid: false,
      reason: "IFC STEP header (ISO-10303-21) was not found in downloaded payload.",
    };
  }

  return {
    isValid: true,
    reason: "",
  };
}

/*
Purpose:
Extract normalized property payload from one IFCPROPERTYSET line.

Parameters:
ifcApi (object) - initialized IfcAPI
modelId (number) - open model id
propertySetLine (object) - IFCPROPERTYSET line
typeNameByCode (Map<number, string>) - IFC type name lookup

Returns:
{ propertySetName: string, propertiesByName: object }

Possible side effects:
None
*/
function readPropertySet(ifcApi, modelId, propertySetLine, typeNameByCode) {
  const propertySetName = unwrapStepValue(propertySetLine.Name) || "Unnamed PropertySet";
  const hasProperties = Array.isArray(propertySetLine.HasProperties) ? propertySetLine.HasProperties : [];

  const propertiesByName = {};
  hasProperties.forEach((propertyRef) => {
    const propertyExpressId = unwrapStepValue(propertyRef);
    if (!propertyExpressId) {
      return;
    }

    const propertyLine = safeGetLine(ifcApi, modelId, propertyExpressId);
    if (!propertyLine) {
      return;
    }

    const propertyName = unwrapStepValue(propertyLine.Name);
    if (!propertyName) {
      return;
    }

    const nominalValue = propertyLine.NominalValue || null;
    const rawTypeCode = nominalValue && typeof nominalValue === "object" ? nominalValue.type : null;

    propertiesByName[propertyName] = {
      value: nominalValue ? unwrapStepValue(nominalValue) : null,
      rawType: rawTypeCode ? typeNameByCode.get(rawTypeCode) || "" : "",
    };
  });

  return {
    propertySetName,
    propertiesByName,
  };
}

/*
Purpose:
Merge properties from one source map into target map by property set and label.

Parameters:
targetProperties (object) - destination nested object map
sourceProperties (object) - source nested object map

Returns:
void

Possible side effects:
- Mutates targetProperties.
*/
function mergePropertiesBySet(targetProperties, sourceProperties) {
  Object.entries(sourceProperties).forEach(([propertySetName, propertyMap]) => {
    if (!targetProperties[propertySetName]) {
      targetProperties[propertySetName] = {};
    }

    Object.entries(propertyMap).forEach(([propertyName, propertyValue]) => {
      targetProperties[propertySetName][propertyName] = propertyValue;
    });
  });
}

/*
Purpose:
Read one identity property subset used for code-list matching.

Parameters:
propertiesBySet (object) - nested property map
labels (string[]) - labels to read from corresponding FI group
groupName (string) - PropertySet group key

Returns:
object

Possible side effects:
None
*/
function readIdentityValues(propertiesBySet, labels, groupName) {
  const values = {};
  labels.forEach((label) => {
    values[label] = propertiesBySet[groupName]?.[label]?.value ?? null;
  });
  return values;
}

/*
Purpose:
Determine whether any identity values are present in object payload.

Parameters:
identityValues (object) - map label -> value

Returns:
boolean

Possible side effects:
None
*/
function hasAnyIdentityValue(identityValues) {
  return Object.values(identityValues).some((value) => value !== null);
}

/*
Purpose:
Initialize web-ifc runtime once and return cached instance + type maps.

Parameters:
None

Returns:
Promise<{ ifcApi: object, typeNameByCode: Map<number, string>, typeCodeByName: Map<string, number> }>

Possible side effects:
- Initializes wasm runtime.
*/
export async function getInitializedWebIfcRuntime() {
  if (ifcApiInstance) {
    return {
      ifcApi: ifcApiInstance,
      typeNameByCode: ifcTypeNameByCode,
      typeCodeByName: ifcTypeCodeByName,
    };
  }

  if (!window.WebIFC || typeof window.WebIFC.IfcAPI !== "function") {
    throw new Error("web-ifc runtime is not available. Ensure web-ifc-api-iife.js is loaded before app/main.js.");
  }

  const typeMaps = buildIfcTypeMaps(window.WebIFC);
  ifcTypeNameByCode = typeMaps.typeNameByCode;
  ifcTypeCodeByName = typeMaps.typeCodeByName;

  ifcApiInstance = new window.WebIFC.IfcAPI();
  // Absolute mode avoids web-ifc prefixing the path with currentScriptPath, which can break nested deploy base paths.
  ifcApiInstance.SetWasmPath(WEB_IFC_WASM_PATH, true);
  await ifcApiInstance.Init();

  return {
    ifcApi: ifcApiInstance,
    typeNameByCode: ifcTypeNameByCode,
    typeCodeByName: ifcTypeCodeByName,
  };
}

/*
Purpose:
Validate that downloaded IFC payload can be opened by web-ifc runtime before
the UI marks model as ready for check execution.

Logic:
- Reuse existing runtime initialization.
- Reuse binary payload validation checks.
- Open and close model once to fail fast on invalid or unsupported IFC content.
- Confirm at least one IFCPROJECT line exists when type constant is available.

Parameters:
ifcArrayBuffer (ArrayBuffer) - downloaded IFC payload

Returns:
Promise<void>

Possible side effects:
- Opens and closes one temporary IFC model in wasm runtime.
*/
export async function verifyIfcModelReadable(ifcArrayBuffer) {
  const { ifcApi } = await getInitializedWebIfcRuntime();
  const ifcBytes = new Uint8Array(ifcArrayBuffer);
  const payloadValidation = validateIfcBinaryPayload(ifcBytes);
  if (!payloadValidation.isValid) {
    throw new Error(payloadValidation.reason);
  }

  let modelId = null;
  try {
    modelId = ifcApi.OpenModel(ifcBytes);
  } catch (openModelError) {
    throw new Error(
      `web-ifc OpenModel failed: ${openModelError instanceof Error ? openModelError.message : String(openModelError)}`,
    );
  }

  try {
    const ifcProjectTypeCode = window.WebIFC?.IFCPROJECT;
    if (Number.isInteger(ifcProjectTypeCode)) {
      const projectLineIds = safeGetLineIdsWithType(ifcApi, modelId, ifcProjectTypeCode);
      if (projectLineIds.length === 0) {
        throw new Error("No IFCPROJECT entity was found in the selected payload.");
      }
    }
  } finally {
    if (typeof modelId === "number") {
      ifcApi.CloseModel(modelId);
    }
  }
}

/*
Purpose:
Parse IFC model in a shape compatible with original rule engine expectations.

Parameters:
ifcArrayBuffer (ArrayBuffer) - IFC binary content
ruleDataset (object) - extracted original rule dataset

Returns:
Promise<{
  parsedObjects: Array<object>,
  coveringElementIds: Set<number>,
  modelContext: {
    ifcProjectGlobalId: string,
    ifcProjectName: string
  }
}>

Possible side effects:
- Opens and closes IFC model.
*/
export async function parseIfcModelForChecking(ifcArrayBuffer, ruleDataset) {
  const { ifcApi, typeNameByCode, typeCodeByName } = await getInitializedWebIfcRuntime();
  const ifcBytes = new Uint8Array(ifcArrayBuffer);
  const payloadValidation = validateIfcBinaryPayload(ifcBytes);
  if (!payloadValidation.isValid) {
    throw new Error(`Model payload validation failed: ${payloadValidation.reason}`);
  }

  let modelId = null;
  try {
    modelId = ifcApi.OpenModel(ifcBytes);
  } catch (openModelError) {
    throw new Error(
      `IFC parser could not open the selected model. ${
        openModelError instanceof Error ? openModelError.message : String(openModelError)
      }`,
    );
  }

  try {
    const coveringElementIds = new Set();
    const allLineIds = safeGetAllLineIds(ifcApi, modelId);
    allLineIds.forEach((lineId) => {
      const line = safeGetLine(ifcApi, modelId, lineId);
      const relatingBuildingElement = unwrapStepValue(line?.RelatingBuildingElement);
      if (relatingBuildingElement !== null && relatingBuildingElement !== undefined) {
        coveringElementIds.add(relatingBuildingElement);
      }
    });

    const psetsByObjectId = new Map();
    const definesByPropertiesTypeCode = typeCodeByName.get("IFCRELDEFINESBYPROPERTIES");
    const definesByTypeTypeCode = typeCodeByName.get("IFCRELDEFINESBYTYPE");

    if (definesByPropertiesTypeCode) {
      const relationIds = safeGetLineIdsWithType(ifcApi, modelId, definesByPropertiesTypeCode);
      relationIds.forEach((relationId) => {
        const relationLine = safeGetLine(ifcApi, modelId, relationId);
        if (!relationLine || !relationLine.RelatingPropertyDefinition || !relationLine.RelatedObjects) {
          return;
        }

        const propertySetExpressId = unwrapStepValue(relationLine.RelatingPropertyDefinition);
        if (!propertySetExpressId) {
          return;
        }

        const propertySetLine = safeGetLine(ifcApi, modelId, propertySetExpressId);
        if (!propertySetLine || !propertySetLine.HasProperties) {
          return;
        }

        const parsedPropertySet = readPropertySet(ifcApi, modelId, propertySetLine, typeNameByCode);
        const relatedObjects = Array.isArray(relationLine.RelatedObjects) ? relationLine.RelatedObjects : [];

        relatedObjects.forEach((relatedObjectRef) => {
          const relatedObjectId = unwrapStepValue(relatedObjectRef);
          if (!relatedObjectId) {
            return;
          }

          if (!psetsByObjectId.has(relatedObjectId)) {
            psetsByObjectId.set(relatedObjectId, []);
          }

          psetsByObjectId.get(relatedObjectId).push(parsedPropertySet);
        });
      });
    }

    const typeIdByObjectId = new Map();
    if (definesByTypeTypeCode) {
      const relationIds = safeGetLineIdsWithType(ifcApi, modelId, definesByTypeTypeCode);
      relationIds.forEach((relationId) => {
        const relationLine = safeGetLine(ifcApi, modelId, relationId);
        if (!relationLine || !relationLine.RelatingType || !relationLine.RelatedObjects) {
          return;
        }

        const relatingTypeId = unwrapStepValue(relationLine.RelatingType);
        if (!relatingTypeId) {
          return;
        }

        const relatedObjects = Array.isArray(relationLine.RelatedObjects) ? relationLine.RelatedObjects : [];
        relatedObjects.forEach((relatedObjectRef) => {
          const relatedObjectId = unwrapStepValue(relatedObjectRef);
          if (!relatedObjectId) {
            return;
          }

          typeIdByObjectId.set(relatedObjectId, relatingTypeId);
        });
      });
    }

    const systemTypeNames = Array.isArray(ruleDataset.systemEntityTypeNames) ? ruleDataset.systemEntityTypeNames : [];
    const componentTypeNames = Array.isArray(ruleDataset.componentEntityTypeNames)
      ? ruleDataset.componentEntityTypeNames
      : [];

    let ifcProjectGlobalId = "";
    let ifcProjectName = "";
    let ifcLengthUnitToMeters = 1;
    const ifcProjectTypeCode = typeCodeByName.get("IFCPROJECT") || window.WebIFC?.IFCPROJECT;
    if (Number.isInteger(ifcProjectTypeCode)) {
      const projectLineIds = safeGetLineIdsWithType(ifcApi, modelId, ifcProjectTypeCode);
      if (projectLineIds.length > 0) {
        const projectLine = safeGetLine(ifcApi, modelId, projectLineIds[0]);
        ifcProjectGlobalId = String(unwrapStepValue(projectLine?.GlobalId) || "").trim();
        ifcProjectName = String(unwrapStepValue(projectLine?.Name) || "").trim();
        const resolvedLengthUnitToMeters = resolveIfcLengthUnitToMeters(ifcApi, modelId, projectLine);
        if (Number.isFinite(resolvedLengthUnitToMeters) && resolvedLengthUnitToMeters > 0) {
          ifcLengthUnitToMeters = resolvedLengthUnitToMeters;
        }
      }
    }

    const systemTypeCodes = new Set(systemTypeNames.map((typeName) => typeCodeByName.get(typeName)).filter(Boolean));
    const componentTypeCodes = new Set(componentTypeNames.map((typeName) => typeCodeByName.get(typeName)).filter(Boolean));
    const targetTypeCodes = Array.from(new Set([...systemTypeCodes, ...componentTypeCodes]));

    const parsedObjects = [];
    const cachedCoordinationTransform = loadIfcCoordinationTransform(ifcApi, modelId);

    targetTypeCodes.forEach((typeCode) => {
      const entityIds = safeGetLineIdsWithType(ifcApi, modelId, typeCode);
      entityIds.forEach((entityId) => {
        const objectLine = safeGetLine(ifcApi, modelId, entityId);
        if (!objectLine) {
          return;
        }

        const typeLevelId = typeIdByObjectId.get(entityId);
        const objectLevelPsets = psetsByObjectId.get(entityId) || [];
        const typeLevelPsets = typeLevelId ? psetsByObjectId.get(typeLevelId) || [] : [];
        const mergedPsets = [...objectLevelPsets, ...typeLevelPsets];

        const propertiesBySet = {};
        mergedPsets.forEach((propertySet) => {
          mergePropertiesBySet(propertiesBySet, {
            [propertySet.propertySetName]: propertySet.propertiesByName,
          });
        });

        const componentIdentifyValues = readIdentityValues(
          propertiesBySet,
          COMPONENT_IDENTIFY_LABELS,
          COMPONENT_GROUP_NAME,
        );
        const systemIdentifyValues = readIdentityValues(propertiesBySet, SYSTEM_IDENTIFY_LABELS, SYSTEM_GROUP_NAME);

        const hasComponentPropertySet = Object.keys(propertiesBySet).some((psetName) =>
          psetName.startsWith(COMPONENT_GROUP_NAME),
        );
        const hasSystemPropertySet = Object.keys(propertiesBySet).some((psetName) => psetName.startsWith(SYSTEM_GROUP_NAME));

        parsedObjects.push({
          expressId: entityId,
          globalId: unwrapStepValue(objectLine.GlobalId) || "Unknown GUID",
          objectName: unwrapStepValue(objectLine.Name) || "",
          ifcTypeName: typeNameByCode.get(typeCode) || `UNKNOWN_IFC_${typeCode}`,
          typeCode,
          placementPoint: readObjectPlacementPoint(ifcApi, modelId, objectLine, cachedCoordinationTransform),
          propertiesBySet,
          componentIdentifyValues,
          systemIdentifyValues,
          hasComponentPropertySet,
          hasSystemPropertySet,
          isComponentCandidate:
            hasComponentPropertySet || hasAnyIdentityValue(componentIdentifyValues) || componentTypeCodes.has(typeCode),
          isSystemCandidate: hasSystemPropertySet || hasAnyIdentityValue(systemIdentifyValues) || systemTypeCodes.has(typeCode),
        });
      });
    });

    return {
      parsedObjects,
      coveringElementIds,
      modelContext: {
        ifcProjectGlobalId,
        ifcProjectName,
        ifcLengthUnitToMeters,
      },
    };
  } finally {
    if (typeof modelId === "number") {
      ifcApi.CloseModel(modelId);
    }
  }
}
