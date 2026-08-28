#!/usr/bin/env python3
import subprocess
import json
import datetime
import pathlib
import re

OUT_DIR = pathlib.Path(__file__).resolve().parent
OUT_FILE = OUT_DIR / "host-schedule.json"

CRON_LINE_RE = re.compile(r"^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$")

def read_crontab():
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
    except Exception as err:
        return {"available": False, "error": str(err), "entries": []}

    if result.returncode != 0:
        return {"available": True, "error": None, "entries": []}

    entries = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = CRON_LINE_RE.match(line)
        if m:
            entries.append({"schedule": m.group(1), "command": m.group(2)})
    return {"available": True, "error": None, "entries": entries}

def read_systemd_timers():
    try:
        result = subprocess.run(
            ["systemctl", "list-timers", "--all", "--no-legend"],
            capture_output=True, text=True, timeout=10
        )
    except Exception as err:
        return {"available": False, "error": str(err), "timers": []}

    if result.returncode != 0:
        return {"available": False, "error": result.stderr.strip() or f"exit code {result.returncode}", "timers": []}

    timers = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        activates = parts[-1]
        unit = parts[-2]
        when = " ".join(parts[:-2]).strip()
        if unit.endswith(".timer"):
            timers.append({"unit": unit, "activates": activates, "schedule": when})
    return {"available": True, "error": None, "timers": timers}

def main():
    data = {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "crontab": read_crontab(),
        "systemdTimers": read_systemd_timers(),
    }
    tmp_file = OUT_FILE.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(data))
    tmp_file.replace(OUT_FILE)

if __name__ == "__main__":
    main()

