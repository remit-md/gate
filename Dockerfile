FROM rust:1.78-slim AS builder
WORKDIR /build
COPY rust/ .
RUN cargo build --release

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /build/target/release/pay-gate /pay-gate
COPY pay-gate.example.yaml /etc/pay-gate/config.yaml
EXPOSE 8402
ENTRYPOINT ["/pay-gate"]
CMD ["start", "--config", "/etc/pay-gate/config.yaml"]
