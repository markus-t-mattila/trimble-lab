/*
Purpose:
Keep all Trimble Workspace event names in one file so event routing remains
consistent and typo-safe across modules.

Logic:
Event names are exported as constants and reused by the bootstrap layer.

Parameters:
None

Returns:
Named string constants.

Possible side effects:
None
*/

export const WORKSPACE_EVENT_FILE_SELECTED = "extension.fileSelected";
export const WORKSPACE_EVENT_FILE_VIEW_CLICKED = "extension.fileViewClicked";
export const WORKSPACE_EVENT_ACCESS_TOKEN = "extension.accessToken";
export const WORKSPACE_EVENT_EXTENSION_COMMAND = "extension.command";
