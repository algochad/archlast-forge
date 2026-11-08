FROM rust:1.90-bookworm AS build
WORKDIR /src
COPY servers/axum-sqlite/Cargo.toml .
COPY servers/axum-sqlite/src src
RUN cargo build --release && cp target/release/bench-axum-sqlite /server

FROM debian:bookworm-slim
COPY --from=build /server /server
CMD ["/server"]
