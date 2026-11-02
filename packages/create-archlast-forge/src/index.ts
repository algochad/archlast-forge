#!/usr/bin/env bun
// bun create archlast-forge my-app   (or: bunx create-archlast-forge my-app, or: archlast-forge init)
export { main } from "./cli";
export { addPrettier, scaffold, VERSION, type ScaffoldOptions } from "./scaffold";
export { addDesktop, DESKTOP_MODES, solidPng, type DesktopMode } from "./desktop";
export { parseMicroservices, scaffoldMonorepo, TRANSPORTS, type MonorepoOptions, type Transport } from "./monorepo";
export * from "./options";
export * from "./stack";

if (import.meta.main) {
  const { main } = await import("./cli");
  await main(process.argv.slice(2));
}
