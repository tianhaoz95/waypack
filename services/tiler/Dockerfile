# Waypack tiler — pmtiles extract behind a small HTTP API. Runs on Cloudflare
# Containers (services/mcp binds it as TILER); also works on Fly.io / Cloud Run.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tiler .

FROM alpine:3.20 AS tools
ARG PMTILES_VERSION=1.31.2
ARG TARGETARCH
RUN apk add --no-cache curl unzip && \
    case "${TARGETARCH:-amd64}" in arm64) A=arm64 ;; *) A=x86_64 ;; esac && \
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${A}.tar.gz" | tar xz -C /usr/local/bin pmtiles && \
    case "${TARGETARCH:-amd64}" in arm64) R=arm64 ;; *) R=amd64 ;; esac && \
    curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/rclone-current-linux-${R}.zip" && \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin && chmod +x /usr/local/bin/rclone /usr/local/bin/pmtiles

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D tiler
COPY --from=tools /usr/local/bin/pmtiles /usr/local/bin/rclone /usr/local/bin/
COPY --from=build /tiler /usr/local/bin/tiler
USER tiler
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tiler"]
