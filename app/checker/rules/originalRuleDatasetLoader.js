/*
Purpose:
Load the original checker rule dataset extracted from the legacy bundle while
keeping loading logic isolated from checker execution logic.

Logic:
- Fetch one local JSON file generated from `_orginalApp/assets/index-DeuYOVjW.js`.
- Cache the parsed dataset so it is loaded only once per page lifetime.

Parameters:
None

Returns:
Promise<object> - parsed rule dataset

Possible side effects:
- Performs one HTTP fetch request to local static JSON file.
*/

const datasetUrl = new URL("./originalRuleDataset.json", import.meta.url);
let cachedDatasetPromise = null;

/*
Purpose:
Load and cache extracted rule dataset so checker runtime can reuse one parsed
object instance across repeated check runs in the same browser session.

Logic:
- Perform lazy fetch on first call.
- Keep promise cached to avoid parallel duplicate requests.
- Reset cache when fetch fails so later retries are still possible.

Parameters:
None

Returns:
Promise<object> - parsed rule dataset JSON object

Possible side effects:
- Executes network request for local JSON asset on first successful call.
*/
export function loadOriginalRuleDataset() {
  if (!cachedDatasetPromise) {
    cachedDatasetPromise = fetch(datasetUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load original rule dataset (HTTP ${response.status}).`);
        }

        return response.json();
      })
      .catch((error) => {
        cachedDatasetPromise = null;
        throw error;
      });
  }

  return cachedDatasetPromise;
}
