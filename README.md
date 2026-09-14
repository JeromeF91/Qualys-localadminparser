# Hotel administrator dashboard

Local web dashboard for a Qualys **Administrator Group Members** export. It groups hosts from DNS, NetBIOS, and Qualys asset tags and shows who is in the local Administrators group on workstations and servers.

The app listens on **localhost only**. It does not upload the XML.

## Requirements

- **Python 3.10+** (standard library only — no `pip install`, no Node)
- A modern browser
- A Qualys `.xml` asset data report in this folder
- About **1 GB RAM** while the server is running, plus disk for the XML (~300 MB) and the generated cache (~150 MB)

## Quick start

1. Put the Qualys XML export in this folder (keep the Qualys filename).
2. Start the server:

```powershell
python serve.py
```

3. Open [http://127.0.0.1:8765](http://127.0.0.1:8765).

The first run parses the XML into `cache/hosts.pkl` (about 15 seconds for a ~300 MB file). Later starts reuse that cache unless a newer XML is present.

## Refreshing the data

Drop the new `.xml` into this folder. The **newest** `.xml` by file date is used.

- On the overview page, click **Reload from latest XML**, or
- Rebuild from a terminal, then restart the server:

```powershell
python parse_qualys.py --rebuild
python serve.py
```

`python serve.py` also rebuilds the cache automatically if the XML is newer than `cache/hosts.pkl`.

## Using the dashboard

- **Filter** the inventory using codes taken from DNS, NetBIOS, and Qualys asset tags.
- Open a **drilldown** for workstation vs server counts, domain vs local mix, host list, and administrator identities.
- Tabs **Workstations** / **Servers** filter both tables.
- **Local** accounts with the same name (for example `AdminIT`) are grouped. Click a row to see every host and the local SAM name (`HOSTNAME\AdminIT`). Distinct SIDs under the same name are called out.
- **Export CSV** downloads per-host memberships for the current filter.

## Layout

```
adminparser/
  serve.py          HTTP dashboard (port 8765)
  parse_qualys.py   XML → cache
  web/              UI
  cache/            generated (hosts.pkl) — do not commit
  *.xml             Qualys export(s)
```

## Notes

- Workstations vs servers is based on the Qualys OS string (`Windows Server` / Hyper-V vs Windows 10/11).
- Domain vs local treats well-known Active Directory domains as domain accounts. Accounts whose domain is the machine name are treated as local.
- The dashboard is not a multi-user service. Stop it with Ctrl+C when you are done.
