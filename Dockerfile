# TasklyBridge — one image, one process.
#
# The Go binary serves the API, the Telegram bot and the dashboard's static
# files. Bun only builds the dashboard; it is not a runtime dependency of the
# service. So there is one runtime in production and no second process to
# supervise.

# ---- stage 1: build the dashboard with Bun -------------------------------
FROM oven/bun:1.4 AS web
WORKDIR /web

# Dependencies first, so a source-only change does not reinstall them.
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web/ ./
RUN bun run build


# ---- stage 2: build the Go binary ----------------------------------------
FROM golang:1.27-alpine AS api
WORKDIR /src

# gotd is the only real dependency; go.sum pins it.
COPY go.mod go.sum ./
RUN go mod download

COPY Backend/ ./Backend/
COPY Test/ ./Test/

# CGO off so the binary runs on a scratch-like base. The bcrypt/crypto that
# gotd uses are pure Go, so this costs nothing.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bridge ./Backend


# ---- stage 3: runtime ----------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 bridge

WORKDIR /app
COPY --from=api  /out/bridge /app/bridge
COPY --from=web /web/dist /app/web
# The catalogue is configuration, not baked-in behaviour. Mount it so prices
# can change without a rebuild.
COPY Backend/task.json /app/task.json

# The session directory is a mount point for the durable session store. Neon is
# the real home for session blobs; this keeps a local run self-contained.
RUN mkdir -p /data/sessions && chown -R bridge:bridge /app /data

USER bridge
ENV TZ=UTC \
    OUT_DIR=/data/out \
    TG_SESSION=/data/sessions/probe.session \
    TASK_JSON=/app/task.json

EXPOSE 8080

# -status reports configuration and database reachability without starting the
# bridge, so a failing healthcheck says why instead of just "unhealthy".
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["/app/bridge", "-status"]

ENTRYPOINT ["/app/bridge"]
