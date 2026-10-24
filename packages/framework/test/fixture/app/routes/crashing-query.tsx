import { anyApi } from "@archlast/forge-runtime";
import type { LoaderArgs } from "@archlast/forge-framework";

export const loader = async ({ ctx }: LoaderArgs) => ctx.query(anyApi.messages.crashing);
export default function CrashingQuery() { return null; }
