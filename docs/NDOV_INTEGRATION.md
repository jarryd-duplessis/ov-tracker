# NDOV ZeroMQ Integration

**Status:** Planning
**Effort estimate:** 2-3 days
**Monthly cost:** ~$4-8 (EC2 t4g.nano + SQS)
**Dependency:** NDOV API key (free, register at data.ndovloket.nl)

---

## 1. What NDOV Provides

NDOV (Nationale Data Openbaar Vervoer) is the official Dutch open-data distribution platform for public transport, operated by DOVA (Federatieve Samenwerking Reisinformatie) with institutional backing from the nine Dutch provinces and the Amsterdam/Rotterdam/The Hague metropolitan authorities.

### Data streams

| Stream | Protocol | Content | Volume |
|--------|----------|---------|--------|
| **KV6posinfo** | ZeroMQ PUB/SUB | Vehicle events: INIT, ARRIVAL, ONSTOP, DEPARTURE, END | ~30 msgs/sec across NL |
| **KV15messages** | ZeroMQ PUB/SUB | Service alerts, disruptions, cancellations | ~50-200 msgs/day |
| **KV17cvlinfo** | ZeroMQ PUB/SUB | Journey cancellations and mutations | ~100-500 msgs/day |

### KV6 event types

| Event | Meaning | Fields |
|-------|---------|--------|
| `INIT` | Trip has started (driver logged in) | dataownercode, lineplanningnumber, journeynumber, timestamp |
| `ARRIVAL` | Vehicle arrived at a stop | + userstopcode, punctuality (seconds early/late) |
| `ONSTOP` | Vehicle is dwelling at a stop | + userstopcode, punctuality |
| `DEPARTURE` | Vehicle departed a stop | + userstopcode, punctuality |
| `END` | Trip has ended (driver logged out) | dataownercode, lineplanningnumber, journeynumber |

### Why NDOV over OVapi GTFS-RT

| Metric | OVapi GTFS-RT | NDOV ZeroMQ |
|--------|---------------|-------------|
| Latency | 3-10s (HTTP polling, server processing) | <1s (direct push) |
| Data model | GPS coordinates (lat/lon) | Stop-level events (arrival/departure + punctuality) |
| Operators | Most NL operators | ALL NL operators (including NS trains, ferries) |
| Disruptions | Not available | KV15 messages (full disruption text + affected lines) |
| Cancellations | Not available | KV17 journey cancellations |
| SLA | None (community project, best-effort) | Institutional backing (DOVA) |
| Protocol | HTTP GET (poll) | ZeroMQ PUB/SUB (push, persistent TCP) |
| Coverage | ~4,000 vehicles at peak | All active trips NL-wide |

### Key insight: KV6 is event-based, not GPS

KV6 does not provide continuous GPS coordinates. It provides discrete events at stops: "Vehicle X arrived at stop Y with Z seconds delay." This is fundamentally different from GTFS-RT GPS positions.

To display vehicles on a map between stops, we must **dead-reckon along route shapes** using:
- The last stop event (which stop, when, how much delay)
- The next stop (from the schedule)
- The route shape between those two stops
- Elapsed time since the last event

This makes server-side dead reckoning (see `SERVER_DEAD_RECKONING.md`) a prerequisite for fully leveraging NDOV data on a map.

---

## 2. Architecture

### Current architecture (OVapi polling)

```
[OVapi GTFS-RT]  ─── HTTP GET every 10s ───→  [ingest_vehicles Lambda]
                                                       ↓
                                               [S3 tiles + events]
```

### Target architecture (NDOV ZeroMQ + OVapi fallback)

