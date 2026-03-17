'use strict';

// EventBridge Scheduler (daily at 03:00 UTC) — refreshes the stops cache in S3.
// This Lambda is the only place that downloads the KV7 GTFS zip.
// All other Lambdas read the result from S3.

const { downloadStops, saveToS3, getStops } = require('./lib/stops');
const { buildTripIndex, buildOpenOvTripIndex } = require('./lib/trips');

exports.handler = async () => {
  console.log('Refreshing stops cache...');

  // Load existing cache for safety comparison
  let existing = [];
  try {
    existing = await getStops();
    console.log(`Existing cache: ${existing.length} stops`);
  } catch {}

  let fresh;
  try {
    fresh = await downloadStops();
  } catch (e) {
    console.error('Download failed:', e.message);
    throw e;
  }

  // Safety guard: reject if new dataset is drastically smaller than what we had.
  // Allow new to be up to 40% smaller than existing (first run after merge grows count;
  // KV7-only fallback should still be > existing KV7 baseline).
  if (existing.length > 0 && fresh.length < existing.length * 0.6) {
    console.warn(`Downloaded ${fresh.length} stops but cache has ${existing.length} — keeping existing`);
    return { kept: existing.length, downloaded: fresh.length, action: 'kept_existing' };
  }

  await saveToS3({ timestamp: Date.now(), stops: fresh });
  console.log(`Saved ${fresh.length} stops to S3`);

  // Build trip index from the same KV7 GTFS zip
  try {
    await buildTripIndex();
    console.log('Trip index built successfully');
  } catch (e) {
    console.warn('Trip index build failed (non-fatal):', e.message);
  }

  // Build openov-nl trip index for routes not covered by KV7
  try {
    await buildOpenOvTripIndex();
    console.log('OpenOV trip index built successfully');
  } catch (e) {
    console.warn('OpenOV trip index build failed (non-fatal):', e.message);
  }

  return { saved: fresh.length, action: 'updated' };
};
