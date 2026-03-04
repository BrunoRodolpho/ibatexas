import { buildServer } from "./server.js";
import { startNoShowChecker, stopNoShowChecker } from "./jobs/no-show-checker.js";
import { startReviewPromptPoller, stopReviewPromptPoller } from "./jobs/review-prompt-poller.js";
import { startAbandonedCartChecker, stopAbandonedCartChecker } from "./jobs/abandoned-cart-checker.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { closeNatsConnection } from "@ibatexas/nats-client";

const PORT = Number(process.env.PORT ?? 3001);

const start = async (): Promise<void> => {
  const server = await buildServer();

  const shutdown = async (): Promise<void> => {
    stopNoShowChecker();
    stopReviewPromptPoller();
    stopAbandonedCartChecker();
    await closeNatsConnection();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    // Start background jobs and NATS subscribers after server is listening
    if (process.env.NODE_ENV !== "test") {
      startNoShowChecker();
      startReviewPromptPoller(server.log);
      startAbandonedCartChecker(server.log);
      await startCartIntelligenceSubscribers(server.log);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
