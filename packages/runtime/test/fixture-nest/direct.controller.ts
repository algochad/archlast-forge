import { Body, Controller, Delete, Get, Injectable, Post, DbService, Read, Write, type MutationCtx } from "../../src/nest";

/** The database straight from a controller: a singleton whose methods are transactions (no function of the reactive system in between). */
@Injectable()
export class DirectNotes extends DbService<MutationCtx> {
  @Read() async list() {
    return (await this.ctx.db.query("notes").collect()).map((n) => n.text);
  }
  @Write() async add(text: string) {
    await this.ctx.db.insert("notes", { text, at: 1 });
    return this.list(); // joins this transaction: sees the insert
  }
  /** Writes and then fails: nothing may stay. */
  @Write() async addThenFail(text: string) {
    await this.ctx.db.insert("notes", { text, at: 1 });
    throw new Error("rolled back");
  }
  @Read() async readThenWrite() {
    return this.add("from a read"); // a read cannot call a @Write() method
  }
  @Read() async writeInRead() {
    return this.ctx.db.constructor && (this.ctx.db as unknown as MutationCtx["db"]).insert("notes", { text: "no", at: 1 });
  }
  @Write() async clear() {
    for (const n of await this.ctx.db.query("notes").collect()) await this.ctx.db.delete(n._id);
  }
  @Read() async who() {
    return (await this.ctx.auth.getUserIdentity())?.userId ?? null;
  }
  noTransaction() {
    return this.ctx; // outside @Read()/@Write() there is no ctx
  }
}

@Controller("direct")
export class DirectController {
  constructor(private readonly notes: DirectNotes) {}
  @Get("notes") list() {
    return this.notes.list();
  }
  @Post("notes") add(@Body() body: { text: string }) {
    return this.notes.add(body.text);
  }
  @Post("fail") fail() {
    return this.notes.addThenFail("kept?");
  }
  @Get("read-write") readWrite() {
    return this.notes.readThenWrite();
  }
  @Get("write-in-read") writeInRead() {
    return this.notes.writeInRead();
  }
  @Get("who") who() {
    return this.notes.who();
  }
  @Get("no-tx") noTx() {
    return this.notes.noTransaction();
  }
  @Delete("notes") clear() {
    return this.notes.clear();
  }
}
