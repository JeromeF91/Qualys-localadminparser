"""Parse a Qualys BitLocker (QID 45437) XML export into a compact cache."""

from __future__ import annotations

import pickle
import time
from collections import Counter, defaultdict
from pathlib import Path

from parse_qualys import (
    CACHE_DIR,
    ROOT,
    _asset_tags,
    _cdata,
    _ip,
    cache_is_stale,
    extract_hotel_codes,
    is_bitlocker_xml,
    iter_host_blocks,
)

CACHE_PATH = CACHE_DIR / "bitlocker.pkl"

PROTECTION = {
    "0": "Unprotected",
    "1": "Protected",
    "2": "Unknown",
}
CONVERSION = {
    "0": "Fully decrypted",
    "1": "Fully encrypted",
    "2": "Encryption in progress",
    "3": "Decryption in progress",
    "4": "Encryption paused",
    "5": "Decryption paused",
}
ENCRYPTION = {
    "0": "None",
    "1": "AES-128 with diffuser",
    "2": "AES-256 with diffuser",
    "3": "AES-128",
    "4": "AES-256",
    "5": "Hardware encryption",
    "6": "XTS-AES-128",
    "7": "XTS-AES-256",
}
VOLUME_TYPE = {
    "0": "OS",
    "1": "Fixed data",
    "2": "Removable",
}


def latest_bitlocker_xml(folder: Path | None = None) -> Path | None:
    folder = folder or ROOT
    xmls = [p for p in folder.glob("*.xml") if p.is_file() and is_bitlocker_xml(p)]
    if not xmls:
        return None
    return max(xmls, key=lambda p: p.stat().st_mtime)


def _host_role(os_name: str) -> str:
    text = (os_name or "").lower()
    if "server" in text or "hyper-v" in text:
        return "server"
    return "workstation"


def parse_volumes(result: str) -> list[dict]:
    volumes = []
    for line in result.replace("\r", "").split("\n"):
        if not line.strip():
            continue
        if line.lower().startswith("drive letter"):
            continue
        cols = [part.strip() for part in line.split("\t")]
        while len(cols) < 7:
            cols.append("")
        letter, volume_id, protection, conversion, method, initialized, volume_type = cols[:7]
        if not letter and not protection and not conversion:
            continue
        item = {
            "letter": letter,
            "volume_id": volume_id,
            "protection": protection,
            "protection_label": PROTECTION.get(protection, protection or "Unknown"),
            "conversion": conversion,
            "conversion_label": CONVERSION.get(conversion, conversion or "Unknown"),
            "encryption": method,
            "encryption_label": ENCRYPTION.get(method, method or "Unknown"),
            "initialized": initialized,
            "volume_type": volume_type,
            "volume_type_label": VOLUME_TYPE.get(volume_type, volume_type or "Unknown"),
        }
        item["status"] = volume_status(item)
        volumes.append(item)
    return volumes


def volume_status(volume: dict | None) -> str:
    if not volume:
        return "unknown"
    conversion = volume.get("conversion") or ""
    if conversion in {"2", "4"}:
        return "encrypting"
    if conversion in {"3", "5"}:
        return "decrypting"
    protection = volume.get("protection") or ""
    if protection == "1":
        return "protected"
    if protection == "0":
        # Encrypted with protectors disabled (BitLocker suspended).
        if conversion == "1":
            return "suspended"
        return "unprotected"
    return "unknown"


def os_volume(volumes: list[dict]) -> dict | None:
    for volume in volumes:
        if volume.get("volume_type") == "0":
            return volume
    for volume in volumes:
        if (volume.get("letter") or "").upper().startswith("C"):
            return volume
    return volumes[0] if volumes else None


def parse_host(raw: bytes) -> dict:
    dns = _cdata(raw, b"DNS")
    netbios = _cdata(raw, b"NETBIOS")
    os_name = _cdata(raw, b"OPERATING_SYSTEM")
    tags = _asset_tags(raw)
    volumes = parse_volumes(_cdata(raw, b"RESULT"))
    os_vol = os_volume(volumes)
    unprotected = [volume for volume in volumes if volume.get("protection") != "1"]
    return {
        "ip": _ip(raw),
        "dns": dns,
        "netbios": netbios,
        "os": os_name,
        "role": _host_role(os_name),
        "last_found": _cdata(raw, b"LAST_FOUND"),
        "hotel_codes": extract_hotel_codes(dns, netbios, tags),
        "volumes": volumes,
        "os_status": volume_status(os_vol),
        "os_letter": (os_vol or {}).get("letter") or "",
        "os_encryption": (os_vol or {}).get("encryption_label") or "",
        "os_protection_label": (os_vol or {}).get("protection_label") or "",
        "os_conversion_label": (os_vol or {}).get("conversion_label") or "",
        "unprotected_os": volume_status(os_vol) in {"unprotected", "suspended"},
        "unprotected_fixed": sum(
            1
            for volume in unprotected
            if volume.get("volume_type") in {"0", "1"} or (volume.get("letter") or "").upper().startswith("C")
        ),
        "unprotected_removable": sum(1 for volume in unprotected if volume.get("volume_type") == "2"),
    }


def build_cache(xml_path: Path, cache_path: Path = CACHE_PATH) -> dict:
    CACHE_DIR.mkdir(exist_ok=True)
    hosts: list[dict] = []
    by_hotel: dict[str, list[int]] = defaultdict(list)
    no_code: list[int] = []
    started = time.time()

    for raw in iter_host_blocks(xml_path):
        host = parse_host(raw)
        idx = len(hosts)
        hosts.append(host)
        if host["hotel_codes"]:
            for code in host["hotel_codes"]:
                by_hotel[code].append(idx)
        else:
            no_code.append(idx)

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": xml_path.name,
        "hosts": hosts,
        "by_hotel": dict(by_hotel),
        "no_code": no_code,
    }
    cache_path.write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))
    elapsed = time.time() - started
    print(
        f"BitLocker: {len(hosts):,} hosts, {len(by_hotel):,} hotel codes, "
        f"{len(no_code):,} without a code in {elapsed:.1f}s",
        flush=True,
    )
    return payload


def load_bitlocker(force: bool = False) -> dict | None:
    xml_path = latest_bitlocker_xml()
    if xml_path is None:
        print("No BitLocker XML export found (filename should contain 'bitlocker').", flush=True)
        return None
    if force or cache_is_stale(xml_path, CACHE_PATH):
        print(f"Parsing BitLocker {xml_path.name}...", flush=True)
        return build_cache(xml_path)
    print(f"Using BitLocker cache for {xml_path.name}", flush=True)
    return pickle.loads(CACHE_PATH.read_bytes())


if __name__ == "__main__":
    load_bitlocker(force="--rebuild" in __import__("sys").argv)
