import { useLoaderData, type LoaderArgs } from "@archlast-forge/framework";

export const loader = async ({ request }: LoaderArgs) => ({ text: new URL(request.url).searchParams.get("q") ?? "" });

export default function Echo() {
  const { text } = useLoaderData<typeof loader>();
  return <p id="echo">{text}</p>;
}
