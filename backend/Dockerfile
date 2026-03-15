FROM node:20-alpine

WORKDIR /app

# wget: stops/routes download + health check; unzip: GTFS zip extraction
RUN apk add --no-cache wget unzip

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Pre-seed the stops cache at build time so containers start instantly.
# Without this, first boot downloads a 216 MB zip which delays the health check.
# The cache expires after 24h and refreshes automatically in the background.
RUN node -e "require('./stops').getStops().then(() => process.exit(0))"

EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production

CMD ["node", "server.js"]
