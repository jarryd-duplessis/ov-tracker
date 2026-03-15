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
  const isRealtime = !!RealtimeArrival;

  // Calculate minutes until arrival
  const now = new Date();
  const arrival = new Date(expectedTime);
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
        if (dep.minutesUntil >= -2) {
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
