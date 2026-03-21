'use strict';

// Unit tests for stop search scoring
// Usage: node qa/test_stops.js
//
// Tests the scoring/ranking logic used by searchStopsByName.
// Since the actual function requires S3, we test the scoring logic directly.

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  OK  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}`);
    fail++;
  }
}

// ── Replicate the scoring logic from lib/stops.js ────────────────────────

function scoreStops(stops, query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results = stops.filter(s => s.name.toLowerCase().includes(q));
  const words = q.split(/[\s,]+/);

  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aPart = aName.split(',').pop().trim();
    const bPart = bName.split(',').pop().trim();
    const aExact = aPart === q ? 0 : aPart.startsWith(q) ? 1 : 2;
    const bExact = bPart === q ? 0 : bPart.startsWith(q) ? 1 : 2;
    if (aExact !== bExact) return aExact - bExact;
    const aAllWords = words.every(w => aName.includes(w)) ? 0 : 1;
    const bAllWords = words.every(w => bName.includes(w)) ? 0 : 1;
    if (aAllWords !== bAllWords) return aAllWords - bAllWords;
    return aName.length - bName.length;
  });

  return results;
}

// ── Test data ────────────────────────────────────────────────────────────

const mockStops = [
  { id: '1', name: 'Amsterdam, Centraal', lat: 52.379, lon: 4.900 },
  { id: '2', name: 'Amsterdam, Centraal Station', lat: 52.379, lon: 4.901 },
  { id: '3', name: 'Amsterdam, Dam', lat: 52.373, lon: 4.893 },
  { id: '4', name: 'Utrecht, Centraal', lat: 52.089, lon: 5.110 },
  { id: '5', name: 'Rotterdam, Centraal', lat: 51.924, lon: 4.469 },
  { id: '6', name: 'Amsterdam, Amstelstation', lat: 52.347, lon: 4.918 },
  { id: '7', name: 'Den Haag, Centraal', lat: 52.080, lon: 4.324 },
  { id: '8', name: 'Amsterdam, Muiderpoort', lat: 52.361, lon: 4.940 },
  { id: '9', name: 'Haarlem, Centraal', lat: 52.388, lon: 4.639 },
  { id: '10', name: 'Amsterdam, Bijlmer ArenA', lat: 52.312, lon: 4.948 },
];

// ── Test 1: Exact part match ranks highest ───────────────────────────────

console.log('-- Stop search scoring --');

const centraalResults = scoreStops(mockStops, 'centraal');
check('Search "centraal" returns all centraal stops', centraalResults.length === 6);
check('Exact part match "Centraal" ranks first', centraalResults[0]?.name.endsWith('Centraal'));

// ── Test 2: Shorter names preferred ──────────────────────────────────────

const amsCentraal = scoreStops(mockStops, 'centraal').filter(s => s.name.startsWith('Amsterdam'));
check('Amsterdam Centraal (shorter) before Amsterdam Centraal Station',
  amsCentraal.length >= 2 && amsCentraal[0].name === 'Amsterdam, Centraal');

// ── Test 3: Prefix match ranks above substring ──────────────────────────

const damResults = scoreStops(mockStops, 'dam');
check('Search "dam" returns Dam and Amsterdam stops', damResults.length > 1);
check('"Dam" (exact part match) ranks above "Amsterdam..." (substring)',
  damResults[0]?.name === 'Amsterdam, Dam');

// ── Test 4: Substring match with comma ──────────────────────────────────

const commaResults = scoreStops(mockStops, 'amsterdam, centraal');
check('"amsterdam, centraal" finds exact substring match', commaResults.length >= 1);
check('Finds "Amsterdam, Centraal"',
  commaResults.some(s => s.name === 'Amsterdam, Centraal'));

// ── Test 5: No results for non-existent stop ────────────────────────────

const noResults = scoreStops(mockStops, 'schiphol');
check('Search for non-existent stop returns empty', noResults.length === 0);

// ── Test 6: Empty query ─────────────────────────────────────────────────

const emptyResults = scoreStops(mockStops, '');
check('Empty query returns empty array', emptyResults.length === 0);

// ── Test 7: Case insensitive ─────────────────────────────────────────────

const caseResults = scoreStops(mockStops, 'CENTRAAL');
check('Case insensitive search works', caseResults.length === 6);

// ── Test 8: Partial match ────────────────────────────────────────────────

const partialResults = scoreStops(mockStops, 'muider');
check('Partial match "muider" finds Muiderpoort',
  partialResults.length === 1 && partialResults[0].name.includes('Muiderpoort'));

// ── Summary ──────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
