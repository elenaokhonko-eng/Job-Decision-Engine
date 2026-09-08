import { processPipelineTasks } from "./process_pipeline_tasks.js";

export async function processPipeline(): Promise<void> {
  await processPipelineTasks();
}

if (process.argv[1] && process.argv[1].includes("process_pipeline")) {
  processPipeline().catch(() => {
    process.exit(1);
  });
}
