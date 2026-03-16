# Reliability Tracking & Feature Roadmap

This document details the planned reliability tracking features, data architecture, and implementation strategy for Komt ie?.

---

## Table of Contents

1. [Untapped OVapi Data](#1-untapped-ovapi-data)
2. [Delay Definitions & Thresholds](#2-delay-definitions--thresholds)
3. [Data Storage & Reliability Score Architecture](#3-data-storage--reliability-score-architecture)
4. [Feature Specifications](#4-feature-specifications)
5. [New API Endpoints](#5-new-api-endpoints)
6. [External Data Sources](#6-external-data-sources)
7. [Data Pipeline](#7-data-pipeline)

---

## 1. Untapped OVapi Data

The OVapi TPC endpoint returns ~40 fields per passtime object. We currently extract only 8. The following unused fields are critical for reliability tracking:

| Field | Purpose | Values |
|-------|---------|--------|
| `TripStopStatus` | Trip lifecycle state | `PLANNED`, `DRIVING`, `ARRIVED`, `PASSED`, `CANCEL`, `UNKNOWN` |
| `JourneyDisrupted` | Delay indicator flag | Boolean — `true` if delay >= 1 min and steadily increasing |
| `ReasonType` | Disruption category | BISON table E11 codes |
| `ReasonContent` | Disruption description | Free text (e.g. "Wegwerkzaamheden Utrechtseweg") |
| `SubReasonType` | Specific disruption cause | BISON table E12 codes |
| `MessageType` | Message display context | BISON table E4B codes |
| `MessageContent` | Passenger-facing message | Free text — operator-published notes, roadworks, diversions |
| `AdviceType` | Travel advice category | BISON table E13 codes |
| `AdviceContent` | Passenger guidance text | Free text (e.g. "Neem lijn 5 als alternatief") |
| `ExpectedDepartureTime` | Predicted departure | ISO8601 datetime |
| `TargetDepartureTime` | Scheduled departure | ISO8601 datetime |
| `WheelChairAccessible` | Vehicle accessibility | `UNKNOWN`, `ACCESSIBLE`, `NOTACCESSIBLE` |
| `NumberOfCoaches` | Vehicle size | Integer |
| `LastUpdateTimeStamp` | Data freshness | ISO8601 datetime |

**Key insight**: Delay, cancellation, disruption messages, and roadworks info are all already present in the OVapi response — we just need to extract them.

### Delay Calculation

Already derivable from existing data without any new API calls:

```javascript
const delaySeconds = (new Date(ExpectedArrivalTime) - new Date(TargetArrivalTime)) / 1000;
```

### Cancellation Detection

```javascript
const isCancelled = passtime.TripStopStatus === 'CANCEL';
```

### Ghost Bus Detection

A bus is a "ghost bus" when:
- `TripStopStatus` remains `PLANNED` past its `TargetDepartureTime`
- It never transitions to `DRIVING` / `ARRIVED` / `PASSED`
- And eventually disappears from the API without a `CANCEL` status

---

## 2. Delay Definitions & Thresholds

### Official Dutch Standard (DOVA / Staat van het OV)

The national punctuality measurement for bus, tram, metro, and ferry:

- **On time** = departs max **30 seconds early** to max **180 seconds (3 minutes) late**
- **Late** = > 3 minutes after scheduled time
- National average: ~80% of buses/trams/metros run on time by this definition

### Proposed App Thresholds

| Status | Delay | Colour | Label |
|--------|-------|--------|-------|
| On time | <= 1 min | Green | "Op tijd" |
| Slightly delayed | 1–3 min | Amber | "+2 min" |
| Late | 3–5 min | Orange | "+4 min" |
| Very late | > 5 min | Red | "+8 min" |
| Cancelled | `TripStopStatus === 'CANCEL'` | Red | "Vervallen" |

### OVapi's Own Flag

`JourneyDisrupted: true` is set by OVapi when delay >= 1 minute and steadily increasing. This can be used as an additional signal.

---

## 3. Data Storage & Reliability Score Architecture

### GOVI License Constraint

Raw OVapi data must not be stored for more than 30 minutes. However, **aggregated statistics** (counts, averages, percentages) are permitted since they are derived metrics, not raw data.

### Storage: SQLite

Lightweight, zero-config, no external dependencies. Lives alongside the existing `stops_cache.json`.

#### Schema

```sql
-- Aggregated reliability stats per line/stop/time-of-day
CREATE TABLE reliability_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  stop_code TEXT NOT NULL,
  operator TEXT,
  transport_type TEXT,
  day_of_week INTEGER NOT NULL,       -- 0=Sunday, 6=Saturday
  hour INTEGER NOT NULL,              -- 0-23
  on_time_count INTEGER DEFAULT 0,    -- delay <= 60s
  slight_delay_count INTEGER DEFAULT 0, -- 60s < delay <= 180s
  late_count INTEGER DEFAULT 0,       -- delay > 180s
  cancel_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  total_delay_seconds INTEGER DEFAULT 0,
  last_updated DATETIME,
  UNIQUE(line, stop_code, day_of_week, hour)
);

-- Rolling 7-day window of individual delay observations
CREATE TABLE delay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  stop_code TEXT NOT NULL,
  journey_number TEXT,
  timestamp DATETIME NOT NULL,
  scheduled_time DATETIME,
  expected_time DATETIME,
  delay_seconds INTEGER,
  was_cancelled BOOLEAN DEFAULT FALSE,
  trip_stop_status TEXT,
  had_live_tracking BOOLEAN
);

-- User-submitted ghost bus reports
CREATE TABLE ghost_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  stop_code TEXT NOT NULL,
  journey_number TEXT,
  scheduled_time DATETIME,
  reported_at DATETIME NOT NULL,
  confirmed_by_data BOOLEAN DEFAULT FALSE  -- cross-referenced with OVapi CANCEL status
);

-- Live tracking coverage per stop (for dead zone mapping)
CREATE TABLE tracking_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stop_code TEXT NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  live_count INTEGER DEFAULT 0,
  scheduled_count INTEGER DEFAULT 0,
  UNIQUE(stop_code, date, hour)
);

-- Active disruption/roadworks messages (ephemeral, refreshed each poll)
CREATE TABLE active_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT,
  stop_code TEXT,
  message_type TEXT,
  message_content TEXT,
  reason_type TEXT,
  reason_content TEXT,
  advice_type TEXT,
  advice_content TEXT,
  first_seen DATETIME,
  last_seen DATETIME,
  UNIQUE(line, stop_code, message_content)
);
```

#### Maintenance Jobs

- **Every poll (15s)**: Update `reliability_stats` aggregates, insert `delay_events`, refresh `active_messages`, update `tracking_coverage`.
- **Daily**: Purge `delay_events` older than 7 days. Recalculate any derived caches.
- **Weekly**: Archive `reliability_stats` to allow trend analysis.

### Reliability Score Formula

```
reliability_percentage = (on_time_count / total_count) * 100
```

Filterable by:
- Line number
- Stop code
- Day of week (weekday vs weekend)
- Time of day (morning rush 7-9, evening rush 16-18, off-peak)

Example output: **"Line 12 arrives on time 71% of the time on weekday mornings (7–9am)"**

---

## 4. Feature Specifications

### 4.1 "Bus Didn't Show Up" Report Button

**User flow:**
1. User sees a scheduled departure that didn't arrive
2. Taps "Didn't show up" button on the departure row
3. Backend records the report and cross-references with OVapi data

**Backend logic:**
- If `TripStopStatus === 'CANCEL'` → auto-confirm, label as "Cancelled by operator"
- If status is `PLANNED` but bus never transitioned to `DRIVING`/`ARRIVED`/`PASSED` → auto-confirm as ghost bus
- If neither condition met → store as user report, require 2+ reports to flag
- Increment `ghost_reports` table, set `confirmed_by_data` accordingly

### 4.2 Route Reliability Score

**Display:** Per-line reliability percentage shown on the departure board, filterable by time-of-day.

**Data source:** `reliability_stats` table, aggregated over rolling 30-day window.

**UI:** Small badge or expandable section per line: "71% on time · weekday mornings"

### 4.3 Personalised Commute Memory

**Storage:** Client-side `localStorage`:
```json
{
  "savedCommutes": [
    {
      "name": "Morning commute",
      "stopCodes": ["30003784", "30003785"],
      "filterLine": "12",
      "filterDestination": "Utrecht CS"
    }
  ]
}
```

**UX:** One-tap save, one-tap load. App opens straight to saved commute with zero friction.

### 4.4 "Leave Now" Notification

**Requirements:**
- User's home coordinates (saved in localStorage)
- Walking time to stop (calculated from Haversine distance, ~5 km/h walking speed)
- Service Worker for push notifications

**Logic:**
```
notifyAt = departureTime - walkingMinutes - bufferMinutes(2)
```

When `now >= notifyAt`, push: "Leave now — Line 12 departs in {walkingMinutes + 2} minutes"

**Implementation:** Service Worker + Notification API. No server-side push infrastructure needed for MVP — the WebSocket connection can trigger the notification while the app is open.

### 4.5 Weather-Aware Suggestions

**API:** Open-Meteo (free, no API key, covers Netherlands):
```
https://api.open-meteo.com/v1/forecast?latitude=52.09&longitude=5.12&current=precipitation,wind_speed_10m
```

**Logic:**
- If `precipitation > 2.5 mm/h` (heavy rain): show "Heavy rain — consider taking the bus instead of cycling"
- If `wind_speed > 60 km/h` (storm): show weather warning
- Integrate into journey suggestions and departure board header

### 4.6 Delay Streak Tracker

**Query:**
```sql
SELECT DATE(timestamp) as day, AVG(delay_seconds) as avg_delay
FROM delay_events
WHERE line = ? AND stop_code = ? AND timestamp > datetime('now', '-14 days')
GROUP BY DATE(timestamp)
HAVING avg_delay > 180
ORDER BY day DESC;
```

Count consecutive days. Display: **"Line 9 has been late 4 days in a row at this stop"**

**UI:** Shareable card format — users can screenshot or share link.

### 4.7 Dead Zone Mapper

**Data source:** `tracking_coverage` table.

**Calculation:**
```
live_ratio = live_count / (live_count + scheduled_count)
```

Stops with `live_ratio < 0.2` over the last 7 days are "dead zones".

**Display:** Map overlay with coloured circles:
- Green (>80% live): excellent tracking
- Yellow (40–80%): partial tracking
- Red (<40%): poor tracking
- Grey (<20%): dead zone — no reliable live data

### 4.8 Roadworks & Service Messages

**Data source:** Already in OVapi response — `MessageContent`, `ReasonContent`, `AdviceContent` fields.

**Display:**
- Banner at top of departure board when active messages exist for subscribed stops
- Per-departure icon if a specific journey has disruption info
- Expandable detail showing reason + advice text

**Alternative source:** The 9292 Reisberichten API provides planned/unplanned disruptions filterable by area, operator, and line — but requires a commercial license from 9292.

### 4.9 "No Live Tracking" Notice

**Logic:**
- Per departure: already shown via LIVE/SCHEDULED badge
- Per stop: if ALL departures at a stop have `confidence === 'scheduled'`, show banner: "No live vehicle tracking available — times are scheduled estimates only"
- Per transport mode: if a transport type (e.g. ferry) consistently lacks live data, note it in the UI

---

## 5. New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reliability/:line` | Reliability score for a line (optionally filtered by `?stopCode=`, `?dayOfWeek=`, `?hour=`) |
| `GET` | `/api/reliability/:line/:stopCode` | Reliability score for a specific line + stop combination |
| `GET` | `/api/disruptions` | Currently active disruption/roadworks messages |
| `GET` | `/api/disruptions/:stopCode` | Disruptions affecting a specific stop |
| `POST` | `/api/report/ghost` | Submit a ghost bus report (`{ line, stopCode, journeyNumber, scheduledTime }`) |
| `GET` | `/api/deadzones` | Stops with consistently poor live tracking coverage |
| `GET` | `/api/deadzones/nearby` | Dead zones near coordinates (`?lat=&lon=&radius=`) |
| `GET` | `/api/weather` | Current weather for coordinates (`?lat=&lon=`) — proxied from Open-Meteo |

### Enhanced WebSocket Message

The departure objects sent over WebSocket will be enriched:

```json
{
  "type": "departures",
  "departures": [
    {
      "stopCode": "30003784",
      "line": "12",
      "destination": "Utrecht CS",
      "expectedTime": "2026-03-16T08:15:00+01:00",
      "scheduledTime": "2026-03-16T08:12:00+01:00",
      "minutesUntil": 4,
      "isRealtime": true,
      "confidence": "live",
      "journeyNumber": "1234",
      "transportType": "BUS",
      "operator": "CXX",

      "delaySeconds": 180,
      "delayStatus": "late",
      "isCancelled": false,
      "tripStopStatus": "DRIVING",
      "journeyDisrupted": true,
      "message": "Omleiding i.v.m. wegwerkzaamheden",
      "reliabilityScore": 71
    }
  ],
  "stopMessages": [
    {
      "stopCode": "30003784",
      "messageContent": "Halte tijdelijk verplaatst",
      "reasonContent": "Wegwerkzaamheden Utrechtseweg",
      "adviceContent": "Gebruik halte aan de overkant"
    }
  ],
  "fetchedAt": "2026-03-16T08:11:15Z"
}
```

---

## 6. External Data Sources

| Source | Purpose | Access |
|--------|---------|--------|
| OVapi TPC (`v0.ovapi.nl/tpc/`) | Departures, delays, cancellations, messages | Free, already used |
| OVapi GTFS-RT (`gtfs.ovapi.nl`) | Vehicle positions, stops | Free, already used |
| Open-Meteo | Weather data for Netherlands | Free, no API key |
| 9292 Reisberichten API | Planned/unplanned disruptions | Commercial license required |
| NDOV Loket | Raw KV6/KV15/KV17 data streams | Free, requires registration |

### BISON/NDOV Data Standards (Reference)

The Dutch public transport data ecosystem uses these "Koppelvlakken" (coupling interfaces):

- **KV1**: Timetable data (dienstregeling)
- **KV6**: Real-time punctuality — the source of `ExpectedArrivalTime` in OVapi
- **KV15**: Free text messages — the source of `MessageContent` in OVapi
- **KV17**: Operational mutations — trip cancellations (`CANCEL`), route shortening (`SHORTEN`), stop skipping
- **KV78Turbo**: Combined real-time feed (what OVapi consumes)

OVapi already aggregates KV6, KV15, and KV17 into its TPC endpoint, so we don't need to consume NDOV directly — we just need to parse the fields OVapi already provides.

---

## 7. Data Pipeline

### Current Pipeline

```
OVapi ──▶ parse 8 fields ──▶ WebSocket ──▶ Frontend
```

### Proposed Pipeline

```
OVapi ──▶ parse 20+ fields ──┬──▶ Reliability aggregator ──▶ SQLite
                              │
                              ├──▶ WebSocket (enriched departures + messages)
                              │
                              └──▶ REST endpoints (reliability, disruptions, dead zones)

Open-Meteo ──▶ Weather proxy ──▶ Frontend

localStorage ──▶ Saved commutes, "leave now" settings
```

### Implementation Priority

1. **Extract more OVapi fields** — immediate value, no new dependencies
2. **Add delay calculation + status to departures** — enriches existing UI
3. **Show disruption/roadworks messages** — already in the data
4. **Add "no live tracking" notices** — simple frontend change
5. **SQLite + reliability aggregation** — foundation for all score features
6. **Ghost bus reporting** — crowdsourced + data-confirmed
7. **Reliability scores + delay streaks** — requires accumulated data
8. **Dead zone mapper** — requires accumulated tracking coverage data
9. **Personalised commute memory** — client-side only
10. **"Leave now" notification** — Service Worker integration
11. **Weather-aware suggestions** — Open-Meteo integration
