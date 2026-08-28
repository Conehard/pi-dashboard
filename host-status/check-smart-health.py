#!/usr/bin/env python3
import subprocess
import json
import datetime
import pathlib
import shutil

OUT_DIR = pathlib.Path(__file__).resolve().parent
OUT_FILE = OUT_DIR / "smart-health.json"

DEVICES = ["/dev/sda", "/dev/mmcblk0"]

def check_device(device):
    try:
        result = subprocess.run(
            ["sudo", "-n", "smartctl", "-H", "-A", "-j", device],
            capture_output=True, text=True, timeout=20
        )
    except Exception as err:
        return {"device": device, "supported": False, "error": str(err)}

    try:
        data = json.loads(result.stdout) if result.stdout else {}
    except Exception:
        data = {}

    if not data:
        return {"device": device, "supported": False, "error": (result.stderr or "sem saída").strip()[:300]}

    if "smart_status" not in data:
        return {"device": device, "supported": False, "error": None}

    health = data.get("smart_status", {}).get("passed")
    temp = (data.get("temperature") or {}).get("current")
    power_on_hours = (data.get("power_on_time") or {}).get("hours")

    attrs = {}
    for a in (data.get("ata_smart_attributes") or {}).get("table", []):
        if a.get("name") in ("Reallocated_Sector_Ct", "Current_Pending_Sector", "Reported_Uncorrect"):
            attrs[a["name"]] = a.get("raw", {}).get("value")

    return {
        "device": device,
        "supported": True,
        "healthy": health,
        "temperatureC": temp,
        "powerOnHours": power_on_hours,
        "reallocatedSectors": attrs.get("Reallocated_Sector_Ct"),
        "pendingSectors": attrs.get("Current_Pending_Sector"),
        "uncorrectableErrors": attrs.get("Reported_Uncorrect"),
    }

def main():
    if shutil.which("smartctl") is None:
        data = {
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "available": False,
            "reason": "smartmontools não instalado - ver a seção SMART em INSTALL.md",
        }
    else:
        data = {
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "available": True,
            "devices": [check_device(d) for d in DEVICES],
        }

    tmp_file = OUT_FILE.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(data))
    tmp_file.replace(OUT_FILE)

if __name__ == "__main__":
    main()

