'use strict';

// Unit tests for OVapi departure parser
// Usage: node qa/test_departures.js

const { parseTpcResponse } = require('../lambda/lib/ovapi');

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

// ── Test 1: Empty input ──────────────────────────────────────────────────

console.log('-- parseTpcResponse --');

const empty = parseTpcResponse({});
check('Empty input returns empty array', Array.isArray(empty) && empty.length === 0);

// ── Test 2: Valid BUS departure ──────────────────────────────────────────

// OVapi returns times in Amsterdam local time (CET/CEST, no timezone suffix).
// parseAmsterdamTime adds the appropriate offset. To produce correct mock data,
// we need to format times as Amsterdam local times.
const now = new Date();
// Amsterdam offset: CET (+1) or CEST (+2). Determine from the date.
const yr = now.getUTCFullYear();
const lastSunMar = new Date(Date.UTC(yr, 2, 31));
lastSunMar.setUTCDate(31 - lastSunMar.getUTCDay());
const lastSunOct = new Date(Date.UTC(yr, 9, 31));
lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());
const isCEST = now >= lastSunMar && now < lastSunOct;
const amsOffsetMs = (isCEST ? 2 : 1) * 3600000;

// Format a Date as Amsterdam local time string (no timezone suffix)
const fmt = (d) => {
  const local = new Date(d.getTime() + amsOffsetMs);
  return local.toISOString().replace('Z', '').split('.')[0];
};

const inFive = new Date(now.getTime() + 5 * 60000);
const scheduled = new Date(now.getTime() + 3 * 60000);

const mockData = {
  '50002290': {
    Passes: {
      'pass1': {
        LinePublicNumber: '22',
        DestinationName50: 'Sloterdijk',
        ExpectedArrivalTime: fmt(inFive),
        TargetArrivalTime: fmt(inFive),
        ExpectedDepartureTime: fmt(inFive),
        TargetDepartureTime: fmt(scheduled),
        JourneyNumber: 1234,
        TransportType: 'BUS',
        OperatorCode: 'GVB',
        TripStopStatus: 'DRIVING',
      },
    },
  },
};

const result = parseTpcResponse(mockData);
check('Parses one BUS departure', result.length === 1);
check('Line number is 22', result[0]?.line === '22');
check('Destination is Sloterdijk', result[0]?.destination === 'Sloterdijk');
check('Status is DRIVING', result[0]?.status === 'DRIVING');
check('Confidence is live for DRIVING status', result[0]?.confidence === 'live');
check('Delay is approximately +2 min', result[0]?.delay === 2);
check('Has stopCode', result[0]?.stopCode === '50002290');
check('Has operator', result[0]?.operator === 'GVB');

// ── Test 3: Filters non-BUS/TRAM/METRO ──────────────────────────────────

const trainData = {
  '50002290': {
    Passes: {
      'pass1': {
        LinePublicNumber: 'IC',
        DestinationName50: 'Rotterdam',
        ExpectedArrivalTime: fmt(inFive),
        TargetArrivalTime: fmt(inFive),
        JourneyNumber: 5678,
        TransportType: 'TRAIN',
        OperatorCode: 'NS',
        TripStopStatus: 'PLANNED',
      },
    },
  },
};

const trainResult = parseTpcResponse(trainData);
check('Filters out TRAIN transport type', trainResult.length === 0);

// ── Test 4: Filters past departures ──────────────────────────────────────

const pastTime = new Date(now.getTime() - 5 * 60000);
const pastData = {
  '50002290': {
    Passes: {
      'pass1': {
        LinePublicNumber: '5',
        DestinationName50: 'Amstelveen',
        ExpectedArrivalTime: fmt(pastTime),
        TargetArrivalTime: fmt(pastTime),
        ExpectedDepartureTime: fmt(pastTime),
        TargetDepartureTime: fmt(pastTime),
        JourneyNumber: 9999,
        TransportType: 'TRAM',
        OperatorCode: 'GVB',
        TripStopStatus: 'DEPARTED',
      },
    },
  },
};

const pastResult = parseTpcResponse(pastData);
check('Filters out departures > 2 min in the past', pastResult.length === 0);

// ── Test 5: Multiple stops, sorted by time ───────────────────────────────

const inTwo = new Date(now.getTime() + 2 * 60000);
const inTen = new Date(now.getTime() + 10 * 60000);

const multiData = {
  '50002290': {
    Passes: {
      'later': {
        LinePublicNumber: '48',
        DestinationName50: 'Borneo-eiland',
        ExpectedArrivalTime: fmt(inTen),
        TargetArrivalTime: fmt(inTen),
        ExpectedDepartureTime: fmt(inTen),
        TargetDepartureTime: fmt(inTen),
        JourneyNumber: 2000,
        TransportType: 'BUS',
        OperatorCode: 'GVB',
        TripStopStatus: 'PLANNED',
      },
      'sooner': {
        LinePublicNumber: '22',
        DestinationName50: 'Sloterdijk',
        ExpectedArrivalTime: fmt(inTwo),
        TargetArrivalTime: fmt(inTwo),
        ExpectedDepartureTime: fmt(inTwo),
        TargetDepartureTime: fmt(inTwo),
        JourneyNumber: 1000,
        TransportType: 'BUS',
        OperatorCode: 'GVB',
        TripStopStatus: 'DRIVING',
      },
    },
  },
};

const multiResult = parseTpcResponse(multiData);
check('Multiple departures parsed', multiResult.length === 2);
check('Sorted by minutesUntil (sooner first)', multiResult[0]?.line === '22' && multiResult[1]?.line === '48');

// ── Test 6: Missing Passes key ───────────────────────────────────────────

const noPasses = { '50002290': {} };
const noPassesResult = parseTpcResponse(noPasses);
check('Handles missing Passes gracefully', noPassesResult.length === 0);

// ── Summary ──────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
