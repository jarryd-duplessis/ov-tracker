const fetch = require('node-fetch');

const OVAPI_BASE = 'http://v0.ovapi.nl';
const HEADERS = {
  'User-Agent': 'KomtIe/1.0 (live-ov-tracker)',
  'Accept-Encoding': 'gzip'
};

// Fetch departures for a single timing point code
async function getDepartures(timingPointCode) {
  const url = `${OVAPI_BASE}/tpc/${timingPointCode}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`OVapi error: ${res.status} for ${timingPointCode}`);
  return res.json();
}

// Fetch departures for multiple timing point codes (comma separated = one request)
async function getDeparturesMulti(timingPointCodes) {
  const joined = timingPointCodes.join(',');
  const url = `${OVAPI_BASE}/tpc/${joined}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`OVapi error: ${res.status}`);
  return res.json();
}

// Fetch all departures for a stop area
async function getStopArea(stopAreaCode) {
  const url = `${OVAPI_BASE}/stopareacode/${stopAreaCode}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`OVapi error: ${res.status}`);
  return res.json();
}

// OVapi returns times as 'YYYY-MM-DDTHH:MM:SS' in Dutch local time (no timezone suffix).
// The server runs UTC, so we must append the Amsterdam offset before parsing.
function parseAmsterdamTime(timeStr) {
  if (!timeStr) return null;
  // Already has timezone info — parse as-is
  if (/Z|[+-]\d{2}:\d{2}$/.test(timeStr)) return new Date(timeStr);
  // Determine CET (+01:00) vs CEST (+02:00): DST starts last Sunday of March,
  // ends last Sunday of October (Europe/Amsterdam rules).
  const approx = new Date(timeStr + 'Z'); // rough UTC stand-in just to get the year
  const yr = approx.getUTCFullYear();
  const lastSunMar = new Date(Date.UTC(yr, 2, 31));
  lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
  const lastSunOct = new Date(Date.UTC(yr, 9, 31));
  lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());
  const offset = (approx >= lastSunMar && approx < lastSunOct) ? '+02:00' : '+01:00';
  return new Date(timeStr + offset);
}

// Parse OVapi passtime into a clean departure object
function parsePasstime(passtime, stopCode) {
  const {
    LinePublicNumber,
    DestinationName50,
    ExpectedArrivalTime,
    TargetArrivalTime,
    RealtimeArrival,
    JourneyNumber,
    TransportType,
    OperatorCode
  } = passtime;

  const expectedTime = ExpectedArrivalTime || TargetArrivalTime;
  if (!expectedTime) return null;

  const isRealtime = !!RealtimeArrival;

  // Calculate minutes until arrival
  const now = new Date();
  const arrival = parseAmsterdamTime(expectedTime);
  if (!arrival || isNaN(arrival.getTime())) return null;
  const minutesUntil = Math.round((arrival - now) / 60000);

  return {
    stopCode,
    line: LinePublicNumber,
    destination: DestinationName50,
    expectedTime,
    scheduledTime: TargetArrivalTime,
    minutesUntil,
    isRealtime,         // true = vehicle is broadcasting live position
    journeyNumber: JourneyNumber,
    transportType: TransportType, // BUS, TRAM, METRO
    operator: OperatorCode,
    confidence: isRealtime ? 'live' : 'scheduled'
  };
}

// Parse full OVapi response for a timing point into an array of departures
function parseTpcResponse(data, stopCode) {
  const departures = [];

  for (const [tpc, tpcData] of Object.entries(data)) {
    if (!tpcData.Passes) continue;
    for (const [journeyKey, passtime] of Object.entries(tpcData.Passes)) {
      // Only include buses and trams
      const type = passtime.TransportType;
      if (!['BUS', 'TRAM', 'METRO'].includes(type)) continue;

      try {
        const dep = parsePasstime(passtime, tpc);
        // Only show upcoming departures (not more than 2 mins in the past)
        if (dep && dep.minutesUntil >= -2) {
          departures.push(dep);
        }
      } catch (e) {
        // Skip malformed passtimes
      }
    }
  }

  return departures.sort((a, b) => a.minutesUntil - b.minutesUntil);
}

module.exports = {
  getDepartures,
  getDeparturesMulti,
  getStopArea,
  parseTpcResponse
};
