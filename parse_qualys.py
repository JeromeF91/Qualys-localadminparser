"""Stream-parse the Qualys administrator-group export into a compact cache."""

from __future__ import annotations

import html
import json
import pickle
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
CACHE_PATH = CACHE_DIR / "hosts.pkl"
SUMMARY_PATH = CACHE_DIR / "summary.json"

HOTEL_RE = re.compile(r"(?<![A-Za-z0-9])([HV][A-Za-z0-9]{4})(?![A-Za-z0-9])", re.I)
TAG_HOTEL_RE = re.compile(r"(?:^|_)([HV][A-Za-z0-9]{4})(?:_|$)", re.I)
ADMIN_RE = re.compile(r'\{sid="([^"]*)",\s*name="([^"]*)"\}')
FALSE_POSITIVE_CODES = {
    "HEADER",
    "HKMGR",
    "HKSEC",
    "HMSEC",
    "HOSTS",
    "HOTEL",
    "HRDIR",
    "HSKPM",
    "HTTP1",
    "HTTP2",
    "HTTPS",
    "HWID1",
    "HWIDS",
    "VAL02",
    "VALID",
    "VALUE",
    "VICAS",
    "VLAN0",
    "VLAN1",
    "VLAN2",
    "VLAN3",
    "VLAN4",
    "VLAN5",
    "VLAN6",
    "VLAN7",
    "VLAN8",
    "VLAN9",
    "VOICE",
}


def iter_host_blocks(path: Path):
    """Yield raw HOST XML blocks from HOST_LIST without loading the file."""
    with path.open("rb") as f:
        buf = bytearray()
        pos = 0
        in_list = False
        while True:
            chunk = f.read(8 * 1024 * 1024)
            if chunk:
                buf.extend(chunk)
            if not in_list:
                idx = buf.find(b"<HOST_LIST>")
                if idx < 0:
                    if len(buf) > 64:
                        del buf[:-16]
                    if not chunk:
                        return
                    continue
                pos = idx + len(b"<HOST_LIST>")
                in_list = True
            while True:
                start = buf.find(b"<HOST>", pos)
                if start < 0:
                    keep = buf[-8:]
                    buf.clear()
                    buf.extend(keep)
                    pos = 0
                    break
                end = buf.find(b"</HOST>", start)
                if end < 0:
                    if start > 0:
                        del buf[:start]
                        pos = 0
                    break
                yield bytes(buf[start : end + 7])
                pos = end + 7
                if pos > 4 * 1024 * 1024:
                    del buf[:pos]
                    pos = 0
            if not chunk:
                return


def _cdata(raw: bytes, tag: bytes) -> str:
    token = b"<" + tag
    i = raw.find(token)
    if i < 0:
        return ""
    gt = raw.find(b">", i)
    if gt < 0:
        return ""
    cdata = raw.find(b"<![CDATA[", gt)
    close = raw.find(b"</" + tag + b">", gt)
    if cdata >= 0 and (close < 0 or cdata < close):
        start = cdata + 9
        end = raw.find(b"]]>", start)
        if end < 0:
            return ""
        return raw[start:end].decode("utf-8", errors="replace").strip()
    if close < 0:
        return ""
    return raw[gt + 1 : close].decode("utf-8", errors="replace").strip()


def _ip(raw: bytes) -> str:
    i = raw.find(b"<IP")
    if i < 0:
        return ""
    gt = raw.find(b">", i)
    end = raw.find(b"</IP>", gt)
    if gt < 0 or end < 0:
        return ""
    return raw[gt + 1 : end].decode("utf-8", errors="replace").strip()


def _asset_tags(raw: bytes) -> list[str]:
    tags = []
    pos = 0
    token = b"<ASSET_TAG>"
    while True:
        i = raw.find(token, pos)
        if i < 0:
            break
        cdata = raw.find(b"<![CDATA[", i)
        end = raw.find(b"]]>", cdata) if cdata >= 0 else -1
        if cdata >= 0 and end >= 0:
            tags.append(raw[cdata + 9 : end].decode("utf-8", errors="replace").strip())
            pos = end + 3
        else:
            pos = i + len(token)
    return tags


