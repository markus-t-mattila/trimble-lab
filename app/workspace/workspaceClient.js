/*
Purpose:
Provide a thin, well-typed wrapper around Trimble Connect Workspace API so the
rest of the application can stay independent from direct global API calls.

Logic:
- Connect once and cache the API instance.
- Keep the event callback centralized.
- Expose small helper methods for permissions, project metadata, and menu.

Parameters:
This module exposes functions; parameters are documented at function level.

Returns:
Workspace client helper object.

Possible side effects:
- Opens a connection to Trimble Connect parent window.
- Registers extension menu and status messages.
*/

let connectPromise = null;

/*
Purpose:
Validate that the Workspace API script was loaded before we try to connect.

Parameters:
None

Returns:
void

Possible side effects:
- Throws an Error when the API script is missing.
*/
function assertWorkspaceApiIsAvailable() {
  if (!window.TrimbleConnectWorkspace || typeof window.TrimbleConnectWorkspace.connect !== "function") {
    throw new Error(
      "Trimble Workspace API is missing. Confirm that index.html loads the official Workspace API script.",
    );
  }
}

/*
Purpose:
Create or reuse a singleton connection to Trimble Connect Workspace API.

Logic:
A single connection avoids duplicated event listeners and inconsistent state.

Parameters:
onEvent (Function) - receives Workspace events and payloads

Returns:
Promise<object> - resolved Workspace API instance

Possible side effects:
- Establishes cross-window messaging with Trimble Connect.
*/
export async function connectWorkspaceApi(onEvent) {
  if (connectPromise) {
    return connectPromise;
  }

  assertWorkspaceApiIsAvailable();

  connectPromise = window.TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
  return connectPromise;
}

/*
Purpose:
Request access token permission so the extension can download project files.

Parameters:
workspaceApi (object) - connected Workspace API instance

Returns:
Promise<object> - permission status object from Workspace API

Possible side effects:
- Shows permission prompt to the user in Trimble Connect if needed.
*/
export async function requestAccessTokenPermission(workspaceApi) {
  return workspaceApi.extension.requestPermission("accesstoken");
}

/*
Purpose:
Request current project information for context-aware logging and status text.

Parameters:
workspaceApi (object) - connected Workspace API instance

Returns:
Promise<object>

Possible side effects:
None
*/
export async function getCurrentProject(workspaceApi) {
  return workspaceApi.project.getCurrentProject();
}

/*
Purpose:
Publish extension status text in Trimble Connect shell.

Parameters:
workspaceApi (object) - connected Workspace API instance
message (string) - status message shown by host

Returns:
Promise<void>

Possible side effects:
- Updates extension status UI in Trimble Connect host.
*/
export async function setExtensionStatusMessage(workspaceApi, message) {
  await workspaceApi.extension.setStatusMessage(message);
}

/*
Purpose:
Register a simple extension menu command for visibility and discoverability.

Parameters:
workspaceApi (object) - connected Workspace API instance

Returns:
Promise<void>

Possible side effects:
- Adds menu item into Trimble Connect extension menu.
*/
export async function registerMainMenu(workspaceApi) {
  const menuDefinition = {
    title: "IFC Checker",
    icon: "https://www.tietomallintaja.fi/wp-content/uploads/2022/03/LOGO-Tekstilla-Musta-200-x-200.png",
    command: "main_clicked",
  };

  await workspaceApi.ui.setMenu(menuDefinition);
}
