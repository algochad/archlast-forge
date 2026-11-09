using System.Collections.Concurrent;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

// A .NET Web API the way an application writes one: MVC controllers with model binding and validation, and the middleware a service usually carries (request ids, security
// headers, request telemetry, a rate limiter, CORS, an exception handler). It is here to show what .NET does when it has the work a framework like Forge does for every request.
// STORE=memory (the default) keeps the items in a dictionary, STORE=sqlite in SQLite (Microsoft.Data.Sqlite): the two stores of the other .NET servers.
const long Cap = 100_000;
// PIPELINE=controllers leaves out the middleware (request ids, security headers, telemetry, rate limiter, CORS, exception handler): the controllers on their own, to show what MVC costs without it.
var bare = Environment.GetEnvironmentVariable("PIPELINE") == "controllers";
IItemStore store = Environment.GetEnvironmentVariable("STORE") == "sqlite" ? new SqliteStore(Environment.GetEnvironmentVariable("DB_PATH") ?? "/data/bench.db", Cap) : new MemoryStore(Cap);

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.UseUrls($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "3000"}");
builder.Services.AddSingleton(store);
if (!bare) builder.Services.AddSingleton<Telemetry>();
builder.Services
    .AddControllers()
    .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = _ => new BadRequestObjectResult(new ErrorBody("invalid item")))
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.NumberHandling = JsonNumberHandling.Strict; // a number written as text is not a number (the web defaults would take it)
    });
if (!bare) builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins("http://localhost:3000").AllowAnyMethod().AllowAnyHeader()));
if (!bare) builder.Services.AddRateLimiter(o =>
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        RateLimitPartition.GetTokenBucketLimiter(ctx.Connection.RemoteIpAddress?.ToString() ?? "local", _ => new TokenBucketRateLimiterOptions
        {
            TokenLimit = 100_000_000, TokensPerPeriod = 100_000_000, ReplenishmentPeriod = TimeSpan.FromSeconds(1), QueueLimit = 0, AutoReplenishment = true,
        })));

var app = builder.Build();
if (!bare)
{
    app.UseExceptionHandler(a => a.Run(async ctx =>
    {
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new ErrorBody("server error"));
    }));
    app.UseMiddleware<RequestIdMiddleware>();
    app.UseMiddleware<SecurityHeadersMiddleware>();
    app.UseMiddleware<TelemetryMiddleware>();
    app.UseRateLimiter();
    app.UseCors();
}
app.MapControllers();
app.MapGet("/health", () => "ok");
app.MapFallback(() => Results.Json(new ErrorBody("not found"), statusCode: 404));
app.Run();

public record Item(long Id, string Name, long Quantity);
public record ErrorBody([property: JsonPropertyName("error")] string Message);

public class ItemInput
{
    [Required, StringLength(100, MinimumLength = 1)] public string? Name { get; init; }
    [Required, Range(0, double.MaxValue)] public double? Quantity { get; init; }
}

[ApiController, Route("items")]
public class ItemsController(IItemStore store) : ControllerBase
{
    static long? IdOf(string raw) => raw.Length is >= 1 and <= 15 && raw.All(char.IsAsciiDigit) && long.Parse(raw) >= 1 ? long.Parse(raw) : null;
    ObjectResult Missing() => StatusCode(404, new ErrorBody("not found"));
    ObjectResult Invalid() => StatusCode(400, new ErrorBody("invalid item"));
    static bool Whole(ItemInput i) => i.Quantity!.Value == Math.Floor(i.Quantity!.Value);

    [HttpGet]
    public ActionResult<List<Item>> List([FromQuery] int? limit) => Ok(store.ReadMany(limit is >= 1 and <= 100 ? limit.Value : 20));

    [HttpGet("{id}")]
    public ActionResult<Item> Get(string id) => IdOf(id) is long n && store.Read(n) is Item it ? Ok(it) : Missing();

    [HttpPost]
    public ActionResult<Item> Create([FromBody] ItemInput input) => !Whole(input) ? Invalid() : StatusCode(201, store.Insert(input.Name!, (long)input.Quantity!.Value));

    [HttpPut("{id}")]
    public ActionResult<Item> Update(string id, [FromBody] ItemInput input)
    {
        if (IdOf(id) is not long n) return Missing();
        if (!Whole(input)) return Invalid();
        var item = new Item(n, input.Name!, (long)input.Quantity!.Value);
        return store.Replace(item) ? Ok(item) : Missing();
    }

