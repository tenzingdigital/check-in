#!/usr/bin/env python3
"""Fail if the host configs disagree about security headers.

There are two deploy configs — vercel.json and render.yaml — because the app can
be hosted on either. Whichever one your host ignores is invisible: if Render is
serving the site, a mistake in vercel.json costs nothing, and a mistake in
render.yaml silently ships the resident register with no frame-ancestors, no
nosniff and no referrer protection. Nothing in the app would look wrong.

A comment saying "keep these in sync" does not survive contact with a deadline.
This does.

No third-party dependencies: render.yaml is a fixed shape we control, so it is
read with a regex rather than a YAML library that may not be installed.

Run directly, or via ./check.sh.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def vercel_headers(path: Path) -> dict[str, dict[str, str]]:
    """{path_pattern: {header_name: value}} from vercel.json."""
    out: dict[str, dict[str, str]] = {}
    for block in json.loads(path.read_text()).get("headers", []):
        src = block["source"]
        # "/(.*)"" and "/*" are the same intent in different dialects.
        src = "/*" if src in ("/(.*)", "/*") else src
        out.setdefault(src, {})
        for kv in block.get("headers", []):
            out[src][kv["key"]] = kv["value"].strip()
    return out


def render_headers(path: Path) -> dict[str, dict[str, str]]:
    """{path_pattern: {header_name: value}} from render.yaml's headers list."""
    text = path.read_text()
    # Only look inside the headers: block, so the service's own `name:` key
    # cannot be mistaken for a header name.
    m = re.search(r"^\s*headers:\s*$(.*)", text, re.M | re.S)
    if not m:
        return {}
    out: dict[str, dict[str, str]] = {}
    # Each entry is exactly three lines. Match line-wise (re.M, no re.S) so a
    # value cannot run past its own line and swallow the following comments —
    # which it did, silently, on the last entry of the block.
    for entry in re.finditer(
        r"^\s*-\s+path:\s*(\S+)\s*$\n^\s*name:\s*(\S+)\s*$\n^\s*value:\s*(.*)$",
        m.group(1),
        re.M,
    ):
        path_pat, name, value = entry.group(1), entry.group(2), entry.group(3)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out.setdefault(path_pat, {})[name] = value.strip()
    return out


def main() -> int:
    vercel = ROOT / "vercel.json"
    render = ROOT / "render.yaml"

    missing = [p.name for p in (vercel, render) if not p.exists()]
    if missing:
        print(f"FAIL: missing deploy config(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    v = vercel_headers(vercel)
    r = render_headers(render)

    problems: list[str] = []

    for pattern in sorted(set(v) | set(r)):
        vh, rh = v.get(pattern, {}), r.get(pattern, {})
        for name in sorted(set(vh) | set(rh)):
            in_v, in_r = name in vh, name in rh
            if in_v and not in_r:
                problems.append(f"{pattern}: {name} is in vercel.json but not render.yaml")
            elif in_r and not in_v:
                problems.append(f"{pattern}: {name} is in render.yaml but not vercel.json")
            elif vh[name] != rh[name]:
                problems.append(
                    f"{pattern}: {name} differs\n"
                    f"    vercel.json: {vh[name]}\n"
                    f"    render.yaml: {rh[name]}"
                )

    if problems:
        print("FAIL: deploy configs disagree about security headers.\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\nWhichever host you are NOT on ignores its config silently, so a\n"
            "difference here means one deployment is missing protection and\n"
            "nothing in the app will show it.",
            file=sys.stderr,
        )
        return 1

    total = sum(len(hs) for hs in v.values())
    print(f"deploy configs agree — {total} headers identical across vercel.json and render.yaml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
