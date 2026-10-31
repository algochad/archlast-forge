// GraphQL for Nest inside archlast-forge: everything @nestjs/graphql exports, and ForgeGraphQLDriver, which serves the schema with
// graphql-yoga under /http (POST and GET at `path`, default /graphql) and runs subscriptions with graphql-ws over the engine's sockets at
// the same path. `GraphQLModule.forRoot({ driver: ForgeGraphQLDriver, autoSchemaFile: true })`.
import { AbstractGraphQLDriver, Resolver as NestResolver, type GqlModuleOptions } from "@nestjs/graphql";
import type { GraphQLSchema } from "graphql";
import { makeServer } from "graphql-ws";
import { createYoga, type YogaServerOptions } from "graphql-yoga";
// By the package's own name, not "./nest": the build keeps nest.ts its own entry then, and its `export *` of @nestjs/common survives.
import { onSocket, timeClass, type ForgeSocket, type NestRequest, type NestResponse } from "@archlast/forge-runtime/nest";

export * from "@nestjs/graphql";

/** Nest's `@Resolver()`, timing the resolver's fields for the dashboard. */
export const Resolver = ((...args: unknown[]) => {
  const decorate = (NestResolver as (...a: unknown[]) => ClassDecorator)(...args);
  return (target: Function) => {
    timeClass(target, "resolver");
    return decorate(target);
  };
}) as typeof NestResolver;
/** A PubSub for subscriptions, across function runtime processes: `pubSub.publish("noteAdded", note)`, and a resolver returns `pubSub.subscribe("noteAdded")`. */
export { createPubSub } from "@archlast/forge-runtime/nest";

export interface ForgeGraphQLOptions extends GqlModuleOptions {
  /** More graphql-yoga options: `graphiql`, `maskedErrors`, `plugins`, `cors`. */
  yoga?: Omit<YogaServerOptions<Record<string, unknown>, Record<string, unknown>>, "schema" | "graphqlEndpoint" | "context">;
}

export class ForgeGraphQLDriver extends AbstractGraphQLDriver<ForgeGraphQLOptions> {
  private yoga?: ReturnType<typeof createYoga>;

  async start(options: ForgeGraphQLOptions & { schema: GraphQLSchema }) {
    const { schema, path = "/graphql" } = options;
    // A resolver's context has `req` (for `@Ctx()`, the caller's ActionCtx is on it), plus what `context` adds.
    const context = async (init: Record<string, unknown>) => ({ ...init, ...(typeof options.context === "function" ? await options.context(init) : options.context) });
    const yoga = (this.yoga = createYoga({ ...options.yoga, schema, graphqlEndpoint: path, context }));

    const serve = async (req: NestRequest, res: NestResponse) => {
      // The engine already read the body (to parse it for controllers), so yoga gets it again from rawBody, on the path Nest sees.
      const request = new Request(new URL(req.originalUrl, req.raw.url), { method: req.method, headers: req.raw.headers, body: req.rawBody?.length ? new Uint8Array(req.rawBody) : undefined });
      this.httpAdapterHost.httpAdapter.reply(res, await yoga.handleRequest(request, { req, res }));
    };
    this.httpAdapterHost.httpAdapter.get(path, serve);
    this.httpAdapterHost.httpAdapter.post(path, serve);

    const subscriptions = makeServer<Record<string, unknown>, { socket: ForgeSocket }>({ schema, context: ({ extra }) => context({ req: extra.socket, socket: extra.socket }) });
    onSocket(path, (socket) => {
      const closed = subscriptions.opened(
        { protocol: socket.protocol, send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason), onMessage: (cb) => void socket.on("message", (data) => void cb(String(data))) },
        { socket },
      );
      socket.on("close", (code: number, reason: string) => void closed(code, reason));
    });
  }

  async stop() {
    await this.yoga?.dispose?.();
  }
}
