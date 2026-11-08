package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/fasthttp/router"
	_ "github.com/mattn/go-sqlite3"
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

// The items are in SQLite (mattn/go-sqlite3): a file on tmpfs in WAL mode, a pool of reader connections and one writer connection (database/sql with one open
// connection serializes the writes), the schema and the cap trigger the other servers use.
var readDB, writeDB *sql.DB

func openDB(path string, conns int) *sql.DB {
	db, err := sql.Open("sqlite3", "file:"+path+"?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000")
	if err != nil {
		panic(err)
	}
	db.SetMaxOpenConns(conns)
	db.SetMaxIdleConns(conns)
	return db
}

func init() {
	path := os.Getenv("DB_PATH")
	if path == "" {
		path = "/data/bench.db"
	}
	writeDB = openDB(path, 1)
	readDB = openDB(path, 4)
	if _, err := writeDB.Exec(fmt.Sprintf(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS items_cap AFTER INSERT ON items BEGIN DELETE FROM items WHERE id = NEW.id - %d; END`, capItems)); err != nil {
		panic(err)
	}
	var present int
	if err := writeDB.QueryRow("SELECT 1 FROM items LIMIT 1").Scan(&present); err == sql.ErrNoRows {
		tx, _ := writeDB.Begin()
		for id := int64(1); id <= 1000; id++ {
			tx.Exec("INSERT INTO items (id, name, quantity) VALUES (?, ?, ?)", id, "item-"+strconv.FormatInt(id, 10), id%100)
		}
		tx.Commit()
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
		rows, err := readDB.Query("SELECT id, name, quantity FROM items WHERE id BETWEEN 1 AND ? ORDER BY id", limit)
		if err != nil {
			panic(err)
		}
		for rows.Next() {
			var it Item
			rows.Scan(&it.ID, &it.Name, &it.Quantity)
			out = append(out, it)
		}
		rows.Close()
		write(ctx, 200, out)
	})
	r.POST("/items", func(ctx *fasthttp.RequestCtx) {
		name, q, ok := parse(ctx.PostBody())
		if !ok {
			invalid(ctx)
			return
		}
		res, err := writeDB.Exec("INSERT INTO items (name, quantity) VALUES (?, ?)", name, q)
		if err != nil {
			panic(err)
		}
		id, _ := res.LastInsertId()
		write(ctx, 201, Item{id, name, q})
	})
	r.GET("/items/{id}", func(ctx *fasthttp.RequestCtx) {
		id, ok := idOf(ctx)
		if !ok {
			notFound(ctx)
			return
		}
		var it Item
		if err := readDB.QueryRow("SELECT id, name, quantity FROM items WHERE id = ?", id).Scan(&it.ID, &it.Name, &it.Quantity); err != nil {
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
		res, err := writeDB.Exec("UPDATE items SET name = ?, quantity = ? WHERE id = ?", name, q, id)
		if n, _ := res.RowsAffected(); err != nil || n == 0 {
			notFound(ctx)
			return
		}
		write(ctx, 200, Item{id, name, q})
	})
	r.DELETE("/items/{id}", func(ctx *fasthttp.RequestCtx) {
		id, ok := idOf(ctx)
		if !ok {
			notFound(ctx)
			return
		}
		res, err := writeDB.Exec("DELETE FROM items WHERE id = ?", id)
		if n, _ := res.RowsAffected(); err != nil || n == 0 {
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