    [HttpDelete("{id}")]
    public ActionResult Delete(string id) => IdOf(id) is long n && store.Remove(n) ? NoContent() : Missing();
}

// ---- the middleware a service carries ----

class RequestIdMiddleware(RequestDelegate next, ILogger<RequestIdMiddleware> log)
{
    public async Task Invoke(HttpContext ctx)
    {
        var id = ctx.Request.Headers["x-request-id"].FirstOrDefault();
        if (string.IsNullOrEmpty(id) || id.Length > 64) id = Guid.NewGuid().ToString("N")[..16];
        ctx.Items["rid"] = id;
        ctx.Response.Headers["x-request-id"] = id;
        using (log.BeginScope(new KeyValuePair<string, object>[] { new("requestId", id) })) await next(ctx);
    }
}

class SecurityHeadersMiddleware(RequestDelegate next)
{
    static readonly (string, string)[] Headers =
    [
        ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer"),
        ("cross-origin-opener-policy", "same-origin"), ("cross-origin-resource-policy", "same-origin"), ("x-dns-prefetch-control", "off"),
        ("x-download-options", "noopen"), ("x-permitted-cross-domain-policies", "none"), ("x-xss-protection", "0"),
        ("content-security-policy", "default-src 'none'; frame-ancestors 'none'"),
    ];
    public Task Invoke(HttpContext ctx)
    {
        foreach (var (k, v) in Headers) ctx.Response.Headers[k] = v;
        return next(ctx);
    }
}

record CallRecord(long At, string Method, string Route, int Status, double Ms, string RequestId);

/// <summary>What a service's telemetry does with a request: a counter and a histogram per route (aggregated by a listener, as an exporter's reader would), a sampled trace, and a ring of recent calls.</summary>
class Telemetry
{
    public readonly ActivitySource Source = new("bench.api");
    readonly Meter meter = new("bench.api");
    public readonly Counter<long> Requests;
    public readonly Histogram<double> Duration;
    readonly ConcurrentDictionary<string, long> counts = new();
    readonly ConcurrentDictionary<string, (long N, double Sum)> durations = new();
    readonly CallRecord?[] ring = new CallRecord?[4096];
    long cursor;

    public Telemetry()
    {
        Requests = meter.CreateCounter<long>("http.requests");
        Duration = meter.CreateHistogram<double>("http.duration", "ms");
        var listener = new MeterListener();
        listener.InstrumentPublished = (inst, l) => { if (inst.Meter.Name == "bench.api") l.EnableMeasurementEvents(inst); };
        listener.SetMeasurementEventCallback<long>((_, v, tags, _) => counts.AddOrUpdate(Key(tags), v, (_, old) => old + v));
        listener.SetMeasurementEventCallback<double>((_, v, tags, _) => durations.AddOrUpdate(Key(tags), (1, v), (_, old) => (old.N + 1, old.Sum + v)));
        listener.Start();
        // a share of requests is traced (the rest only counted)
        ActivitySource.AddActivityListener(new ActivityListener
        {
            ShouldListenTo = s => s.Name == "bench.api",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => Random.Shared.Next(10) == 0 ? ActivitySamplingResult.AllDataAndRecorded : ActivitySamplingResult.PropagationData,
        });
    }

    static string Key(ReadOnlySpan<KeyValuePair<string, object?>> tags)
    {
        var sb = new System.Text.StringBuilder(48);
        foreach (var t in tags) sb.Append(t.Value).Append('|');
        return sb.ToString();
    }

    public void Record(CallRecord r) => ring[Interlocked.Increment(ref cursor) & 4095] = r;
}

class TelemetryMiddleware(RequestDelegate next, Telemetry tel)
{
    public async Task Invoke(HttpContext ctx)
    {
        var start = Stopwatch.GetTimestamp();
        using var activity = tel.Source.StartActivity("http.request", ActivityKind.Server);
        try { await next(ctx); }
        finally
        {
            var ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            var route = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "(unmatched)";
            var status = ctx.Response.StatusCode;
            var tags = new TagList { { "method", ctx.Request.Method }, { "route", route }, { "status", status } };
            tel.Requests.Add(1, tags);
            tel.Duration.Record(ms, tags);
            if (activity is { IsAllDataRequested: true }) { activity.SetTag("http.route", route); activity.SetTag("http.status_code", status); }
            tel.Record(new CallRecord(Environment.TickCount64, ctx.Request.Method, route, status, ms, (string?)ctx.Items["rid"] ?? ""));
        }
    }
}

