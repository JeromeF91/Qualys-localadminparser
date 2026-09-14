"""Local dashboard server for Qualys administrator-group members."""

from __future__ import annotations

import json
import re
import threading
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from parse_qualys import cache_is_stale, latest_xml, load_cache

ROOT = Path(__file__).resolve().parent
DATA = None
HOTEL_INDEX = []
LOCK = threading.RLock()

DOMAIN_SET = {
    "AA",
    "ACCOR",
    "AU",
    "AZUREAD",
    "BUILTIN",
    "CPH",
    "EUR",
    "NAM",
    "NT AUTHORITY",
    "NT SERVICE",
    "SA",
    "STELLA",
    "VAUBAN",
}


def admin_kind(admin: dict, netbios: str) -> str:
    domain = (admin.get("domain") or "").upper()
    nb = (netbios or "").upper()
    if domain in DOMAIN_SET:
        return "domain"
    if nb and (domain == nb or domain == nb.split(".")[0]):
        return "local"
    if domain and ("-" in domain or domain.startswith(("W-", "L-", "S-", "US-", "FR-"))):
        return "local"
    if domain:
        return "other"
    return "unknown"


def attach_kinds(host: dict) -> list[dict]:
    out = []
    for admin in host["admins"]:
        item = dict(admin)
        item["kind"] = admin_kind(admin, host.get("netbios") or "")
        out.append(item)
    return out


def host_role(os_name: str) -> str:
    text = (os_name or "").lower()
    if "server" in text or "hyper-v" in text:
        return "server"
    return "workstation"


def _empty_role_stats() -> dict:
    return {
        "host_count": 0,
        "memberships": 0,
        "unique_admin_count": 0,
        "kind_counts": Counter(),
        "os_counts": Counter(),
        "local_unique": 0,
        "domain_unique": 0,
    }


def hotel_payload(code: str) -> dict | None:
    with LOCK:
        return _hotel_payload(code)


def _hotel_payload(code: str) -> dict | None:
    code = code.upper()
    indexes = DATA["by_hotel"].get(code)
    if indexes is None:
        return None
    hosts = []
    unique_admins: dict[tuple[str, str], dict] = {}
    kinds = Counter()
    os_counts = Counter()
    role_stats = {
        "workstation": _empty_role_stats(),
        "server": _empty_role_stats(),
    }
    role_admin_keys = {"workstation": set(), "server": set()}

    for idx in indexes:
        host = DATA["hosts"][idx]
        admins = attach_kinds(host)
        role = host_role(host.get("os") or "")
        label = host["dns"] or host["netbios"] or host["ip"]
        hosts.append(
            {
                "ip": host["ip"],
                "dns": host["dns"],
                "netbios": host["netbios"],
                "os": host["os"],
                "role": role,
                "hotel_codes": host["hotel_codes"],
                "admin_count": host["admin_count"],
                "admins": admins,
            }
        )
        os_counts[host["os"] or "Unknown"] += 1
        stats = role_stats[role]
        stats["host_count"] += 1
        stats["memberships"] += len(admins)
        stats["os_counts"][host["os"] or "Unknown"] += 1
        for admin in admins:
            kinds[admin["kind"]] += 1
            stats["kind_counts"][admin["kind"]] += 1
            if admin["kind"] == "local":
                key = ("LOCAL", admin["account"].lower())
                display_name = admin["account"]
                display_domain = "Local"
            else:
                key = (admin["domain"].upper(), admin["account"].lower())
                display_name = admin["name"]
                display_domain = admin["domain"]
            role_admin_keys[role].add(key)
            bucket = unique_admins.setdefault(
                key,
                {
                    "domain": display_domain,
                    "account": admin["account"],
                    "name": display_name,
                    "kind": admin["kind"],
                    "sid": admin["sid"],
                    "grouped": admin["kind"] == "local",
                    "host_count": 0,
                    "hosts": [],
                    "workstation_count": 0,
                    "server_count": 0,
                    "workstation_hosts": [],
                    "server_hosts": [],
                    "usages": [],
                    "sids": [],
                },
            )
            if label not in bucket["hosts"]:
                bucket["hosts"].append(label)
                bucket["host_count"] += 1
            role_list = bucket[f"{role}_hosts"]
            if label not in role_list:
                role_list.append(label)
                bucket[f"{role}_count"] += 1
            bucket["usages"].append(
                {
                    "host": label,
                    "netbios": host.get("netbios") or "",
                    "ip": host.get("ip") or "",
                    "role": role,
                    "sam": admin["name"],
                    "sid": admin["sid"],
                }
            )
            if admin["sid"] and admin["sid"] not in bucket["sids"]:
                bucket["sids"].append(admin["sid"])

    for role, keys in role_admin_keys.items():
        stats = role_stats[role]
        stats["unique_admin_count"] = len(keys)
        stats["local_unique"] = sum(
            1 for key in keys if unique_admins[key]["kind"] == "local"
        )
        stats["domain_unique"] = sum(
            1 for key in keys if unique_admins[key]["kind"] == "domain"
        )
        stats["kind_counts"] = dict(stats["kind_counts"])
        stats["os_counts"] = stats["os_counts"].most_common(6)

    unique_list = []
    both = workstation_only = server_only = 0
    for admin in unique_admins.values():
        if admin["workstation_count"] and admin["server_count"]:
            presence = "both"
            both += 1
        elif admin["workstation_count"]:
            presence = "workstation"
            workstation_only += 1
        else:
            presence = "server"
            server_only += 1
        admin["presence"] = presence
        admin["sid_count"] = len(admin.get("sids") or [])
        unique_list.append(admin)
    unique_list.sort(key=lambda a: (-a["host_count"], a["name"].lower()))

    serialized_roles = {}
    for role, stats in role_stats.items():
        serialized_roles[role] = dict(stats)

    return {
        "code": code,
        "host_count": len(hosts),
        "unique_admin_count": len(unique_list),
        "admin_memberships": sum(h["admin_count"] for h in hosts),
        "kind_counts": dict(kinds),
        "os_counts": os_counts.most_common(8),
        "roles": serialized_roles,
        "presence_counts": {
            "workstation": workstation_only,
            "server": server_only,
            "both": both,
        },
        "hosts": sorted(
            hosts,
            key=lambda h: (h["role"], (h["dns"] or h["netbios"] or h["ip"]).lower()),
        ),
        "unique_admins": unique_list,
    }


