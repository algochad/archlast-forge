import { anyApi, cronJobs } from "../../src/index";

const crons = cronJobs();
crons.interval("tick", { seconds: 1 }, anyApi.todos.logEvent, { kind: "cron" });
export default crons;
