import { ForgeService, Injectable, InjectCtx, type ActionCtx, type MutationCtx, type QueryCtx } from "../../src/nest";

/** A singleton: no ctx, one instance for the whole app. */
@Injectable()
export class Clock {
  readonly id = Math.random();
  now() {
    return 42;
  }
}

@Injectable()
export class NotesReader extends ForgeService<QueryCtx> {
  list() {
    return this.ctx.db.query("notes").collect();
  }
}

@Injectable()
export class NotesWriter extends ForgeService<MutationCtx> {
  constructor(
    readonly reader: NotesReader,
    private readonly clock: Clock,
  ) {
    super();
  }
  add(text: string) {
    return this.ctx.db.insert("notes", { text, at: this.clock.now() });
  }
}

@Injectable()
export class Viewer extends ForgeService<ActionCtx> {
  who() {
    return this.ctx.auth.getUserIdentity();
  }
}

/** The ctx through a constructor parameter instead of the base class. */
@Injectable()
export class Counter {
  constructor(@InjectCtx() private readonly ctx: QueryCtx) {}
  async count() {
    return (await this.ctx.db.query("notes").collect()).length;
  }
}
