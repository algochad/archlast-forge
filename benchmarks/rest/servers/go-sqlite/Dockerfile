FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY servers/go-sqlite/go.mod .
COPY servers/go-sqlite/main.go .
# mattn/go-sqlite3 is cgo: it compiles SQLite itself
RUN go mod tidy && CGO_ENABLED=1 go build -ldflags="-s -w" -o /server .

FROM debian:bookworm-slim
COPY --from=build /server /server
CMD ["/server"]
