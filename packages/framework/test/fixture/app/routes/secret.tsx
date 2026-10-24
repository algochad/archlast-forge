import { redirect, type LoaderArgs } from "@archlast-forge/framework";

export const loader = async ({ ctx }: LoaderArgs) => {
  const viewer = await ctx.viewer();
  if (!viewer) throw redirect("/sign-in");
  return { name: viewer.name };
};

export default function Secret() { return <p id="secret">Only for members</p>; }
