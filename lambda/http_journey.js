'use strict';

// GET /journey?from=Amsterdam+Centraal&to=Rotterdam+Centraal
// Geocodes both locations via Nominatim then fetches itineraries from Motis.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=nl&format=json&limit=1`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'KomtIe/1.0 (live-ov-tracker)' } });
    if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error(`Location not found: "${query}"`);
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      name: data[0].display_name.split(',').slice(0, 2).join(',').trim(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async (event) => {
  const { from, to, fromLat, fromLon, time, arriveBy } = event.queryStringParameters || {};
  if ((!from && (!fromLat || !fromLon)) || !to) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'from (or fromLat+fromLon) and to are required' }) };
  }

  try {
    // Use exact coordinates when provided (e.g. tracking a departure from a known stop)
    const [fromGeo, toGeo] = await Promise.all([
      (fromLat && fromLon)
        ? Promise.resolve({ lat: parseFloat(fromLat), lon: parseFloat(fromLon), name: from || 'Boarding stop' })
        : geocode(from),
      geocode(to),
    ]);
    let motisUrl = `https://europe.motis-project.de/api/v1/plan?fromPlace=${fromGeo.lat},${fromGeo.lon}&toPlace=${toGeo.lat},${toGeo.lon}&numItineraries=5&showIntermediateStops=true`;
    if (time) motisUrl += `&time=${encodeURIComponent(time)}`;
    if (arriveBy === 'true') motisUrl += '&arriveBy=true';
    const motisController = new AbortController();
    const motisTimeout = setTimeout(() => motisController.abort(), 10000);
    let motisData;
    try {
      const motisRes = await fetch(motisUrl, { signal: motisController.signal, headers: { 'User-Agent': 'KomtIe/1.0' } });
      if (!motisRes.ok) throw new Error(`Journey planner unavailable: ${motisRes.status}`);
      motisData = await motisRes.json();
    } finally {
      clearTimeout(motisTimeout);
    }
    // Sort itineraries fastest-first so the best option is at the top
    const itineraries = (motisData.itineraries || []).slice();
    itineraries.sort((a, b) => a.duration - b.duration);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ from: fromGeo, to: toGeo, itineraries }),
    };
  } catch (e) {
    console.error('Journey error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
