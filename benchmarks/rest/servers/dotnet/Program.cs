using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

const long Cap = 100_000;
var items = new ConcurrentDictionary<long, Item>();
for (long id = 1; id <= 1000; id++) items[id] = new Item(id, $"item-{id}", id % 100);
long nextId = 1000;

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
    var list = new List<Item>(n);
    for (long id = 1; id <= n; id++) if (items.TryGetValue(id, out var it)) list.Add(it);
    return Results.Json(list, AppJson.Default.ListItem);
});
app.MapPost("/items", async (HttpRequest req) =>
{
    var input = await ParseAsync(req);
    if (input is null) return Invalid();
    var id = Interlocked.Increment(ref nextId);
    var item = new Item(id, input.Name!, (long)input.Quantity!.Value);
    items[item.Id] = item;
    items.TryRemove(item.Id - Cap, out _);
    return Results.Json(item, AppJson.Default.Item, statusCode: 201);
});
app.MapGet("/items/{id}", (string id) => IdOf(id) is long n && items.TryGetValue(n, out var it) ? Results.Json(it, AppJson.Default.Item) : NotFound());
app.MapPut("/items/{id}", async (string id, HttpRequest req) =>
{
    if (IdOf(id) is not long n) return NotFound();
    var input = await ParseAsync(req);
    if (input is null) return Invalid();
    var item = new Item(n, input.Name!, (long)input.Quantity!.Value);
    if (!items.ContainsKey(n)) return NotFound();
    items[n] = item;
    return Results.Json(item, AppJson.Default.Item);
});
app.MapDelete("/items/{id}", (string id) => IdOf(id) is long n && items.TryRemove(n, out _) ? Results.StatusCode(204) : NotFound());
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
