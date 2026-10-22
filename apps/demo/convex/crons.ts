import { cronJobs } from "@archlast-forge/runtime";
import { api } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge done todos", { hours: 1 }, api.todos.purgeDone);
export default crons;
