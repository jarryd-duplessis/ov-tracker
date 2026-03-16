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
  const res = await fetch(url, { headers: { 'User-Agent': 'KomtIe/1.0 (live-ov-tracker)' } });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Location not found: "${query}"`);
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    name: data[0].display_name.split(',').slice(0, 2).join(',').trim(),
  };
}

exports.handler = async (event) => {
  const { from, to } = event.queryStringParameters || {};
  if (!from || !to) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'from and to are required' }) };
  }

  try {
    const [fromGeo, toGeo] = await Promise.all([geocode(from), geocode(to)]);
    const motisUrl = `https://europe.motis-project.de/api/v1/plan?fromPlace=${fromGeo.lat},${fromGeo.lon}&toPlace=${toGeo.lat},${toGeo.lon}&numItineraries=3`;
    const motisRes = await fetch(motisUrl, { headers: { 'User-Agent': 'KomtIe/1.0' } });
    if (!motisRes.ok) throw new Error(`Journey planner unavailable: ${motisRes.status}`);
    const motisData = await motisRes.json();
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ from: fromGeo, to: toGeo, itineraries: motisData.itineraries || [] }),
    };
  } catch (e) {
    console.error('Journey error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
