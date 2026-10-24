import type { LoaderArgs } from "@archlast/forge-framework";

export const loader = async (_: LoaderArgs) => {
  throw new Error("database password is hunter2");
};
export default function Boom() { return null; }
