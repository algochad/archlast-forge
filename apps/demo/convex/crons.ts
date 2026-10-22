import { cronJobs } from "@archlast-forge/runtime";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge done todos", { hours: 1 }, internal.todos.purgeDone);
export default crons;
