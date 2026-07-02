FROM node:20-alpine

WORKDIR /app

# better-sqlite3 needs build tools to compile on install
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# SQLite data lives here - mount this as a volume so it survives restarts/rebuilds
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
