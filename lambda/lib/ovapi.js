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
    RealtimeArrival, JourneyNumber, TransportType, OperatorCode
  } = passtime;

  const expectedTime = ExpectedArrivalTime || TargetArrivalTime;
  if (!expectedTime) return null;

  const arrival = parseAmsterdamTime(expectedTime);
  if (!arrival || isNaN(arrival.getTime())) return null;

  const minutesUntil = Math.round((arrival - new Date()) / 60000);
  const isRealtime = !!RealtimeArrival;

  return {
    stopCode, line: LinePublicNumber, destination: DestinationName50,
    expectedTime, scheduledTime: TargetArrivalTime, minutesUntil, isRealtime,
    journeyNumber: JourneyNumber, transportType: TransportType,
    operator: OperatorCode, confidence: isRealtime ? 'live' : 'scheduled'
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
