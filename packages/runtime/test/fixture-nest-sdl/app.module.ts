import { join } from "node:path";
import { anyApi } from "../../src/index";
import { Ctx, Module, type ActionCtx } from "../../src/nest";
import { Args, ForgeGraphQLDriver, GraphQLModule, Mutation, Query, Resolver, type ForgeGraphQLOptions } from "../../src/nest-graphql";

/** Schema-first: the types are in notes.graphql, and the resolver names them. */
@Resolver("Note")
export class NotesResolver {
  @Query("notes")
  notes(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(anyApi.notes.list);
  }

  @Mutation("addNote")
  addNote(@Ctx() ctx: ActionCtx, @Args("text") text: string) {
    return ctx.runMutation(anyApi.notes.add, { text });
  }
}

@Module({
  imports: [GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, typePaths: [join(import.meta.dir, "*.graphql")]})],
  providers: [NotesResolver],
})
export class AppModule {}
