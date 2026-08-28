#!/usr/bin/env python3
import subprocess
import json
import datetime
import pathlib
import sys

OUT_DIR = pathlib.Path(__file__).resolve().parent
OUT_FILE = OUT_DIR / "tailscale-status.json"

def main():
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=15
        )
    except Exception as err:
        data = {
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "available": False,
            "error": str(err),
        }
        tmp_file = OUT_FILE.with_suffix(".json.tmp")
        tmp_file.write_text(json.dumps(data))
        tmp_file.replace(OUT_FILE)
        sys.exit(1)

    try:
        raw = json.loads(result.stdout)
    except Exception as err:
        print(f"failed to parse tailscale output: {err}", file=sys.stderr)
        sys.exit(1)

    peers = list((raw.get("Peer") or {}).values())
    data = {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "available": True,
        "backendState": raw.get("BackendState"),
        "selfHostname": (raw.get("Self") or {}).get("HostName"),
        "selfIps": raw.get("TailscaleIPs") or [],
        "peerCount": len(peers),
        "peerOnlineCount": sum(1 for p in peers if p.get("Online")),
        "exitNodeActive": bool((raw.get("Self") or {}).get("ExitNode")),
    }

    tmp_file = OUT_FILE.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(data))
    tmp_file.replace(OUT_FILE)

if __name__ == "__main__":
    main()

