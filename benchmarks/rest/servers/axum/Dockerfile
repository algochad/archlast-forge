FROM rust:1.90-bookworm AS build
WORKDIR /src
COPY servers/axum/Cargo.toml .
COPY servers/axum/src src
RUN cargo build --release && cp target/release/bench-axum /server

FROM debian:bookworm-slim
COPY --from=build /server /server
CMD ["/server"]
