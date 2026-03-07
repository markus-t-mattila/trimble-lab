/*
Purpose:
Centralize identity-property labels and group names used by both parser and
checker engine so future rule maintenance only requires updates in one place.

Logic:
- Keep component and system identity labels in explicit ordered arrays.
- Keep PropertySet group names as constants to avoid hardcoded duplicates.

Parameters:
None

Returns:
Named constants shared across checker modules.

Possible side effects:
None
*/

export const COMPONENT_GROUP_NAME = "FI_Komponentti";
export const SYSTEM_GROUP_NAME = "FI_Järjestelmä";

export const COMPONENT_IDENTIFY_LABELS = [
  "01 Komponentin pääryhmä",
  "02 Komponentin alaryhmä",
  "03 Komponentin koodi",
  "04 Komponentin yleisnimi",
  "05 Komponentin yleistunnus",
];

export const SYSTEM_IDENTIFY_LABELS = [
  "01 Järjestelmälaji",
  "02 Järjestelmäluokka",
  "03 Järjestelmätyypin koodi",
  "04 Järjestelmätyyppi",
  "05 Järjestelmätyypin yleistunnus",
];

export const PRODUCT_SPECIAL_SKIP_PROPERTY = {
  group: "FI_Tuote",
  label: "Eristesarja",
};
