FROM node:20-alpine

WORKDIR /app

# wget: stops/routes download + health check; unzip: GTFS zip extraction
RUN apk add --no-cache wget unzip

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Stamp the baked-in stops_cache.json with the current build time so the container
# treats it as fresh and doesn't immediately try to re-download on first boot.
# The cache will refresh automatically after 24h if the container can reach OVapi.
RUN node -e " \
  const fs = require('fs'); \
  const p = './stops_cache.json'; \
  if (!fs.existsSync(p)) { console.error('stops_cache.json missing from image'); process.exit(1); } \
  const c = JSON.parse(fs.readFileSync(p)); \
  c.timestamp = Date.now(); \
  fs.writeFileSync(p, JSON.stringify(c)); \
  console.log('Stops cache stamped:', c.stops.length, 'stops'); \
"

EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production

CMD ["node", "server.js"]
