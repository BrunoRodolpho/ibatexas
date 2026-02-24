import { buildServer } from "./server.js";
import { startNoShowChecker, stopNoShowChecker } from "./jobs/no-show-checker.js";

const PORT = Number(process.env.PORT ?? 3001);

const start = async (): Promise<void> => {
  const server = await buildServer();

  const shutdown = async (): Promise<void> => {
    stopNoShowChecker();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    // Start background jobs after server is listening
    if (process.env.NODE_ENV !== "test") {
      startNoShowChecker();
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
