'use strict';

// GET /api/vehicles — all vehicles (legacy, falls back to direct fetch)
// GET /api/vehicles?bbox=south,west,north,east — viewport-filtered from tiles
// GET /api/vehicles/{id} — single vehicle by entity ID

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getVehiclePositions } = require('./lib/vehicles');

const s3 = new S3Client({});
const BUCKET = process.env.CACHE_BUCKET;

const TILE_LAT_SIZE = 0.1;
const TILE_LON_SIZE = 0.15;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Read a tile from S3 (returns null if not found)
async function readTile(tileKey) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `tiles/${tileKey}.json` }));
    return JSON.parse(await obj.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;
    throw e;
  }
}

// Read tile manifest to know which tiles exist
// No in-memory manifest cache — always read fresh from S3.
// CloudFront (3s) provides the caching layer.
async function getManifest() {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'tiles/manifest.json' }));
    return JSON.parse(await obj.Body.transformToString());
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    // Single vehicle by ID: GET /api/vehicles/{id}
    const vehicleId = event.pathParameters?.id;
    if (vehicleId) {
      // Search tiles for this vehicle (fall back to full feed)
      const decoded = decodeURIComponent(vehicleId);
      const { vehicles, fetchedAt } = await getVehiclePositions();
      const vehicle = vehicles.find(v => v.id === decoded);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=3' },
        body: JSON.stringify({ vehicle: vehicle || null, fetchedAt: new Date(fetchedAt).toISOString() }),
      };
    }

    // Viewport filter: GET /api/vehicles?bbox=south,west,north,east
    const { bbox } = event.queryStringParameters || {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        const [south, west, north, east] = parts;

        // Try tile-based serving first
        const manifest = await getManifest();
        if (manifest?.tiles) {
          // Find which tiles overlap the viewport
          const minLatBucket = Math.floor(south / TILE_LAT_SIZE);
          const maxLatBucket = Math.floor(north / TILE_LAT_SIZE);
          const minLonBucket = Math.floor(west / TILE_LON_SIZE);
          const maxLonBucket = Math.floor(east / TILE_LON_SIZE);

          const tilePromises = [];
          for (let latB = minLatBucket; latB <= maxLatBucket; latB++) {
            for (let lonB = minLonBucket; lonB <= maxLonBucket; lonB++) {
              const tk = `${latB}_${lonB}`;
              if (manifest.tiles[tk]) {
                tilePromises.push(readTile(tk));
              }
            }
          }

          const tileResults = await Promise.all(tilePromises);
          const vehicles = [];
          for (const tile of tileResults) {
            if (tile?.vehicles) {
              for (const v of tile.vehicles) {
                // Double-check bbox (tile boundaries are coarser than viewport)
                if (v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east) {
                  vehicles.push(v);
                }
              }
            }
          }

          return {
            statusCode: 200,
            headers: { ...CORS, 'Cache-Control': 'public, max-age=3' },
            body: JSON.stringify({ vehicles, fetchedAt: manifest.fetchedAt }),
          };
        }

        // Fallback: direct fetch + filter (tiles not ready yet)
        const { vehicles: allVehicles, fetchedAt } = await getVehiclePositions();
        const filtered = allVehicles.filter(v =>
          v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east
        );
        return {
          statusCode: 200,
          headers: { ...CORS, 'Cache-Control': 'public, max-age=3' },
          body: JSON.stringify({ vehicles: filtered, fetchedAt: new Date(fetchedAt).toISOString() }),
        };
      }
    }

    // No bbox: return all (legacy)
    const { vehicles, fetchedAt } = await getVehiclePositions();
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=3' },
      body: JSON.stringify({ vehicles, fetchedAt: new Date(fetchedAt).toISOString() }),
    };
  } catch (e) {
    console.error('Vehicles error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
