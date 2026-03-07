#!/usr/bin/env python3

"""
Purpose:
Provide shared extraction utilities for both dataset generation and parity
verification scripts so both workflows decode the legacy bundle consistently.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SOURCE_BUNDLE_PATH = Path("_orginalApp/assets/index-DeuYOVjW.js")


def read_source_bundle_text() -> str:
    """
    Purpose:
    Read the legacy bundled script containing original checker data.

    Returns:
    str - full bundle source text
    """

    return SOURCE_BUNDLE_PATH.read_text(encoding="utf-8", errors="ignore")


def decode_js_single_quoted_string(js_escaped_text: str) -> str:
    """
    Purpose:
    Decode JavaScript single-quoted string escape sequences without corrupting
    already-correct UTF-8 characters.

    Parameters:
    js_escaped_text (str) - raw string payload captured inside JS single quotes

    Returns:
    str - decoded plain text
    """

    decoded_characters: list[str] = []
    index = 0
    text_length = len(js_escaped_text)

    while index < text_length:
        current_character = js_escaped_text[index]
        if current_character != "\\":
            decoded_characters.append(current_character)
            index += 1
            continue

        if index + 1 >= text_length:
            decoded_characters.append("\\")
            index += 1
            continue

        escape_code = js_escaped_text[index + 1]

        if escape_code in {"\\", "'", '"'}:
            decoded_characters.append(escape_code)
            index += 2
            continue

        if escape_code == "n":
            decoded_characters.append("\n")
            index += 2
            continue

        if escape_code == "r":
            decoded_characters.append("\r")
            index += 2
            continue

        if escape_code == "t":
            decoded_characters.append("\t")
            index += 2
            continue

        if escape_code == "b":
            decoded_characters.append("\b")
            index += 2
            continue

        if escape_code == "f":
            decoded_characters.append("\f")
            index += 2
            continue

        if escape_code == "v":
            decoded_characters.append("\v")
            index += 2
            continue

        if escape_code == "0":
            decoded_characters.append("\0")
            index += 2
            continue

        if escape_code == "x" and index + 3 < text_length:
            hex_value = js_escaped_text[index + 2 : index + 4]
            if re.fullmatch(r"[0-9A-Fa-f]{2}", hex_value):
                decoded_characters.append(chr(int(hex_value, 16)))
                index += 4
                continue

        if escape_code == "u" and index + 5 < text_length:
            hex_value = js_escaped_text[index + 2 : index + 6]
            if re.fullmatch(r"[0-9A-Fa-f]{4}", hex_value):
                decoded_characters.append(chr(int(hex_value, 16)))
                index += 6
                continue

        decoded_characters.append(escape_code)
        index += 2

    return "".join(decoded_characters)


def extract_json_parse_value(source_text: str, var_name: str):
    """
    Purpose:
    Extract and decode one JSON.parse('...') assignment from legacy bundle.

    Parameters:
    source_text (str) - bundle source
    var_name (str) - variable name to extract

    Returns:
    object - parsed JSON value
    """

    match = re.search(rf"{re.escape(var_name)}=JSON\.parse\('((?:\\'|[^'])*)'\)", source_text)
    if not match:
        raise RuntimeError(f"Could not locate JSON.parse assignment for variable: {var_name}")

    decoded_json_text = decode_js_single_quoted_string(match.group(1))
    return json.loads(decoded_json_text)


def extract_literal(source_text: str, start_token: str, end_token: str) -> str:
    """
    Purpose:
    Extract one raw JS literal segment between two known tokens.
    """

    start_index = source_text.find(start_token)
    if start_index == -1:
        raise RuntimeError(f"Start token not found: {start_token}")
    start_index += len(start_token)

    end_index = source_text.find(end_token, start_index)
    if end_index == -1:
        raise RuntimeError(f"End token not found: {end_token}")

    return source_text[start_index:end_index]


def js_literal_to_json(js_source: str) -> str:
    """
    Purpose:
    Convert loose JavaScript object/array literal syntax to strict JSON.
    """

    converted = re.sub(r'([\{,])\s*([A-Za-z_À-ÿ][A-Za-z0-9_À-ÿ]*)\s*:', r'\1"\2":', js_source)
    converted = re.sub(r",\s*([}\]])", r"\1", converted)
    return converted


def extract_component_entity_names(source_text: str):
    """
    Purpose:
    Extract the component IFC entity whitelist from the original `m=[...]`.
    """

    match = re.search(r"m=\[(.*?)\]\.map\(", source_text)
    if not match:
        raise RuntimeError("Could not extract component entity list from original bundle.")
    return json.loads(f"[{match.group(1)}]")
