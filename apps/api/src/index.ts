import { serve } from "@hono/node-server";
import { pipelineEnvFrom, startPipelineWorker, WorkerConfigError, type PipelineEnv } from "@wabrain/worker/runtime";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startRuntime } from "./runtime.js";

async function main() {
  let config;
  let pipelineEnv: PipelineEnv;
  try {
    config = loadConfig();
    // The embedded worker needs the whole pipeline environment; the API alone only the VAPID subject.
    pipelineEnv = pipelineEnvFrom(config.embeddedWorker ? process.env : { VAPID_SUBJECT: process.env.VAPID_SUBJECT });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof WorkerConfigError) {
      console.error(error.message);
      process.exit(78);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  const { app, database, queue, deps, push } = await startRuntime(config, logger, { push: { vapidSubject: pipelineEnv.vapidSubject } });
  const worker = config.embeddedWorker
    ? await startPipelineWorker({ database, queue, filter: deps.intakeFilter, logger, pipeline: pipelineEnv })
    : null;

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info("WABrain API listening", { port: info.port, embeddedWorker: config.embeddedWorker });
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    server.close();
    await worker?.stop();
    await push.flush();
    await queue.stop();
    await database.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("Fatal startup error", error instanceof Error ? error.message : error);
  process.exit(1);
});
