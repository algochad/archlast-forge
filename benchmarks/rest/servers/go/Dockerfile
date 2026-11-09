FROM golang:1.24-alpine AS build
WORKDIR /src
COPY servers/go/go.mod .
COPY servers/go/main.go .
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o /server .

FROM alpine:3.22
COPY --from=build /server /server
CMD ["/server"]
