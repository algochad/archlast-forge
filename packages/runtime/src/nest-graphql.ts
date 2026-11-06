// GraphQL for Nest inside archlast-forge: everything @nestjs/graphql exports, and ForgeGraphQLDriver, which serves the schema with
// graphql-yoga under /http (POST and GET at `path`, default /graphql) and runs subscriptions with graphql-ws over the engine's sockets at
// the same path. `GraphQLModule.forRoot({ driver: ForgeGraphQLDriver, autoSchemaFile: true })`.
import { AbstractGraphQLDriver, Resolver as NestResolver, type GqlModuleOptions } from "@nestjs/graphql";
import { NoSchemaIntrospectionCustomRule, type GraphQLSchema } from "graphql";
import { makeServer } from "graphql-ws";
import { createYoga, type Plugin, type YogaServerOptions } from "graphql-yoga";
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
  /**
   * More graphql-yoga options: `graphiql`, `maskedErrors`, `plugins`, `cors`. The engine's defaults differ from yoga's: `cors` allows only
   * the engine's trusted origins (BETTER_AUTH_URL's and TRUSTED_ORIGINS; none of its own when nest() has `cors`), and `graphiql` is on in
   * development only.
   */
  yoga?: Omit<YogaServerOptions<Record<string, unknown>, Record<string, unknown>>, "schema" | "graphqlEndpoint" | "context">;
  /** Answer introspection queries. Default: in development only. */
  introspection?: boolean;
  /**
   * Take operations only as JSON (`application/json`), the default. A form-encoded or multipart POST
   * is one a cross-site page can send with the visitor's cookies and no preflight; `false` takes them too (multipart file uploads need it).
   */
  jsonOnly?: boolean;
}

/** What the engine's function runtime says (runtime-core.ts sets it); an older engine doesn't, and then nothing is trusted and it isn't development. */
const engine = () => (globalThis as Record<symbol, { dev?: boolean; trustedOrigins?: string[] } | undefined>)[Symbol.for("archlast-forge.host")];

/**
 * Refuses a POST whose body isn't JSON, comparing the media type whole (`text/plain; x=application/json` isn't JSON). GraphQL over HTTP
 * sends requests as application/json; application/graphql-response+json is what a client accepts back.
 */
const jsonOnly = (): Plugin => ({
  onRequest({ request, endResponse, fetchAPI }) {
    if (request.method !== "POST") return;
    const type = request.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase();
    if (type === "application/json") return;
    endResponse(new fetchAPI.Response(JSON.stringify({ errors: [{ message: "Send the operation as application/json" }] }), { status: 415, headers: { "content-type": "application/json" } }));
  },
});

/** No introspection: graphql-js's own rule, at validation. */
const noIntrospection = (): Plugin => ({
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
});

export class ForgeGraphQLDriver extends AbstractGraphQLDriver<ForgeGraphQLOptions> {
  private yoga?: ReturnType<typeof createYoga>;

  async start(options: ForgeGraphQLOptions & { schema: GraphQLSchema }) {
    const { schema, path = "/graphql" } = options;
    // A resolver's context has `req` (for `@Ctx()`, the caller's ActionCtx is on it), plus what `context` adds.
    const context = async (init: Record<string, unknown>) => ({ ...init, ...(typeof options.context === "function" ? await options.context(init) : options.context) });
    const host = engine();
    const dev = host?.dev ?? false;
    const trusted = host?.trustedOrigins ?? [];
    // Yoga's own default reflects any Origin with credentials: any site could read a signed-in visitor's answers.
    const cors =
      options.yoga?.cors !== undefined
        ? options.yoga.cors
        : (this.httpAdapterHost.httpAdapter as { corsEnabled?: boolean }).corsEnabled
          ? false
          : (request: Request) => {
              const origin = request.headers.get("origin");
              return origin && trusted.includes(origin) ? { origin: [origin], credentials: true } : false;
            };
    const plugins = [...(options.jsonOnly === false ? [] : [jsonOnly()]), ...((options.introspection ?? dev) ? [] : [noIntrospection()]), ...(options.yoga?.plugins ?? [])];
    const yoga = (this.yoga = createYoga({ ...options.yoga, graphiql: options.yoga?.graphiql ?? dev, cors, plugins, schema, graphqlEndpoint: path, context }));

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
