import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVICES, generateSecrets, parseProjectConfig, parseServiceList, renderCaddyfile, renderCompose, renderDockerfile, renderEnv, type StackService } from "../src/stack";

const compose = (services: StackService[]) => Bun.YAML.parse(renderCompose({ name: "my-app", services, version: "1.2.3" })) as any;

describe("compose.yaml", () => {
  test("with no services it is just the app, on a published port", () => {
    const c = compose([]);
    expect(Object.keys(c.services)).toEqual(["app"]);
    expect(c.services.app.ports).toEqual(["${PORT:-3000}:3000"]);
    expect(c.services.app.depends_on).toBeUndefined();
    expect(c.services.app.build.args.ENGINE_IMAGE).toBe("${ENGINE_IMAGE:-ghcr.io/algochad/archlast-forge-engine:1.2.3}");
    expect(Object.keys(c.volumes)).toEqual(["app-data"]);
    expect(c.services.app.environment.DATABASE_URL).toBeUndefined();
  });

  test("the whole stack: the app waits for each service and is wired to it", () => {
    const c = compose(["postgres", "redis", "s3"]);
    expect(Object.keys(c.services)).toEqual(["app", "postgres", "redis", "rustfs", "rustfs-init"]);
    expect(c.services.app.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      redis: { condition: "service_healthy" },
      "rustfs-init": { condition: "service_completed_successfully" },
    });
    expect(c.services.app.environment.DATABASE_URL).toBe("postgres://forge:${POSTGRES_PASSWORD}@postgres:5432/forge");
    expect(c.services.app.environment.REDIS_URL).toBe("redis://redis:6379");
    // The engine gets only what the file lists: the service's name (its dashboard name and the start of its Redis keys, so services that share a
    // Redis stay apart) and the prefix when Redis is in the stack. Empty means "none", which the engine treats as unset.
    expect(c.services.app.environment.OTEL_SERVICE_NAME).toBe("${OTEL_SERVICE_NAME:-}");
    expect(c.services.app.environment.REDIS_PREFIX).toBe("${REDIS_PREFIX:-}");
    expect(compose(["postgres"]).services.app.environment.REDIS_PREFIX).toBeUndefined(); // no Redis, no prefix
    expect(compose([]).services.app.environment.OTEL_SERVICE_NAME).toBe("${OTEL_SERVICE_NAME:-}");
    expect(c.services.app.environment.S3_ENDPOINT).toBe("http://rustfs:9000");
    // The database, cache and storage API are not published to the world; only the storage port browsers need is.
    expect(c.services.postgres.ports).toBeUndefined();
    expect(c.services.redis.ports).toBeUndefined();
    expect(c.services.rustfs.ports).toEqual(["${S3_PORT:-9000}:9000"]);
    expect(Object.keys(c.volumes)).toEqual(["app-data", "postgres-data", "redis-data", "rustfs-data"]);
    expect(c.services.rustfs["init"]).toBeUndefined();
    expect(c.services["rustfs-init"].entrypoint.join("\n")).toContain("$(seq 1 60)".replace("$", "$$")); // escaped for compose
  });

  test("behind Caddy only Caddy is published, and the app trusts its forwarded addresses", () => {
    const c = compose(["postgres", "s3", "caddy"]);
    expect(c.services.app.ports).toBeUndefined();
    expect(c.services.rustfs.ports).toBeUndefined();
    expect(c.services.caddy.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(c.services.app.environment.TRUST_PROXY).toBe("1");
    expect(c.services.caddy.depends_on).toEqual(["app"]);
    expect(renderCaddyfile(["s3", "caddy"])).toContain("s3.{$DOMAIN:localhost}");
    expect(renderCaddyfile(["caddy"])).not.toContain("rustfs");
  });

  test("a missing secret fails with a message that says what to do", () => {
    const text = renderCompose({ name: "x", services: ["postgres"], version: "1.0.0" });
    expect(text).toContain("${BETTER_AUTH_SECRET:?missing: run `archlast-forge up`");
    expect(text).toContain("${POSTGRES_PASSWORD:?missing");
  });
});

describe(".env", () => {
  test("only the services in use get settings, and secrets are random and distinct", () => {
    const a = renderEnv(["postgres"], generateSecrets());
    expect(a).toContain("POSTGRES_PASSWORD=");
    expect(a).not.toContain("S3_ACCESS_KEY");
    expect(a).toContain("ALLOW_INSECURE_HTTP=1");
    expect(renderEnv(["caddy"], generateSecrets())).toContain("DOMAIN=localhost");
    const withCaddy = renderEnv(["caddy", "s3"], generateSecrets());
    expect(withCaddy.indexOf("DOMAIN=")).toBeLessThan(withCaddy.indexOf("${DOMAIN}")); // Compose resolves .env top to bottom
    expect(renderEnv(["caddy"], generateSecrets())).not.toContain("ALLOW_INSECURE_HTTP");
    const [s1, s2] = [generateSecrets(), generateSecrets()];
    expect(s1.BETTER_AUTH_SECRET).toHaveLength(64);
    expect(s1.BETTER_AUTH_SECRET).not.toBe(s2.BETTER_AUTH_SECRET);
    expect(s1.ADMIN_KEY).not.toBe(s1.BETTER_AUTH_SECRET);
  });

  test(".env.example has the same keys with no values", () => {
    const keys = (text: string) => text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    const services: StackService[] = ["postgres", "redis", "s3"];
    expect(keys(renderEnv(services))).toEqual(keys(renderEnv(services, generateSecrets())));
    expect(renderEnv(services)).toContain("BETTER_AUTH_SECRET=\n");
  });
});

test("Dockerfile builds on the engine image of this version", () => {
  expect(renderDockerfile("0.4.0")).toContain("ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.4.0");
});

describe("archlast-forge.json", () => {
  test("accepts both modes and drops duplicate services", () => {
    expect(parseProjectConfig({ mode: "framework" })).toEqual({ mode: "framework", services: [] });
    expect(parseProjectConfig({ mode: "backend", services: ["postgres", "postgres", "redis"] })).toEqual({ mode: "backend", services: ["postgres", "redis"] });
    expect(DEFAULT_SERVICES.backend).toEqual(["postgres", "redis", "s3"]);
    expect(DEFAULT_SERVICES.framework).toEqual(["postgres", "redis", "s3", "caddy"]);
  });
  test("mistakes say what to change", () => {
    expect(() => parseProjectConfig({ mode: "spa" })).toThrow('"mode" must be "framework" or "backend"');
    expect(() => parseProjectConfig({ mode: "backend", services: "postgres" })).toThrow("must be a list");
    expect(() => parseProjectConfig({ mode: "backend", services: ["mysql"] })).toThrow('unknown service "mysql"; choose from postgres, redis, s3, caddy');
    expect(() => parseProjectConfig([])).toThrow("expected an object");
    expect(parseServiceList("postgres, redis")).toEqual(["postgres", "redis"]);
    expect(parseServiceList("none")).toEqual([]);
    expect(() => parseServiceList("mongo")).toThrow('Unknown service "mongo"');
  });
});