def _unique_codes(matches: list[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for match in matches:
        code = match.upper()
        if code in FALSE_POSITIVE_CODES or code in seen:
            continue
        seen.add(code)
        found.append(code)
    return found


def extract_hotel_codes(dns: str, netbios: str, tags: list[str]) -> list[str]:
    host_codes = _unique_codes(HOTEL_RE.findall(f"{dns} {netbios}"))
    tag_codes = _unique_codes(
        match for tag in tags for match in TAG_HOTEL_RE.findall(tag)
    )
    if tag_codes:
        tag_set = set(tag_codes)
        preferred = [code for code in host_codes if code in tag_set]
        return _unique_codes(preferred + tag_codes)
    if len(host_codes) > 1:
        return host_codes[:1]
    return host_codes


def parse_admins(result: str) -> list[dict]:
    text = html.unescape(result)
    admins = []
    seen: set[tuple[str, str]] = set()
    for sid, name in ADMIN_RE.findall(text):
        name = name.strip()
        if "\\" in name:
            domain, account = name.split("\\", 1)
        else:
            domain, account = "", name
        key = (domain.upper(), account.lower())
        if key in seen:
            continue
        seen.add(key)
        admins.append(
            {
                "sid": sid,
                "domain": domain,
                "account": account,
                "name": name,
            }
        )
    return admins


def parse_host(raw: bytes) -> dict:
    dns = _cdata(raw, b"DNS")
    netbios = _cdata(raw, b"NETBIOS")
    os_name = _cdata(raw, b"OPERATING_SYSTEM")
    tags = _asset_tags(raw)
    result = _cdata(raw, b"RESULT")
    codes = extract_hotel_codes(dns, netbios, tags)
    admins = parse_admins(result)
    return {
        "ip": _ip(raw),
        "dns": dns,
        "netbios": netbios,
        "os": os_name,
        "hotel_codes": codes,
        "admins": admins,
        "admin_count": len(admins),
    }


def latest_xml(folder: Path | None = None) -> Path:
    folder = folder or ROOT
    xmls = [p for p in folder.glob("*.xml") if p.is_file()]
    if not xmls:
        raise FileNotFoundError(f"No Qualys XML export found in {folder}")
    return max(xmls, key=lambda p: p.stat().st_mtime)


def cache_is_stale(xml_path: Path, cache_path: Path = CACHE_PATH) -> bool:
    if not cache_path.exists():
        return True
    return xml_path.stat().st_mtime > cache_path.stat().st_mtime


def build_cache(xml_path: Path | None = None, cache_path: Path = CACHE_PATH) -> dict:
    xml_path = xml_path or latest_xml()
    if not xml_path.exists():
        raise FileNotFoundError(f"Qualys XML not found: {xml_path}")

    CACHE_DIR.mkdir(exist_ok=True)
    hosts: list[dict] = []
    by_hotel: dict[str, list[int]] = defaultdict(list)
    no_code: list[int] = []
    hotel_counts: Counter[str] = Counter()
    started = time.time()

    for raw in iter_host_blocks(xml_path):
        host = parse_host(raw)
        idx = len(hosts)
        hosts.append(host)
        if host["hotel_codes"]:
            for code in host["hotel_codes"]:
                by_hotel[code].append(idx)
                hotel_counts[code] += 1
        else:
            no_code.append(idx)
        if len(hosts) % 10000 == 0:
            elapsed = time.time() - started
            print(f"  parsed {len(hosts):,} hosts in {elapsed:.1f}s", flush=True)

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": xml_path.name,
        "hosts": hosts,
        "by_hotel": dict(by_hotel),
        "no_code": no_code,
    }
    cache_path.write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))

    summary = {
        "source": xml_path.name,
        "generated": payload["generated"],
        "host_count": len(hosts),
        "hotel_count": len(by_hotel),
        "hosts_without_code": len(no_code),
        "hotels": [
            {"code": code, "hosts": hotel_counts[code]}
            for code in sorted(by_hotel)
        ],
    }
    SUMMARY_PATH.write_text(json.dumps(summary), encoding="utf-8")
    elapsed = time.time() - started
    print(
        f"Done: {len(hosts):,} hosts, {len(by_hotel):,} hotel codes, "
        f"{len(no_code):,} without a code, cache {cache_path.stat().st_size / 1e6:.1f} MB in {elapsed:.1f}s"
    )
    return payload


def load_cache(force: bool = False) -> dict:
    xml_path = latest_xml()
    if force or cache_is_stale(xml_path):
        print(f"Parsing {xml_path.name} (this takes about 15 seconds)...", flush=True)
        return build_cache(xml_path)
    print(f"Using cache for {xml_path.name}", flush=True)
    return pickle.loads(CACHE_PATH.read_bytes())


if __name__ == "__main__":
    force = "--rebuild" in sys.argv
    load_cache(force=force)
