import { runSubject } from "../../adapters/node/index.js";

await runSubject((task) => ({ echo: task.input ?? null }));
