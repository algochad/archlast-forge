# Benchmark image: Bun, Tuyere (native libs built against this image's glibc), Forge's RPC handler, and the load tools.
FROM rust:1-bookworm AS build
WORKDIR /src
RUN cargo install oha --locked --root /out 2>&1 | tail -1
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release
COPY bench/client ./bench/client
RUN cd bench/client && cargo build --release

FROM oven/bun:1.4.4-debian
WORKDIR /app
COPY --from=build /out/bin/oha /usr/local/bin/oha
COPY --from=build /src/bench/client/target/release/client /usr/local/bin/wsclient
COPY --from=build /src/target/release/libtuyere_ffi.so /app/native/tuyere_ffi.so
COPY --from=build /src/target/release/libtuyere_napi.so /app/native/tuyere.node
COPY package.json ./
COPY src ./src
COPY bench/servers ./bench/servers
COPY bench/container/forge /forge
ENV FORGE=/forge/src