def summary_payload() -> dict:
    hotels = []
    for code, indexes in DATA["by_hotel"].items():
        hotels.append({"code": code, "hosts": len(indexes)})
    hotels.sort(key=lambda h: (-h["hosts"], h["code"]))
    prefix = Counter()
    for hotel in hotels:
        prefix[hotel["code"][0]] += 1
    return {
        "source": DATA["source"],
        "generated": DATA["generated"],
        "host_count": len(DATA["hosts"]),
        "hotel_count": len(DATA["by_hotel"]),
        "hosts_without_code": len(DATA["no_code"]),
        "prefix_counts": dict(prefix),
        "top_hotels": hotels[:30],
        "hotels": hotels,
        "latest_xml": xml_status()["latest_xml"],
        "stale": xml_status()["stale"],
    }


def xml_status() -> dict:
    xml = latest_xml()
    loaded = DATA["source"] if DATA else None
    stale = cache_is_stale(xml) or (loaded is not None and loaded != xml.name)
    return {
        "loaded_source": loaded,
        "latest_xml": xml.name,
        "stale": stale,
        "generated": DATA["generated"] if DATA else None,
    }


def apply_data(payload: dict) -> None:
    global DATA, HOTEL_INDEX
    DATA = payload
    HOTEL_INDEX = [
        {"code": code, "hosts": len(indexes)}
        for code, indexes in sorted(DATA["by_hotel"].items())
    ]


def reload_data(force: bool = False) -> dict:
    status = xml_status()
    if not force and not status["stale"]:
        return {
            "rebuilt": False,
            "source": status["loaded_source"],
            "latest_xml": status["latest_xml"],
            "message": "Already using the latest XML export.",
        }
    with LOCK:
        payload = load_cache(force=True)
        apply_data(payload)
    return {
        "rebuilt": True,
        "source": payload["source"],
        "latest_xml": payload["source"],
        "host_count": len(payload["hosts"]),
        "hotel_count": len(payload["by_hotel"]),
        "generated": payload["generated"],
        "message": f"Loaded {payload['source']}.",
    }


def search_hotels(query: str, limit: int = 40) -> list[dict]:
    q = query.strip().upper()
    hits = []
    for item in HOTEL_INDEX:
        if not q or item["code"].startswith(q) or q in item["code"]:
            hits.append(item)
            if len(hits) >= limit:
                break
    return hits


def uncoded_payload(limit: int = 200, offset: int = 0) -> dict:
    indexes = DATA["no_code"]
    slice_ = indexes[offset : offset + limit]
    hosts = []
    for idx in slice_:
        host = DATA["hosts"][idx]
        hosts.append(
            {
                "ip": host["ip"],
                "dns": host["dns"],
                "netbios": host["netbios"],
                "os": host["os"],
                "admin_count": host["admin_count"],
                "admins": attach_kinds(host),
            }
        )
    return {
        "total": len(indexes),
        "offset": offset,
        "hosts": hosts,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print("[http] " + (fmt % args))

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/summary":
            self._json(summary_payload())
            return
        if path == "/api/hotels":
            q = qs.get("q", [""])[0]
            self._json({"hotels": search_hotels(q)})
            return
        if path.startswith("/api/hotel/"):
            code = path.split("/api/hotel/", 1)[1].strip().upper()
            if not re.fullmatch(r"[HV][A-Za-z0-9]{4}", code):
                self._json({"error": "Hotel code must be H or V plus 4 alphanumeric characters."}, 400)
                return
            payload = hotel_payload(code)
            if payload is None:
                self._json({"error": f"No hosts found for {code}."}, 404)
                return
            self._json(payload)
            return
        if path == "/api/uncoded":
            limit = int(qs.get("limit", ["200"])[0])
            offset = int(qs.get("offset", ["0"])[0])
            self._json(uncoded_payload(limit=min(limit, 500), offset=offset))
            return
        if path == "/api/reload":
            force = qs.get("force", ["0"])[0] in {"1", "true"}
            try:
                self._json(reload_data(force=force))
            except Exception as exc:
                self._json({"error": str(exc)}, 500)
            return
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/reload":
            try:
                self._json(reload_data(force=True))
            except Exception as exc:
                self._json({"error": str(exc)}, 500)
            return
        self.send_error(404)


def main() -> None:
    print("Loading Qualys cache...", flush=True)
    apply_data(load_cache())
    print(
        f"Ready: {len(DATA['hosts']):,} hosts, {len(DATA['by_hotel']):,} hotel codes · source {DATA['source']}",
        flush=True,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("Dashboard: http://127.0.0.1:8765", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
