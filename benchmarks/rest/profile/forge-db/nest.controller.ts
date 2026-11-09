import { BadRequestException, Body, Controller, DbService, Get, Injectable, NotFoundException, Param, Post, Put, Query, Read, Write, type MutationCtx } from "@archlast/forge-runtime/nest";
import { createItem, getItem, listItems, updateItem } from "./items";
import { idOf, limitOf } from "./store";

const missing = () => new NotFoundException({ error: "not found" });

// the benchmark's Nest path on ctx.db (what benchmarks/rest/servers/forge-sqlite does), under /http/nitems
@Injectable()
export class ItemsDb extends DbService<MutationCtx> {
  @Read() async get(id: number) {
    return getItem(this.ctx.db, id);
  }
  @Read() async list(limit: number) {
    return listItems(this.ctx.db, limit);
  }
  @Write() async create(input: { name: string; quantity: number }) {
    return createItem(this.ctx.db, input);
  }
  @Write() async update(id: number, input: { name: string; quantity: number }) {
    return updateItem(this.ctx.db, id, input);
  }
}

@Controller("nitems")
export class NestItemsController {
  constructor(private readonly items: ItemsDb) {}
  @Get()
  list(@Query("limit") limit?: string) {
    return this.items.list(limitOf(limit));
  }
  @Post()
  create(@Body() body: unknown) {
    const b = body as { name?: string; quantity?: number } | null;
    if (!b || typeof b.name !== "string" || typeof b.quantity !== "number") throw new BadRequestException({ error: "invalid item" });
    return this.items.create({ name: b.name, quantity: b.quantity });
  }
  @Get(":id")
  async read(@Param("id") raw: string) {
    const id = idOf(raw);
    const item = id === null ? null : await this.items.get(id);
    if (!item) throw missing();
    return item;
  }
  @Put(":id")
  async update(@Param("id") raw: string, @Body() body: unknown) {
    const id = idOf(raw) ?? 1;
    const b = body as { name: string; quantity: number };
    const item = await this.items.update(id, b);
    if (!item) throw missing();
    return item;
  }
}
