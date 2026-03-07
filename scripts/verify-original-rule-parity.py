#!/usr/bin/env python3

"""
Purpose:
Verify that the extracted rule dataset used by the new app is still exactly in
sync with rule data embedded in the original bundled checker.

Usage:
  python3 scripts/verify-original-rule-parity.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from original_rule_dataset_utils import (
    extract_component_entity_names,
    extract_json_parse_value,
    extract_literal,
    js_literal_to_json,
    read_source_bundle_text,
)

EXTRACTED_DATASET_PATH = Path("app/checker/rules/originalRuleDataset.json")


def main() -> int:
    source_text = read_source_bundle_text()
    extracted_dataset = json.loads(EXTRACTED_DATASET_PATH.read_text(encoding="utf-8"))

    expected_dataset = {
        "productCodeDefinitions": extract_json_parse_value(source_text, "y0"),
        "systemCodeDefinitions": extract_json_parse_value(source_text, "f0"),
        "productPropertyDefinitions": extract_json_parse_value(source_text, "WC"),
        "systemPropertyDefinitions": json.loads(
            f"[{js_literal_to_json(extract_literal(source_text, 'zC=[', '],iP={};'))}]"
        ),
        "defaultPropertyStates": json.loads(js_literal_to_json(extract_literal(source_text, "const dZ=", ",Pe={};"))),
        "componentEntityTypeNames": extract_component_entity_names(source_text),
        "systemEntityTypeNames": [
            "IFCSYSTEM",
            "IFCDISTRIBUTIONSYSTEM",
            "IFCBUILDINGSYSTEM",
            "IFCDISTRIBUTIONCIRCUIT",
        ],
    }

    mismatches = []
    for key, expected_value in expected_dataset.items():
        if extracted_dataset.get(key) != expected_value:
            mismatches.append(key)

    if mismatches:
        print("Rule parity check failed. Mismatched keys:")
        for key in mismatches:
            print(f" - {key}")
        return 1

    print("Rule parity check passed.")
    print(f"Product codes: {len(expected_dataset['productCodeDefinitions'])}")
    print(f"System codes: {len(expected_dataset['systemCodeDefinitions'])}")
    print(f"Product properties: {len(expected_dataset['productPropertyDefinitions'])}")
    print(f"System properties: {len(expected_dataset['systemPropertyDefinitions'])}")
    print(f"Component entity types: {len(expected_dataset['componentEntityTypeNames'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
