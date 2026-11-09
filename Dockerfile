# EXPERIMENTAL: not yet tested by the maintainers.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY config ./config
COPY data/sample ./data/sample
ENV GOVCON_DATA_DIR=/data GOVCON_HOST=0.0.0.0 GOVCON_PORT=8787
USER node
VOLUME /data
CMD ["node", "bin/govcon.mjs", "daemon"]
