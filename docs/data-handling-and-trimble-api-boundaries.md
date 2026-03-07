# Data Handling and Trimble API Boundaries

This document explains how data is processed, where data is sent, what runs in the user's browser, and what depends on Trimble platform APIs.

## 1. Data handling model (high level)

The extension is a browser-hosted front-end with no custom backend service in this repository.

- Processing logic runs in browser JavaScript.
- IFC parsing and rule checking run in browser memory (`ArrayBuffer` + JS objects).
- Remote calls go directly from browser to Trimble endpoints using bearer token obtained through Workspace API permission flow.

## 2. What happens in the browser

The following operations are executed locally in the user browser session:

- UI rendering and interaction handling
- Runtime state management (`runtimeState` objects)
- IFC byte validation and parsing (`web-ifc`)
- Rule evaluation (`checkerEngine`)
- Report rendering and filtering
- JSON export generation (checker report and BCF draft)

Local-only outputs:

- Downloaded report JSON files
- Downloaded BCF draft JSON files

No custom server-side processing is implemented in this repository.

## 3. What uses Trimble APIs

### 3.1 Workspace API (host integration)

Used for:

- Connecting extension to Trimble host shell
- Reading current project context
- Receiving access token events
- Requesting `accesstoken` permission
- Setting extension status/menu metadata

Main code:

- `app/workspace/workspaceClient.js`
- `app/projectFileIndex.js`

### 3.2 Core API (`/tc/api/2.0`)

Used for:

- Project folder traversal
- File listing
- Root folder resolution
- Signed IFC download URL resolution

Main code:

- `app/projectFileIndex.js`
- `app/workspace/trimbleFileService.js`

### 3.3 Topics API (`/bcf/3.0`) - optional user-triggered flow

Used for:

- Reading BCF extension options
- Reading project files_information
- Creating topics
- Creating viewpoints
- Linking created topics to model files

Main code:

- `app/projectFileIndex.js`

This flow only runs when user explicitly triggers "Create BCFs" action.

## 4. Data in/out map

| Step | Data in | Processing location | Data out |
|---|---|---|---|
| Project context init | Workspace events + project metadata | Browser | Status/menu updates |
| File discovery | Core API folder/project responses | Browser | IFC list in UI |
| Model download | Signed URL IFC bytes | Browser memory | Parsed model input for checker |
| Rule check | Parsed model + rule dataset JSON | Browser | Findings + summary UI |
| Report export | Findings data | Browser | Downloaded JSON file |
| BCF topic creation (optional) | Selected issue rows + modal inputs | Browser + Topics API request | Created topics/viewpoints in Trimble |

## 5. Authentication and permission boundaries

- Access token is requested through Workspace API permission flow.
- Token is stored in runtime memory, not persisted to local storage by app code.
- Token is sent in `Authorization: Bearer ...` headers for Trimble API requests.
- API calls use the current user's Trimble permissions.

## 6. Persistence and retention

In this repository implementation:

- No app-owned database is used.
- No localStorage/sessionStorage persistence is implemented in app source.
- IFC bytes and check results stay in memory during active session.
- Export files are written only when user explicitly triggers download.

## 7. Endpoints and host patterns used

The implementation includes fallback host candidates for regional Trimble domains.

Typical endpoint categories used by code:

- Core API base candidates: `https://app*.connect.trimble.com/tc/api/2.0`
- Topics API base candidates: `https://open*.connect.trimble.com`
- BCF endpoints under: `/bcf/3.0/projects/{projectId}/...`

Signed file download URLs are resolved dynamically and may point to service-specific hosts.

## 8. External references

- Trimble Connect docs: [https://developer.trimble.com/docs/connect](https://developer.trimble.com/docs/connect)
- Workspace API reference: [https://components.connect.trimble.com/trimble-connect-workspace-api/](https://components.connect.trimble.com/trimble-connect-workspace-api/)
- BCF API reference (buildingSMART): [https://github.com/buildingSMART/BCF-API](https://github.com/buildingSMART/BCF-API)
