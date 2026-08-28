#!/usr/bin/env python3
import subprocess
import json
import re
import datetime
import pathlib
import sys

OUT_DIR = pathlib.Path(__file__).resolve().parent
OUT_FILE = OUT_DIR / "apt-updates.json"

LINE_RE = re.compile(r"^([^/\s]+)/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]")

def main():
    try:
        result = subprocess.run(
            ["apt", "list", "--upgradable"],
            capture_output=True, text=True, timeout=60
        )
    except Exception as err:
        print(f"failed to run apt: {err}", file=sys.stderr)
        sys.exit(1)

    packages = []
    for line in result.stdout.splitlines():
        if not line or line.startswith("Listing"):
            continue
        m = LINE_RE.match(line)
        if m:
            packages.append({
                "name": m.group(1),
                "newVersion": m.group(2),
                "oldVersion": m.group(3),
            })
        else:
            packages.append({"name": line.strip(), "newVersion": None, "oldVersion": None})

    data = {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(packages),
        "packages": packages[:200],
    }

    tmp_file = OUT_FILE.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(data))
    tmp_file.replace(OUT_FILE)

if __name__ == "__main__":
    main()

