/*
Purpose:
Centralize web-ifc runtime configuration so version pinning and wasm paths are
maintained in one explicit location.

Logic:
- Keep the pinned package version next to the runtime paths.
- Expose constants used by bootstrap and status UI rendering.

Parameters:
None

Returns:
Named constants.

Possible side effects:
None
*/

export const WEB_IFC_VERSION = "0.0.77";
export const WEB_IFC_WASM_PATH = new URL("../vendor/web-ifc/", import.meta.url).toString();
