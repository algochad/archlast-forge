import { anyApi } from "@archlast-forge/runtime";
import type { LoaderArgs } from "@archlast-forge/framework";

export const loader = async ({ ctx }: LoaderArgs) => ctx.query(anyApi.messages.failing);
export default function ForgeFailing() { return null; }
