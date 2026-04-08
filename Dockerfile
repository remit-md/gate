FROM rust:1.94-slim AS builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY rust/ rust/
COPY pay-gate.example.yaml .
WORKDIR /build/rust
RUN cargo build --release

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /build/rust/target/release/pay-gate /pay-gate
COPY pay-gate.example.yaml /etc/pay-gate/config.yaml
EXPOSE 8402
ENTRYPOINT ["/pay-gate"]
CMD ["start", "--config", "/etc/pay-gate/config.yaml"]
