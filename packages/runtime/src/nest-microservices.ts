// Microservices for Nest inside archlast-forge: everything @nestjs/microservices exports. List transports in nest(http, { microservices })
// and they listen in the function runtime next to the controllers. TCP needs nothing more; another transport needs its client package in
// forge/package.json, as in any Nest app (ioredis for Redis, nats, mqtt, kafkajs, amqplib with amqp-connection-manager, @grpc/grpc-js).
export * from "@nestjs/microservices";
/** Nest's transport context (`@Ctx()` in @nestjs/microservices), renamed: here, as everywhere in forge, `Ctx` is the engine's ActionCtx. */
export { Ctx as TransportCtx } from "@nestjs/microservices";
// By the package's own name, not "./nest": the build keeps nest.ts its own entry then, and its `export *` of @nestjs/common survives.
export { Ctx } from "@archlast/forge-runtime/nest";
