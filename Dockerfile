# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-alpine AS gui-build
WORKDIR /app
COPY package.json ./

COPY gui/package.json gui/bun.lock ./gui/
RUN cd gui && bun install --frozen-lockfile

COPY gui ./gui
RUN cd gui && bun run build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    FROGPROGSY_HOME=/config \
    FROGP_EXTERNAL_SUPERVISOR=1 \
    FROGP_DOCKER_BIND_HOSTNAME=0.0.0.0

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY docker ./docker
COPY --from=gui-build /app/gui/dist ./gui/dist

RUN chmod +x ./docker/entrypoint.sh

EXPOSE 3764
VOLUME ["/config"]

HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
  CMD bun -e 'fetch("http://127.0.0.1:3764/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["bun", "run", "src/cli.ts", "start"]
