#!/usr/bin/env bash
# Komt ie? — API smoke tests against live deployment
# Usage: bash qa/test_api.sh [BASE_URL]
#
# Requires: curl, jq

set -euo pipefail

BASE="${1:-https://ov.jarryd.co.za}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"

  if [ "$result" = "$expected" ]; then
    echo "  OK  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name (got: $result, expected: $expected)"
    FAIL=$((FAIL + 1))
  fi
}

check_nonzero() {
  local name="$1"
  local result="$2"

  if [ -n "$result" ] && [ "$result" != "0" ] && [ "$result" != "null" ]; then
    echo "  OK  $name (count: $result)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name (got: $result)"
    FAIL=$((FAIL + 1))
  fi
}

echo "Testing against: $BASE"
echo ""

# ── Stops API ────────────────────────────────────────────────────────────
echo "-- Stops API --"
stops_count=$(curl -sf "${BASE}/api/stops/nearby?lat=52.37&lon=4.89&radius=1" | jq '.stops | length')
check_nonzero "GET /api/stops/nearby returns stops" "$stops_count"

stops_search=$(curl -sf "${BASE}/api/stops/nearby?q=centraal" | jq '.stops | length')
check_nonzero "GET /api/stops/nearby?q=centraal returns results" "$stops_search"

# ── Departures API ───────────────────────────────────────────────────────
echo ""
echo "-- Departures API --"
# Use a well-known Amsterdam stop (Amsterdam Centraal bus)
dep_count=$(curl -sf "${BASE}/api/departures?stops=50002290" | jq '.departures | length')
check_nonzero "GET /api/departures returns departures" "$dep_count"

# ── Vehicles API ─────────────────────────────────────────────────────────
echo ""
echo "-- Vehicles API --"
# Amsterdam viewport
veh_count=$(curl -sf "${BASE}/api/vehicles?bbox=52.3,4.8,52.4,5.0" | jq '.vehicles | length')
check_nonzero "GET /api/vehicles?bbox returns vehicles" "$veh_count"

veh_has_fetchedAt=$(curl -sf "${BASE}/api/vehicles?bbox=52.3,4.8,52.4,5.0" | jq -r '.fetchedAt')
check_nonzero "GET /api/vehicles response has fetchedAt" "$veh_has_fetchedAt"

# Check that vehicles have expected fields
veh_has_fields=$(curl -sf "${BASE}/api/vehicles?bbox=52.3,4.8,52.4,5.0" | jq '[.vehicles[0] | has("id","lat","lon","bearing","speed","line","category","confidence")] | all')
check "GET /api/vehicles vehicles have required fields" "$veh_has_fields" "true"

# ── Trip API ─────────────────────────────────────────────────────────────
echo ""
echo "-- Trip API --"
# Trip with invalid ID should return an error
trip_err=$(curl -sf "${BASE}/api/trip?vehicleId=test&line=1" | jq -r '.error')
check_nonzero "GET /api/trip with bad ID returns error" "$trip_err"

# Trip without vehicleId should return 400
trip_status=$(curl -sf -o /dev/null -w "%{http_code}" "${BASE}/api/trip")
check "GET /api/trip without params returns 400" "$trip_status" "400"

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

exit $FAIL