```
                                                    ┌─────────────────┐
                                                    │ NDOV ZeroMQ     │
                                                    │ PUB sockets     │
                                                    └────┬───┬───┬────┘
                                                         │   │   │
                                          KV6posinfo ────┘   │   └──── KV17cvlinfo
                                          KV15messages ───────┘
                                                         │
                                              ┌──────────▼──────────┐
                                              │ EC2 t4g.nano        │
                                              │ ZeroMQ SUB process  │
                                              │ (Node.js + zeromq)  │
                                              └──────────┬──────────┘
                                                         │
                                    ┌────────────────────┼────────────────────┐
                                    │                    │                    │
                              ┌─────▼─────┐        ┌────▼────┐        ┌─────▼─────┐
                              │ SQS: kv6  │        │ SQS:kv15│        │ SQS: kv17 │
                              └─────┬─────┘        └────┬────┘        └─────┬─────┘
                                    │                    │                    │
                              ┌─────▼─────┐        ┌────▼────┐        ┌─────▼─────┐
                              │ Lambda:   │        │ Lambda: │        │ Lambda:   │
                              │process_kv6│        │proc_kv15│        │proc_kv17  │
                              └─────┬─────┘        └────┬────┘        └─────┬─────┘
                                    │                    │                    │
                              ┌─────▼─────┐        ┌────▼────┐              │
                              │ DynamoDB: │        │DynamoDB:│              │
                              │ trip_state│        │disrupts │              │
                              └─────┬─────┘        └─────────┘              │
                                    │                                        │
                    ┌───────────────▼───────────────┐                       │
                    │ ingest_vehicles Lambda         │◄──────────────────────┘
                    │ (reads trip_state + schedule,  │
                    │  dead-reckons along shapes,    │
                    │  writes tiles to S3)           │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                          [S3 tiles + events]
                                    │
                          [CloudFront (3s cache)]
                                    │
                                [Browser]
```

### ZeroMQ subscriber process

The EC2 instance runs a single Node.js process that:

1. Connects to NDOV's ZeroMQ PUB sockets (persistent TCP connections)
2. Subscribes to KV6, KV15, and KV17 topics
3. Receives gzip-compressed XML messages
4. Parses XML, extracts structured events
5. Writes to the appropriate SQS queue
6. Maintains a heartbeat — if no message received for 60s, reconnects
7. Logs connection state and message throughput to CloudWatch

### Fallback strategy

```
Primary:   NDOV ZeroMQ → SQS → Lambda → DynamoDB trip_state
Fallback:  OVapi GTFS-RT → ingest_vehicles (current approach)

Decision logic in ingest_vehicles:
  if (trip_state has fresh data for this trip, < 60s old):
    use KV6-derived position (dead-reckoned from last stop event)
  else:
    use GTFS-RT GPS position (current approach)
    mark confidence as "estimated" (no KV6 anchor)
```

This means the OVapi GTFS-RT polling in `ingest_vehicles.js` remains active as a fallback. Vehicles with fresh KV6 data get higher-confidence positions; vehicles without KV6 data fall back to GPS interpolation.

---

## 3. Implementation Steps

### Phase A: Infrastructure (1 day)

