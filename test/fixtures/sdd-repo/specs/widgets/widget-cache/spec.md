# Widget Cache

## Status
Implemented — Epic ACME-10 delivered every row (2026-01-15).

## Summary
Widgets render from a cache so a configuration outage never blanks the dashboard.

## Functional Requirements

| ID | Requirement |
|---|---|
| WDG-CCH-001 | When the configuration service is unreachable, the last known good widget config is served. |
| WDG-CCH-002 | Cached entries expire after 300 seconds. |
| WDG-CCH-003 | Cache misses are logged with the widget key and never include viewer identifiers. |
| WDG-CCH-004 | Superseded by WDG-CCH-002. ~~Cached entries never expire.~~ |

## Security Requirements
Log lines must not contain viewer identifiers or session tokens.

## Acceptance Criteria

| ID | Verifies | Criterion |
|---|---|---|
| AC-WDG-CCH-001 | 001–002 | Given the configuration service is stopped, When a dashboard loads, Then cached widgets render. |
| AC-WDG-CCH-002 | 003, WDG-OTH-001 | A cache miss writes one log line with the key and no viewer id. |
