'use strict';

const OVAPI_BASE = 'http://v0.ovapi.nl';
const HEADERS = {
  'User-Agent': 'KomtIe/1.0 (live-ov-tracker)',
  'Accept-Encoding': 'gzip'
};

async function getDeparturesMulti(timingPointCodes) {
  const joined = timingPointCodes.join(',');
  const url = `${OVAPI_BASE}/tpc/${joined}`;
  const res = await fetch(url, { headers: HEADERS });
  // 404 means OVapi doesn't know any of these TPC codes (e.g. openov-nl stop IDs) — treat as no data
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`OVapi error: ${res.status}`);
  return res.json();
}

// OVapi returns times as 'YYYY-MM-DDTHH:MM:SS' in Dutch local time (no timezone suffix).
function parseAmsterdamTime(timeStr) {
  if (!timeStr) return null;
  if (/Z|[+-]\d{2}:\d{2}$/.test(timeStr)) return new Date(timeStr);
  const approx = new Date(timeStr + 'Z');
  const yr = approx.getUTCFullYear();
  const lastSunMar = new Date(Date.UTC(yr, 2, 31));
  lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
  const lastSunOct = new Date(Date.UTC(yr, 9, 31));
  lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());
  const offset = (approx >= lastSunMar && approx < lastSunOct) ? '+02:00' : '+01:00';
  return new Date(timeStr + offset);
}

function parsePasstime(passtime, stopCode) {
  const {
    LinePublicNumber, DestinationName50,
    ExpectedArrivalTime, TargetArrivalTime,
    RealtimeArrival, JourneyNumber, TransportType, OperatorCode,
    ExpectedDepartureTime, TargetDepartureTime,
    TripStopStatus,
  } = passtime;

  const expectedTime = ExpectedArrivalTime || TargetArrivalTime;
  if (!expectedTime) return null;

  const arrival = parseAmsterdamTime(expectedTime);
  if (!arrival || isNaN(arrival.getTime())) return null;

  const minutesUntil = Math.round((arrival - new Date()) / 60000);
  const isRealtime = !!RealtimeArrival;

  // Use departure time for minutesUntil (more relevant for passengers waiting)
  const depTime = ExpectedDepartureTime || TargetDepartureTime;
  const departure = depTime ? parseAmsterdamTime(depTime) : null;
  const scheduledDep = TargetDepartureTime ? parseAmsterdamTime(TargetDepartureTime) : null;
  const minutesUntilDep = departure ? Math.round((departure - new Date()) / 60000) : minutesUntil;

  // Compute delay: difference between expected and scheduled departure
  let delay = 0;
  if (departure && scheduledDep) {
    delay = Math.round((departure - scheduledDep) / 60000);
  }

  // Vehicle status from KV6 events
  // DRIVING = en route to this stop, ARRIVED = at the stop, DEPARTED = left,
  // PLANNED = no real-time data yet, UNKNOWN = no recent updates
  const status = TripStopStatus || 'UNKNOWN';
  const hasRealtimeData = status === 'DRIVING' || status === 'ARRIVED' || status === 'DEPARTED';

  return {
    stopCode, line: LinePublicNumber, destination: DestinationName50,
    expectedTime, scheduledTime: TargetArrivalTime, minutesUntil: minutesUntilDep,
    isRealtime: isRealtime || hasRealtimeData,
    journeyNumber: JourneyNumber, transportType: TransportType,
    operator: OperatorCode,
    confidence: hasRealtimeData ? 'live' : isRealtime ? 'live' : 'scheduled',
    delay, // minutes: 0 = on time, >0 = late, <0 = early
    status, // DRIVING, ARRIVED, DEPARTED, PLANNED, UNKNOWN
  };
}

function parseTpcResponse(data) {
  const departures = [];
  for (const [tpc, tpcData] of Object.entries(data)) {
    if (!tpcData.Passes) continue;
    for (const [, passtime] of Object.entries(tpcData.Passes)) {
      if (!['BUS', 'TRAM', 'METRO'].includes(passtime.TransportType)) continue;
      try {
        const dep = parsePasstime(passtime, tpc);
        if (dep && dep.minutesUntil >= -2) departures.push(dep);
      } catch (e) { console.warn('[ovapi] Failed to parse passtime:', e.message); }
    }
  }
  return departures.sort((a, b) => a.minutesUntil - b.minutesUntil);
}

module.exports = { getDeparturesMulti, parseTpcResponse };
