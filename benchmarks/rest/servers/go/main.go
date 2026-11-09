package main

import (
	"encoding/json"
	"os"
	"strconv"
	"sync"

	"github.com/fasthttp/router"
	"github.com/valyala/fasthttp"
)

const capItems = 100_000

type Item struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Quantity int64  `json:"quantity"`
}

type input struct {
	Name     *string  `json:"name"`
	Quantity *float64 `json:"quantity"`
}

var (
	mu     sync.RWMutex
	items  = map[int64]Item{}
	nextID = int64(1001)
)

func init() {
	for id := int64(1); id <= 1000; id++ {
		items[id] = Item{id, "item-" + strconv.FormatInt(id, 10), id % 100}
	}
}

func parse(body []byte) (string, int64, bool) {
	var in input
	if err := json.Unmarshal(body, &in); err != nil || in.Name == nil || in.Quantity == nil {
		return "", 0, false
	}
	q := *in.Quantity
	if len(*in.Name) == 0 || len(*in.Name) > 100 || q < 0 || q != float64(int64(q)) {
		return "", 0, false
	}
	return *in.Name, int64(q), true
}

func idOf(ctx *fasthttp.RequestCtx) (int64, bool) {
	raw := ctx.UserValue("id").(string)
	if len(raw) == 0 || len(raw) > 15 {
		return 0, false
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

func write(ctx *fasthttp.RequestCtx, status int, v any) {
	ctx.SetContentType("application/json")
	ctx.SetStatusCode(status)
	b, _ := json.Marshal(v)
	ctx.SetBody(b)
}

type errBody struct {
	Error string `json:"error"`
}

func notFound(ctx *fasthttp.RequestCtx) { write(ctx, 404, errBody{"not found"}) }
func invalid(ctx *fasthttp.RequestCtx)  { write(ctx, 400, errBody{"invalid item"}) }

func main() {
	r := router.New()
	r.GET("/health", func(ctx *fasthttp.RequestCtx) { ctx.SetBodyString("ok") })
	r.GET("/items", func(ctx *fasthttp.RequestCtx) {
		limit := 20
		if n, err := strconv.Atoi(string(ctx.QueryArgs().Peek("limit"))); err == nil && n >= 1 && n <= 100 {
			limit = n
		}
		out := make([]Item, 0, limit)
		mu.RLock()
		for id := int64(1); id <= int64(limit); id++ {
			if it, ok := items[id]; ok {
				out = append(out, it)
			}
		}
		mu.RUnlock()
		write(ctx, 200, out)
	})
	r.POST("/items", func(ctx *fasthttp.RequestCtx) {
		name, q, ok := parse(ctx.PostBody())
		if !ok {
			invalid(ctx)
			return
		}
		mu.Lock()
		it := Item{nextID, name, q}
		nextID++
		items[it.ID] = it
		delete(items, it.ID-capItems)
		mu.Unlock()
		write(ctx, 201, it)
	})
	r.GET("/items/{id}", func(ctx *fasthttp.RequestCtx) {
		id, ok := idOf(ctx)
		if !ok {
			notFound(ctx)
			return
		}
		mu.RLock()
		it, found := items[id]
		mu.RUnlock()
		if !found {
			notFound(ctx)
			return
		}
		write(ctx, 200, it)
	})
	r.PUT("/items/{id}", func(ctx *fasthttp.RequestCtx) {
		id, ok := idOf(ctx)
		if !ok {
			notFound(ctx)
			return
		}
		name, q, valid := parse(ctx.PostBody())
		if !valid {
			invalid(ctx)
			return
		}
		mu.Lock()
		_, found := items[id]
		it := Item{id, name, q}
		if found {
			items[id] = it
		}
		mu.Unlock()
		if !found {
			notFound(ctx)
			return
		}
		write(ctx, 200, it)
	})
	r.DELETE("/items/{id}", func(ctx *fasthttp.RequestCtx) {
		id, ok := idOf(ctx)
		if !ok {
			notFound(ctx)
			return
		}
		mu.Lock()
		_, found := items[id]
		delete(items, id)
		mu.Unlock()
		if !found {
			notFound(ctx)
			return
		}
		ctx.SetStatusCode(204)
	})
	r.NotFound = notFound
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := fasthttp.ListenAndServe(":"+port, r.Handler); err != nil {
		panic(err)
	}
}
