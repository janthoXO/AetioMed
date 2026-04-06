import express from "express";
import { getRedisClient } from "../core/03repo/redis.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Traces'] */
  next();
});

router.get("/traces", async (_req, res) => {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      res.status(404).json({
        error: {
          code: "REDIS_DISABLED",
          message: "Redis is not configured. Trace history is unavailable.",
        },
      });
      return;
    }

    const traceKeys = await redis.keys("traces:*");

    res.json({
      traces: traceKeys.map((key) => key.replace("traces:", "")),
    });
  } catch (err) {
    console.error("Error fetching trace history from Redis:", err);
    res.status(500).json({
      error: {
        code: "REDIS_ERROR",
        message: "An error occurred while fetching trace history from Redis.",
      },
    });
  }
});

router.get("/traces/:traceId", async (req, res) => {
  const { traceId } = req.params;
  const categories = req.query.categories
    ? (req.query.categories as string).split(",").map((c) => c.trim())
    : [];
  const redis = await getRedisClient();

  if (!redis) {
    res.status(404).json({
      error: {
        code: "REDIS_DISABLED",
        message: "Redis is not configured. Trace history is unavailable.",
      },
    });
    return;
  }

  try {
    const key = `traces:${traceId}`;
    let traces = (await redis.lRange(key, 0, -1)).map((t) => JSON.parse(t));

    if (categories.length > 0) {
      traces = traces.filter((trace) => categories.includes(trace.category));
    }

    res.status(200).json({ traces });
  } catch (err) {
    console.error(`[Redis] Failed to fetch traces for ${traceId}`, err);
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch trace history",
      },
      traces: [],
    });
  }
});

export default router;