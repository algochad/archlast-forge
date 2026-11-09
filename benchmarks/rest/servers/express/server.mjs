import express from "express";
import { create, get, idOf, limitOf, list, parse, remove, update } from "./store.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.use((err, _req, res, next) => (err ? res.status(400).json({ error: "invalid item" }) : next()));

app.get("/health", (_req, res) => res.send("ok"));
app.get("/items", (req, res) => res.json(list(limitOf(req.query.limit))));
app.post("/items", (req, res) => {
  const input = parse(req.body);
  if (!input) return res.status(400).json({ error: "invalid item" });
  res.status(201).json(create(input));
});
app.get("/items/:id", (req, res) => {
  const id = idOf(req.params.id);
  const item = id === null ? undefined : get(id);
  item ? res.json(item) : res.status(404).json({ error: "not found" });
});
app.put("/items/:id", (req, res) => {
  const id = idOf(req.params.id);
  const input = parse(req.body);
  if (id === null) return res.status(404).json({ error: "not found" });
  if (!input) return res.status(400).json({ error: "invalid item" });
  const item = update(id, input);
  item ? res.json(item) : res.status(404).json({ error: "not found" });
});
app.delete("/items/:id", (req, res) => {
  const id = idOf(req.params.id);
  id !== null && remove(id) ? res.status(204).end() : res.status(404).json({ error: "not found" });
});
app.use((_req, res) => res.status(404).json({ error: "not found" }));

app.listen(Number(process.env.PORT ?? 3000));