| # | Task | Effort | Details |
|---|------|--------|---------|
| A1 | Register for NDOV API key | 15 min | Register at data.ndovloket.nl, receive credentials within 1-2 business days |
| A2 | Provision EC2 t4g.nano | 30 min | Amazon Linux 2023, arm64, in eu-west-1 (same region as Lambdas). Place in the same VPC. |
| A3 | Create SQS queues | 15 min | `komt-ie-kv6`, `komt-ie-kv15`, `komt-ie-kv17` — standard queues, 14-day retention |
| A4 | Create DynamoDB tables | 15 min | `komt-ie-trip-state` (PK: `tripId`, TTL on `expiresAt`), `komt-ie-disruptions` (PK: `messageId`, TTL) |
| A5 | Set up EC2 security group | 15 min | Outbound TCP to NDOV ZMQ ports (tcp://data.ndovloket.nl:7658, 7817, 7827). No inbound except SSH from admin IP. |
| A6 | Install Node.js + zeromq on EC2 | 15 min | `sudo dnf install nodejs20 && npm install zeromq@6` |
| A7 | Set up systemd service | 30 min | Auto-restart on crash, CloudWatch agent for logs |

### Phase B: ZeroMQ Subscriber (1 day)

| # | Task | Effort | Details |
|---|------|--------|---------|
| B1 | Create `zmq_subscriber/index.js` | 2 hr | Core subscriber process (see scaffolding below) |
| B2 | KV6 XML parser | 1 hr | Parse `<ARRIVAL>`, `<DEPARTURE>`, `<ONSTOP>`, `<INIT>`, `<END>` elements. Extract dataownercode, lineplanningnumber, operatingday, journeynumber, userstopcode, passagesequencenumber, punctuality (seconds). |
| B3 | KV15 XML parser | 1 hr | Parse disruption messages: messagecodedate, messagetype, reasontype, subtype, affected lines/stops, message content (Dutch text) |
| B4 | KV17 XML parser | 30 min | Parse journey cancellations: dataownercode, lineplanningnumber, journeynumber, operatingday, reinforcement/cancellation flag |
| B5 | SQS batch writer | 30 min | Batch KV6 events (up to 10 per SQS SendMessageBatch) to reduce API calls. Flush every 1s or when batch is full. |
| B6 | Health monitoring | 30 min | Heartbeat check (reconnect if no message for 60s), message count metrics to CloudWatch, connection state logging |

### Phase C: Lambda Processors (1 day)

| # | Task | Effort | Details |
|---|------|--------|---------|
| C1 | Create `lambda/process_kv6.js` | 2 hr | SQS trigger. Updates DynamoDB `trip_state` table. Per-trip state: last stop, punctuality, timestamp, next expected stop. |
| C2 | Create `lambda/process_kv15.js` | 1 hr | SQS trigger. Writes disruptions to DynamoDB. Deduplicates by messageId. |
| C3 | Create `lambda/process_kv17.js` | 30 min | SQS trigger. Flags cancelled trips in trip_state. |
| C4 | Modify `ingest_vehicles.js` | 2 hr | Read DynamoDB trip_state for each vehicle. When KV6 data is fresh, dead-reckon from last stop along route shape instead of using raw GPS. |
| C5 | Create `GET /api/disruptions` endpoint | 1 hr | New Lambda handler. Read active disruptions from DynamoDB, filter by line/area. |
| C6 | Update `http_departures.js` | 1 hr | Include disruption data for affected lines. Flag cancelled trips. |

### Phase D: Frontend (0.5 day)

| # | Task | Effort | Details |
|---|------|--------|---------|
| D1 | Disruption banners | 2 hr | Show active disruptions affecting visible stops/lines in DepartureBoard |
| D2 | Cancelled trip display | 1 hr | Strikethrough cancelled departures, "(cancelled)" label |
| D3 | Confidence improvement | 30 min | Vehicles with KV6 anchor show higher confidence than GPS-only vehicles |

### Phase E: Testing & Monitoring (0.5 day)

| # | Task | Effort | Details |
|---|------|--------|---------|
| E1 | Compare KV6 vs GTFS-RT | 2 hr | Run both data sources in parallel, log position differences, verify consistency |
| E2 | Failover testing | 1 hr | Kill ZMQ subscriber, verify GTFS-RT fallback activates within 60s |
| E3 | CloudWatch alarms | 30 min | Alarm on: ZMQ subscriber down > 5 min, SQS queue depth > 10K, KV6 processing lag > 30s |

---

## 4. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          NDOV ZeroMQ Feeds                              │
│                                                                         │
│   KV6posinfo (vehicle events)      ~30 msg/sec                         │
│   KV15messages (disruptions)       ~50-200 msg/day                     │
│   KV17cvlinfo (cancellations)      ~100-500 msg/day                    │
└────────────┬───────────────────────────────────────────────────────────┘
             │ ZeroMQ PUB/SUB (persistent TCP, gzip XML)
             ▼
┌────────────────────────────┐
│ EC2 t4g.nano               │
│ zmq_subscriber/index.js    │
│                             │
│ - Decompress gzip           │
│ - Parse XML                 │
│ - Batch to SQS              │
│ - Health monitoring         │
└────────────┬───────────────┘
             │ SQS (3 queues)
             ▼
┌────────────────────────────────────────────────────┐
│ Lambda Processors                                   │
│                                                     │
│ process_kv6.js:                                     │
│   KV6 event → DynamoDB trip_state                  │
│   {                                                 │
│     tripId: "GVB:901:123",                         │
│     lastStop: { code: "30003560", time: 1711020600,│
│                 punctuality: -30 },                 │
│     nextStop: { code: "30003570",                  │
│                 scheduledArrival: 1711020720 },     │
│     status: "DEPARTURE",                           │
│     updatedAt: 1711020601                          │
│   }                                                 │
│                                                     │
│ process_kv15.js:                                    │
│   Disruption → DynamoDB disruptions                │
│   { messageId, affectedLines[], text, validUntil } │
│                                                     │
│ process_kv17.js:                                    │
│   Cancellation → Update trip_state (cancelled flag)│
└────────────────────┬───────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────┐
│ ingest_vehicles.js (existing, enhanced)             │
│                                                     │
│ For each GTFS-RT vehicle:                           │
│   1. Look up trip_state in DynamoDB                │
│   2. If fresh KV6 data (< 60s):                   │
│      → Dead-reckon from lastStop along route shape │
│      → Set confidence = "live"                     │
│   3. If no KV6 data:                               │
│      → Use GTFS-RT GPS position (current approach) │
│      → Set confidence = "estimated"                │
│   4. Write to S3 tiles (same as today)             │
│                                                     │
│ Also: include disruption flags in tile data         │
└────────────────────┬───────────────────────────────┘
                     │
                     ▼
              [S3 vehicle tiles]
                     │
              [CloudFront edge]
                     │
                 [Browser]
```

---

## 5. Cost Estimate

### Infrastructure

| Component | Specification | Monthly cost |
|-----------|--------------|-------------|
| EC2 t4g.nano | 2 vCPU, 0.5 GB RAM, always-on | $3.07 |
| EBS gp3 volume | 8 GB (OS + Node.js + logs) | $0.64 |
| SQS queues (3) | ~2.6M messages/day KV6, ~1K/day KV15+KV17 | $1.04 |
| DynamoDB trip_state | ~4K items, ~30 writes/sec (KV6 events), on-demand | $1.20 |
| DynamoDB disruptions | ~200 items, ~10 writes/day, on-demand | $0.01 |
| Lambda process_kv6 | ~2.6M invocations/day, 128MB, 50ms avg | $0.80 |
| Lambda process_kv15 | ~200 invocations/day | $0.001 |
| Lambda process_kv17 | ~500 invocations/day | $0.001 |
| CloudWatch Logs | ~50MB/day | $0.25 |
| **Total** | | **~$7/month** |

### Comparison with alternatives

| Approach | Monthly cost | Latency | Coverage |
|----------|-------------|---------|----------|
| OVapi GTFS-RT (current) | $0 (Lambda reuse) | 3-10s | ~4K vehicles, no disruptions |
| NDOV ZeroMQ on EC2 | ~$7 | <1s | All operators, disruptions, cancellations |
| NDOV ZeroMQ on ECS Fargate | ~$12 | <1s | Same, but managed containers |

---

## 6. Dependencies

| Dependency | Status | Lead time |
|------------|--------|-----------|
| NDOV API key | Required | 1-2 business days (register at data.ndovloket.nl) |
| EC2 instance | Required | Immediate (Terraform provision) |
| `zeromq` npm package | Required | v6.x supports Node.js 20, arm64 |
| Server-side dead reckoning | Recommended | See `SERVER_DEAD_RECKONING.md` — needed to display KV6 stop events as map positions |
| Route shapes in DynamoDB/S3 | Required | Already available via trip index (`trips/*.json`) |
| KV7 stop code mapping | Required | Already available (KV6 `userstopcode` = KV7 TPC) |

---

## 7. KV6 XML Message Format (Reference)

### Sample KV6 DEPARTURE event

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VV_TM_PUSH xmlns="http://bison.connekt.nl/tmi8/kv6/msg">
  <KV6posinfo>
    <DEPARTURE>
      <dataownercode>GVB</dataownercode>
      <lineplanningnumber>901</lineplanningnumber>
      <operatingday>2026-03-21</operatingday>
      <journeynumber>123</journeynumber>
      <reinforcementnumber>0</reinforcementnumber>
      <userstopcode>30003560</userstopcode>
      <passagesequencenumber>1</passagesequencenumber>
      <timestamp>2026-03-21T14:30:01+01:00</timestamp>
      <vehiclenumber>2045</vehiclenumber>
      <punctuality>-30</punctuality>
      <rd-x>121456</rd-x>
      <rd-y>487234</rd-y>
    </DEPARTURE>
  </KV6posinfo>
</VV_TM_PUSH>
```

### Field notes

- `punctuality`: seconds early (negative) or late (positive). `-30` = 30 seconds early.
- `rd-x` / `rd-y`: Rijksdriehoek (EPSG:28992) coordinates. Must convert to WGS84 (lat/lon).
- `userstopcode`: Same as the KV7 TimingPointCode (TPC) — matches what OVapi uses.
- `journeynumber`: Matches the journey number in the KV7 trip index.
- `dataownercode`: Operator code (GVB, CXX, QBUZZ, RET, etc).

### Rijksdriehoek to WGS84 conversion

```javascript
// Approximate conversion (accurate to ~1m within Netherlands)
function rdToWgs84(x, y) {
  const dX = (x - 155000) * 1e-5;
  const dY = (y - 463000) * 1e-5;

  const lat = 52.15517440 +
    dY * 0.36720631 + dX * 0.01505027 +
    dY * dY * -0.00044270 + dX * dY * -0.00213783;

  const lon = 5.38720621 +
    dX * 0.55266794 + dY * 0.00117680 +
    dX * dX * -0.03674625 + dX * dY * 0.00227666;

  return { lat, lon };
}
```

---

## 8. Scaffolding: ZeroMQ Subscriber

File: `infra/zmq_subscriber/index.js`

```javascript
'use strict';

// NDOV ZeroMQ subscriber — runs on EC2 t4g.nano
// Connects to NDOV PUB sockets, receives KV6/KV15/KV17 messages,
// parses XML, writes to SQS for Lambda processing.

const zmq = require('zeromq');
const zlib = require('zlib');
const { promisify } = require('util');
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');

const gunzip = promisify(zlib.gunzip);
const sqs = new SQSClient({ region: 'eu-west-1' });

// NDOV ZeroMQ endpoints (replace with actual after registration)
const FEEDS = {
  kv6: {
    endpoint: 'tcp://pubsub.ndovloket.nl:7658',
    envelope: '/RIG/KV6posinfo',
    sqsQueue: process.env.SQS_KV6_URL,
  },
  kv15: {
    endpoint: 'tcp://pubsub.ndovloket.nl:7817',
    envelope: '/RIG/KV15messages',
    sqsQueue: process.env.SQS_KV15_URL,
  },
  kv17: {
    endpoint: 'tcp://pubsub.ndovloket.nl:7827',
    envelope: '/RIG/KV17cvlinfo',
    sqsQueue: process.env.SQS_KV17_URL,
  },
};

// ── KV6 XML Parsing ──────────────────────────────────────────────────

const KV6_EVENTS = ['INIT', 'ARRIVAL', 'ONSTOP', 'DEPARTURE', 'END'];

function parseKv6Xml(xml) {
  // TODO: Use fast-xml-parser or sax for production.
  // This is a simplified regex-based parser for scaffolding.
  const events = [];
  for (const eventType of KV6_EVENTS) {
    const regex = new RegExp(`<${eventType}>([\\s\\S]*?)</${eventType}>`, 'g');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const block = match[1];
      const extract = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return m ? m[1] : null;
      };
      events.push({
        type: eventType,
        operator: extract('dataownercode'),
        line: extract('lineplanningnumber'),
        operatingDay: extract('operatingday'),
        journey: extract('journeynumber'),
        stopCode: extract('userstopcode'),
        sequence: extract('passagesequencenumber'),
        timestamp: extract('timestamp'),
        vehicle: extract('vehiclenumber'),
        punctuality: parseInt(extract('punctuality') || '0'),
        rdX: parseInt(extract('rd-x') || '0'),
        rdY: parseInt(extract('rd-y') || '0'),
      });
    }
  }
  return events;
}

// ── SQS Batch Writer ─────────────────────────────────────────────────

class SqsBatcher {
  constructor(queueUrl, flushIntervalMs = 1000) {
    this.queueUrl = queueUrl;
    this.batch = [];
    this.flushInterval = setInterval(() => this.flush(), flushIntervalMs);
    this.messagesSent = 0;
  }

  add(message) {
    this.batch.push(message);
    if (this.batch.length >= 10) this.flush();
  }

  async flush() {
    if (this.batch.length === 0) return;
    const entries = this.batch.splice(0, 10).map((msg, i) => ({
      Id: `${Date.now()}_${i}`,
      MessageBody: JSON.stringify(msg),
    }));
    try {
      await sqs.send(new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: entries,
      }));
      this.messagesSent += entries.length;
    } catch (e) {
      console.error(`[sqs] Batch send failed: ${e.message}`);
    }
  }

  stop() {
    clearInterval(this.flushInterval);
    return this.flush();
  }
}

// ── ZeroMQ Subscriber ────────────────────────────────────────────────

async function subscribe(feedName, feed, batcher) {
  const sock = new zmq.Subscriber();

  sock.connect(feed.endpoint);
  sock.subscribe(feed.envelope);
  console.log(`[${feedName}] Connected to ${feed.endpoint}, subscribed to ${feed.envelope}`);

  let lastMessageAt = Date.now();
  let messageCount = 0;

  // Heartbeat check — reconnect if no message for 60s
  const heartbeat = setInterval(() => {
    const silenceSec = (Date.now() - lastMessageAt) / 1000;
    if (silenceSec > 60) {
      console.warn(`[${feedName}] No message for ${silenceSec.toFixed(0)}s — reconnecting`);
      sock.disconnect(feed.endpoint);
      sock.connect(feed.endpoint);
      sock.subscribe(feed.envelope);
      lastMessageAt = Date.now();
    }
    // Log throughput every 60s
    console.log(`[${feedName}] ${messageCount} messages in last 60s, total sent to SQS: ${batcher.messagesSent}`);
    messageCount = 0;
  }, 60000);

  try {
    for await (const [envelope, body] of sock) {
      lastMessageAt = Date.now();
      messageCount++;

      try {
        // NDOV messages are gzip-compressed XML
        const xml = (await gunzip(body)).toString('utf8');

        if (feedName === 'kv6') {
          const events = parseKv6Xml(xml);
          for (const event of events) {
            batcher.add(event);
          }
        } else {
          // KV15/KV17: send raw XML to SQS for Lambda to parse
          // (lower volume, more complex structure)
          batcher.add({ raw: xml, receivedAt: Date.now() });
        }
      } catch (e) {
        console.warn(`[${feedName}] Parse error: ${e.message}`);
      }
    }
  } finally {
    clearInterval(heartbeat);
    sock.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('[ndov] Starting NDOV ZeroMQ subscriber');

  const batchers = {};
  const subscriptions = [];

  for (const [name, feed] of Object.entries(FEEDS)) {
    if (!feed.sqsQueue) {
      console.warn(`[${name}] No SQS queue URL configured, skipping`);
      continue;
    }
    batchers[name] = new SqsBatcher(feed.sqsQueue);
    subscriptions.push(subscribe(name, feed, batchers[name]));
  }

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[ndov] Received SIGTERM, flushing batchers...');
    await Promise.all(Object.values(batchers).map(b => b.stop()));
    process.exit(0);
  });

  await Promise.all(subscriptions);
}

main().catch(e => {
  console.error('[ndov] Fatal error:', e);
  process.exit(1);
});
```

---

## 9. Scaffolding: KV6 Processor Lambda

File: `lambda/process_kv6.js`

```javascript
'use strict';

// SQS-triggered Lambda: processes KV6 vehicle events from NDOV.
// Updates per-trip state in DynamoDB for dead reckoning.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TRIP_STATE_TABLE;

// Rijksdriehoek (EPSG:28992) → WGS84 approximate conversion
function rdToWgs84(x, y) {
  if (!x || !y) return null;
  const dX = (x - 155000) * 1e-5;
  const dY = (y - 463000) * 1e-5;
  const lat = 52.15517440 + dY * 0.36720631 + dX * 0.01505027 +
    dY * dY * -0.00044270 + dX * dY * -0.00213783;
  const lon = 5.38720621 + dX * 0.55266794 + dY * 0.00117680 +
    dX * dX * -0.03674625 + dX * dY * 0.00227666;
  return { lat, lon };
}

exports.handler = async (event) => {
  const writes = [];

  for (const record of event.Records) {
    const kv6 = JSON.parse(record.body);
    const tripId = `${kv6.operator}:${kv6.line}:${kv6.journey}`;

    const position = rdToWgs84(kv6.rdX, kv6.rdY);

    const item = {
      tripId,
      eventType: kv6.type,                    // INIT, ARRIVAL, DEPARTURE, ONSTOP, END
      operator: kv6.operator,
      line: kv6.line,
      journey: kv6.journey,
      operatingDay: kv6.operatingDay,
      lastStopCode: kv6.stopCode || null,
      punctuality: kv6.punctuality || 0,       // seconds: negative = early, positive = late
      vehicleNumber: kv6.vehicle || null,
      timestamp: kv6.timestamp,
      updatedAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 7200, // TTL: 2 hours
    };

    if (position) {
      item.lat = position.lat;
      item.lon = position.lon;
    }

    writes.push(
      ddb.send(new PutCommand({ TableName: TABLE, Item: item }))
        .catch(e => console.warn(`[kv6] Write failed for ${tripId}:`, e.message))
    );
  }

  await Promise.all(writes);
  return { processed: event.Records.length };
};
```

---

## 10. Rollout Plan

| Stage | Duration | What happens |
|-------|----------|-------------|
| **Stage 1: Shadow mode** | 1 week | ZMQ subscriber runs, writes to SQS/DynamoDB. `ingest_vehicles` does NOT read from DynamoDB yet. Compare KV6 events with GTFS-RT positions to validate correctness. |
| **Stage 2: Hybrid mode** | 1 week | `ingest_vehicles` reads DynamoDB trip_state. When KV6 data is fresh, use it for confidence/delay info but still use GTFS-RT GPS for position. Log when KV6 and GTFS-RT disagree. |
| **Stage 3: KV6-primary** | Ongoing | For vehicles with fresh KV6 data, dead-reckon from last stop event. Use GTFS-RT GPS only for vehicles without KV6 data. KV15 disruptions shown in frontend. |
| **Stage 4: OVapi removal** | After 1 month stable | Reduce OVapi polling to every 30s (failsafe only). Primary data source is NDOV for all operators. |

---

## 11. Open Questions

1. **NDOV ZMQ port numbers**: The ports listed above (7658, 7817, 7827) are based on public documentation. Confirm exact endpoints after registration.
2. **KV6 volume during peak hours**: Estimated ~30 msg/sec average. Peak (morning rush in Randstad) may reach 60-80 msg/sec. The EC2 t4g.nano (0.5 GB RAM) should handle this but needs monitoring.
3. **SQS batching granularity**: Batching 10 KV6 events per SQS message reduces cost but adds up to 1s latency. For sub-second display, consider batching by time window (200ms) instead of count.
4. **DynamoDB cost at scale**: At ~30 writes/sec sustained (KV6 events), on-demand pricing is ~$1.20/month. If this grows, consider provisioned capacity at $0.65/month (5 WCU).
