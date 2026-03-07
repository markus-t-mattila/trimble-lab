#!/usr/bin/env python3

"""
Purpose:
Extract original checker rule data from bundled legacy script into a standalone
JSON dataset consumed by the rewritten application.

Usage:
  python3 scripts/extract-original-rule-dataset.py
"""

from __future__ import annotations

import json
from pathlib import Path

from original_rule_dataset_utils import (
    SOURCE_BUNDLE_PATH,
    extract_component_entity_names,
    extract_json_parse_value,
    extract_literal,
    js_literal_to_json,
    read_source_bundle_text,
)

OUTPUT_DATASET_PATH = Path("app/checker/rules/originalRuleDataset.json")


def main() -> None:
    source_text = read_source_bundle_text()

    dataset = {
        "source": {
            "file": str(SOURCE_BUNDLE_PATH),
            "description": "Extracted verbatim rule data from original bundled checker.",
        },
        "productCodeDefinitions": extract_json_parse_value(source_text, "y0"),
        "systemCodeDefinitions": extract_json_parse_value(source_text, "f0"),
        "productPropertyDefinitions": extract_json_parse_value(source_text, "WC"),
        "systemPropertyDefinitions": json.loads(
            f"[{js_literal_to_json(extract_literal(source_text, 'zC=[', '],iP={};'))}]"
        ),
        "defaultPropertyStates": json.loads(js_literal_to_json(extract_literal(source_text, "const dZ=", ",Pe={};"))),
        "systemEntityTypeNames": [
            "IFCSYSTEM",
            "IFCDISTRIBUTIONSYSTEM",
            "IFCBUILDINGSYSTEM",
            "IFCDISTRIBUTIONCIRCUIT",
        ],
        "componentEntityTypeNames": extract_component_entity_names(source_text),
    }

    OUTPUT_DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Purpose:
    # Keep generated dataset formatting stable and human-readable so repository
    # diffs remain reviewable and deterministic across extractions.
    formatted_dataset = f"{json.dumps(dataset, ensure_ascii=False, indent=4)}\n"
    OUTPUT_DATASET_PATH.write_text(formatted_dataset, encoding="utf-8")

    print(f"Wrote: {OUTPUT_DATASET_PATH}")
    print(f"Product codes: {len(dataset['productCodeDefinitions'])}")
    print(f"System codes: {len(dataset['systemCodeDefinitions'])}")
    print(f"Product properties: {len(dataset['productPropertyDefinitions'])}")
    print(f"System properties: {len(dataset['systemPropertyDefinitions'])}")
    print(f"Component entity types: {len(dataset['componentEntityTypeNames'])}")


if __name__ == "__main__":
    main()
