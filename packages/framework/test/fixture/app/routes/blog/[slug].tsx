import { data, useLoaderData, type LoaderArgs } from "@archlast/forge-framework";

export const loader = async ({ params }: LoaderArgs) => {
  if (params.slug === "missing") throw data("No such post", { status: 404 });
  return { slug: params.slug!, shout: params.slug!.toUpperCase() };
};

export default function Post() {
  const { slug, shout } = useLoaderData<typeof loader>();
  return <article id="post"><h3>{slug}</h3><p>{shout}</p></article>;
}
