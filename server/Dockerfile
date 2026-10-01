FROM node:24-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN npm ci --prefix server --omit=dev --ignore-scripts
COPY server/ ./server/
COPY docs/spawn-selector.js docs/corpse-physics.js docs/heart-drops.js docs/player-movement.js ./docs/
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/index.mjs"]
