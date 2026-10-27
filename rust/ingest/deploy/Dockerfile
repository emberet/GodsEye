# Example image for ge-ingest. Build from rust/ingest:  docker build -f deploy/Dockerfile -t ge-ingest .
# Run (socket shared with the agent through a volume):
#   docker run -d --name ge-ingest --env-file ingest.env -v /run/godseye:/run/godseye \
#     -e GE_INGEST_SOCKET=/run/godseye/ingest.sock -e GE_INGEST_METRICS_ADDR=0.0.0.0:9466 -p 127.0.0.1:9466:9466 ge-ingest
# ingest.env holds only GRPC_URL / GRPC_TOKEN / STREAM_PROGRAMS. The socket is created mode 0600, so run the
# container as the same uid as the agent (--user) if the agent is outside the container.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p ge-ingest

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/ge-ingest /usr/local/bin/ge-ingest
USER 10001
ENTRYPOINT ["/usr/local/bin/ge-ingest"]
