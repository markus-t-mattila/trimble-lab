/*
Purpose:
Centralize user-facing status and selected-file rendering for the shell UI.

Logic:
Keeps UI updates consistent and avoids scattered text updates across modules.

Parameters:
This module exports render helper functions.

Returns:
Small DOM update utilities.

Possible side effects:
- Mutates textContent and class names in status region.
*/

/*
Purpose:
Render one status line with optional visual severity.

Parameters:
statusElement (HTMLElement) - target node
message (string) - status text for user
severity ("info" | "success" | "warning" | "error") - visual style

Returns:
void

Possible side effects:
- Replaces classes on the status element.
*/
export function renderStatus(statusElement, message, severity = "info") {
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.className = `status status-${severity}`;
}

/*
Purpose:
Render selected file metadata in the shell header.

Parameters:
nameElement (HTMLElement) - file name value target
sourceElement (HTMLElement) - file source value target
fileName (string) - selected IFC name
sourceText (string) - origin/source label

Returns:
void

Possible side effects:
- Updates textContent of metadata fields.
*/
export function renderSelectedFile(nameElement, sourceElement, fileName, sourceText) {
  if (nameElement) {
    nameElement.textContent = fileName || "-";
  }

  if (sourceElement) {
    sourceElement.textContent = sourceText || "-";
  }
}
