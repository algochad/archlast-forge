import { anyApi } from "../../src/index";
import { Ctx, type ActionCtx } from "../../src/nest";
import { Args, createPubSub, Field, Mutation, ObjectType, Query, Resolver, Subscription } from "../../src/nest-graphql";

const pubSub = createPubSub<{ noteAdded: { text: string; at: number } }>();

@ObjectType()
class NoteType {
  @Field() text!: string;
  @Field() at!: number;
}

@Resolver(() => NoteType)
export class NotesResolver {
  @Query(() => [NoteType])
  notes(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(anyApi.notes.list);
  }

  @Mutation(() => String)
  async addNote(@Ctx() ctx: ActionCtx, @Args("text") text: string) {
    const id = await ctx.runMutation(anyApi.notes.add, { text });
    pubSub.publish("noteAdded", { text, at: 42 });
    return id;
  }

  @Subscription(() => NoteType, { resolve: (note: NoteType) => note })
  noteAdded() {
    return pubSub.subscribe("noteAdded");
  }
}
