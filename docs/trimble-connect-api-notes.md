# Trimble Connect API Notes (Rewritten App)

## Goal

Use the currently open Trimble Connect project as the IFC source and run checks
inside the extension without legacy iframe integration.

## Implemented Event/Permission Usage

- `TrimbleConnectWorkspace.connect(...)`
- `extension.command`
- `extension.accessToken`
- `extension.requestPermission("accesstoken")`

## Runtime Flow

1. Connect extension to Workspace API.
2. Register extension menu and status message.
3. Request access token permission.
4. Resolve current project and collect IFC file rows from project tree.
5. Download selected IFC bytes using signed URL flow.
6. Parse model via `web-ifc` in browser.
7. Run configurable rule set and render report.
8. Export report JSON or BCF draft JSON from latest check result.

## Sources

- https://developer.trimble.com/docs/connect/workspace-api/
- https://components.connect.trimble.com/trimble-connect-workspace-api/interfaces/EventToArgMap.html
- https://components.connect.trimble.com/trimble-connect-workspace-api/interfaces/AccessTokenArgument.html
