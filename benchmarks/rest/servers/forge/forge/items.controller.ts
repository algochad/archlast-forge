import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from "@archlast/forge-runtime/nest";
import { create, get, idOf, limitOf, list, parse, remove, update } from "./store";

const invalid = () => new BadRequestException({ error: "invalid item" });
const missing = () => new NotFoundException({ error: "not found" });

/** The benchmark's CRUD API on the Nest path: a plain NestJS controller, served by the Forge engine under /http. */
@Controller("items")
export class ItemsController {
  @Get()
  list(@Query("limit") limit?: string) {
    return list(limitOf(limit));
  }

  @Post()
  create(@Body() body: unknown) {
    const input = parse(body);
    if (!input) throw invalid();
    return create(input);
  }

  @Get(":id")
  read(@Param("id") raw: string) {
    const id = idOf(raw);
    const item = id === null ? undefined : get(id);
    if (!item) throw missing();
    return item;
  }

  @Put(":id")
  update(@Param("id") raw: string, @Body() body: unknown) {
    const id = idOf(raw);
    if (id === null) throw missing();
    const input = parse(body);
    if (!input) throw invalid();
    const item = update(id, input);
    if (!item) throw missing();
    return item;
  }

  @Delete(":id")
  @HttpCode(204)
  delete(@Param("id") raw: string) {
    const id = idOf(raw);
    if (id === null || !remove(id)) throw missing();
  }
}
