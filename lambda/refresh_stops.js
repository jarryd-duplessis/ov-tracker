'use strict';

// EventBridge Scheduler (daily at 03:00 UTC) — refreshes the stops cache in S3.
// This Lambda is the only place that downloads the KV7 GTFS zip.
// All other Lambdas read the result from S3.

const { downloadStops, saveToS3, getStops } = require('./lib/stops');

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

  // Safety guard: reject if new file is <80% of existing (likely partial/regional KV7)
  if (existing.length > 0 && fresh.length < existing.length * 0.8) {
    console.warn(`Downloaded ${fresh.length} stops but cache has ${existing.length} — keeping existing`);
    return { kept: existing.length, downloaded: fresh.length, action: 'kept_existing' };
  }

  await saveToS3({ timestamp: Date.now(), stops: fresh });
  console.log(`Saved ${fresh.length} stops to S3`);
  return { saved: fresh.length, action: 'updated' };
};
