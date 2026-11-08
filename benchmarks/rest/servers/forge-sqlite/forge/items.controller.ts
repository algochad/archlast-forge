import { BadRequestException, Body, Controller, DbService, Delete, Get, HttpCode, Injectable, NotFoundException, Param, Post, Put, Query, Read, Write, type MutationCtx } from "@archlast/forge-runtime/nest";
import { createItem, getItem, listItems, removeItem, seedItems, updateItem } from "./items";
import { idOf, limitOf, parse } from "./store";

const invalid = () => new BadRequestException({ error: "invalid item" });
const missing = () => new NotFoundException({ error: "not found" });

/** The items in the engine's database, reached directly: each method is one transaction, and no function of the reactive system is called. */
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
  @Write() async remove(id: number) {
    return removeItem(this.ctx.db, id);
  }
  @Write() async seed() {
    return seedItems(this.ctx.db);
  }
}

/** The benchmark's CRUD API on the Nest path, with the items in the engine's database through a DbService. */
@Controller("items")
export class ItemsController {
  constructor(private readonly items: ItemsDb) {}

  @Get()
  list(@Query("limit") limit?: string) {
    return this.items.list(limitOf(limit));
  }

  @Post()
  create(@Body() body: unknown) {
    const input = parse(body);
    if (!input) throw invalid();
    return this.items.create(input);
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
    const id = idOf(raw);
    if (id === null) throw missing();
    const input = parse(body);
    if (!input) throw invalid();
    const item = await this.items.update(id, input);
    if (!item) throw missing();
    return item;
  }

  @Delete(":id")
  @HttpCode(204)
  async delete(@Param("id") raw: string) {
    const id = idOf(raw);
    if (id === null || !(await this.items.remove(id))) throw missing();
  }
}

/** Setup for the harness, not part of the measured API: puts items 1 to 1000 in the database when it is empty. */
@Controller("seed")
export class SeedController {
  constructor(private readonly items: ItemsDb) {}
  @Post()
  async seed() {
    return { seeded: await this.items.seed() };
  }
}
