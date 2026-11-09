using System.Text.Json;
using Microsoft.Data.Sqlite;
using System.Text.Json.Serialization;

// The items are in SQLite (Microsoft.Data.Sqlite): a file on tmpfs in WAL mode, pooled connections for reads and one connection behind a lock for writes,
// the schema and the cap trigger the other servers use.
const long Cap = 100_000;
var path = Environment.GetEnvironmentVariable("DB_PATH") ?? "/data/bench.db";
var connectionString = $"Data Source={path};Pooling=True";
var writer = new SqliteConnection(connectionString);
writer.Open();
Exec(writer, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
Exec(writer, $"""
    CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS items_cap AFTER INSERT ON items BEGIN DELETE FROM items WHERE id = NEW.id - {Cap}; END
    """);
using (var check = writer.CreateCommand())
{
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
var writeLock = new object();

static void Exec(SqliteConnection c, string sql)
{
    using var cmd = c.CreateCommand();
    cmd.CommandText = sql;
    cmd.ExecuteNonQuery();
}

Item? Read(long id)
{
    using var c = new SqliteConnection(connectionString);
    c.Open();
    using var cmd = c.CreateCommand();
    cmd.CommandText = "SELECT id, name, quantity FROM items WHERE id = $id";
    cmd.Parameters.AddWithValue("$id", id);
    using var r = cmd.ExecuteReader();
    return r.Read() ? new Item(r.GetInt64(0), r.GetString(1), r.GetInt64(2)) : null;
}

List<Item> ReadMany(int limit)
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

long Insert(string name, long quantity)
{
    lock (writeLock)
    {
        using var cmd = writer.CreateCommand();
        cmd.CommandText = "INSERT INTO items (name, quantity) VALUES ($name, $q) RETURNING id";
        cmd.Parameters.AddWithValue("$name", name);
        cmd.Parameters.AddWithValue("$q", quantity);
        return (long)cmd.ExecuteScalar()!;
    }
}

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

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseUrls($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "3000"}");
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJson.Default);
});
var app = builder.Build();

static IResult NotFound() => Results.Json(new Error("not found"), AppJson.Default.Error, statusCode: 404);
static IResult Invalid() => Results.Json(new Error("invalid item"), AppJson.Default.Error, statusCode: 400);
static long? IdOf(string raw) => raw.Length is >= 1 and <= 15 && raw.All(char.IsAsciiDigit) && long.Parse(raw) >= 1 ? long.Parse(raw) : null;

static async Task<Input?> ParseAsync(HttpRequest req)
{
    try
    {
        var input = await JsonSerializer.DeserializeAsync(req.Body, AppJson.Default.Input);
        if (input is null || input.Name is null || input.Quantity is null) return null;
        var q = input.Quantity.Value;
        return input.Name.Length is >= 1 and <= 100 && q >= 0 && q == Math.Floor(q) ? input : null;
    }
    catch (JsonException) { return null; }
}

app.MapGet("/health", () => "ok");
app.MapGet("/items", (int? limit) =>
{
    var n = limit is >= 1 and <= 100 ? limit.Value : 20;
    return Results.Json(ReadMany(n), AppJson.Default.ListItem);
});
app.MapPost("/items", async (HttpRequest req) =>
{
    var input = await ParseAsync(req);
    if (input is null) return Invalid();
    var quantity = (long)input.Quantity!.Value;
    var item = new Item(Insert(input.Name!, quantity), input.Name!, quantity);
    return Results.Json(item, AppJson.Default.Item, statusCode: 201);
});
app.MapGet("/items/{id}", (string id) => IdOf(id) is long n && Read(n) is Item it ? Results.Json(it, AppJson.Default.Item) : NotFound());
app.MapPut("/items/{id}", async (string id, HttpRequest req) =>
{
    if (IdOf(id) is not long n) return NotFound();
    var input = await ParseAsync(req);
    if (input is null) return Invalid();
    var item = new Item(n, input.Name!, (long)input.Quantity!.Value);
    if (Write("UPDATE items SET name = $name, quantity = $q WHERE id = $id", ("$name", item.Name), ("$q", item.Quantity), ("$id", n)) == 0) return NotFound();
    return Results.Json(item, AppJson.Default.Item);
});
app.MapDelete("/items/{id}", (string id) => IdOf(id) is long n && Write("DELETE FROM items WHERE id = $id", ("$id", n)) > 0 ? Results.StatusCode(204) : NotFound());
app.MapFallback(() => NotFound());
app.Run();

record Item(long Id, string Name, long Quantity);
record Input(string? Name, double? Quantity);
record Error([property: JsonPropertyName("error")] string Message);

[JsonSerializable(typeof(Item))]
[JsonSerializable(typeof(List<Item>))]
[JsonSerializable(typeof(Input))]
[JsonSerializable(typeof(Error))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
partial class AppJson : JsonSerializerContext;
