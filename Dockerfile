FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production TUYA_MQTT_HOST=0.0.0.0 TUYA_MQTT_CONFIG=/app/data/config.json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3200
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "try { const r = await fetch('http://127.0.0.1:3200/', { signal: AbortSignal.timeout(3000) }); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"
CMD ["node", "dist/server.js"]