// ---- the stores ----

public interface IItemStore
{
    Item? Read(long id);
    List<Item> ReadMany(int limit);
    Item Insert(string name, long quantity);
    bool Replace(Item item);
    bool Remove(long id);
}

class MemoryStore : IItemStore
{
    readonly ConcurrentDictionary<long, Item> items = new();
    readonly long cap;
    long nextId = 1000;
    public MemoryStore(long cap)
    {
        this.cap = cap;
        for (long id = 1; id <= 1000; id++) items[id] = new Item(id, $"item-{id}", id % 100);
    }
    public Item? Read(long id) => items.TryGetValue(id, out var it) ? it : null;
    public List<Item> ReadMany(int limit)
    {
        var list = new List<Item>(limit);
        for (long id = 1; id <= limit; id++) if (items.TryGetValue(id, out var it)) list.Add(it);
        return list;
    }
    public Item Insert(string name, long quantity)
    {
        var item = new Item(Interlocked.Increment(ref nextId), name, quantity);
        items[item.Id] = item;
        items.TryRemove(item.Id - cap, out _);
        return item;
    }
    public bool Replace(Item item)
    {
        if (!items.ContainsKey(item.Id)) return false;
        items[item.Id] = item;
        return true;
    }
    public bool Remove(long id) => items.TryRemove(id, out _);
}

class SqliteStore : IItemStore
{
    readonly string connectionString;
    readonly SqliteConnection writer;
    readonly object writeLock = new();
    public SqliteStore(string path, long cap)
    {
        connectionString = $"Data Source={path};Pooling=True";
        writer = new SqliteConnection(connectionString);
        writer.Open();
        Exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
        Exec($"""
            CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL);
            CREATE TRIGGER IF NOT EXISTS items_cap AFTER INSERT ON items BEGIN DELETE FROM items WHERE id = NEW.id - {cap}; END
            """);
        using var check = writer.CreateCommand();
        check.CommandText = "SELECT 1 FROM items LIMIT 1";
        if (check.ExecuteScalar() is null)
        {
            using var tx = writer.BeginTransaction();
            for (long id = 1; id <= 1000; id++)
            {
                using var seed = writer.CreateCommand();
                seed.Transaction = tx;
                seed.CommandText = "INSERT INTO items (id, name, quantity) VALUES ($id, $name, $q)";
                seed.Parameters.AddWithValue("$id", id);
                seed.Parameters.AddWithValue("$name", $"item-{id}");
                seed.Parameters.AddWithValue("$q", id % 100);
                seed.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }
    void Exec(string sql)
    {
        using var cmd = writer.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
    public Item? Read(long id)
    {
        using var c = new SqliteConnection(connectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, quantity FROM items WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? new Item(r.GetInt64(0), r.GetString(1), r.GetInt64(2)) : null;
    }
    public List<Item> ReadMany(int limit)
    {
        using var c = new SqliteConnection(connectionString);
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, quantity FROM items WHERE id BETWEEN 1 AND $limit ORDER BY id";
        cmd.Parameters.AddWithValue("$limit", limit);
        var list = new List<Item>(limit);
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(new Item(r.GetInt64(0), r.GetString(1), r.GetInt64(2)));
        return list;
    }
    public Item Insert(string name, long quantity)
    {
        lock (writeLock)
        {
            using var cmd = writer.CreateCommand();
            cmd.CommandText = "INSERT INTO items (name, quantity) VALUES ($name, $q) RETURNING id";
            cmd.Parameters.AddWithValue("$name", name);
            cmd.Parameters.AddWithValue("$q", quantity);
            return new Item((long)cmd.ExecuteScalar()!, name, quantity);
        }
    }
    public bool Replace(Item item) => Write("UPDATE items SET name = $name, quantity = $q WHERE id = $id", ("$name", item.Name), ("$q", item.Quantity), ("$id", item.Id)) > 0;
    public bool Remove(long id) => Write("DELETE FROM items WHERE id = $id", ("$id", id)) > 0;
    int Write(string sql, params (string, object)[] args)
    {
        lock (writeLock)
        {
            using var cmd = writer.CreateCommand();
            cmd.CommandText = sql;
            foreach (var (k, v) in args) cmd.Parameters.AddWithValue(k, v);
            return cmd.ExecuteNonQuery();
        }
    }
}
