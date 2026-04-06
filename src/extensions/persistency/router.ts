import express from "express";
import { getRedisClient } from "@/extensions/core/03repo/redis.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Persistency'] */
  next();
});

router.get("/cases", async (_req, res) => {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      res.status(404).json({
        error: {
          code: "REDIS_DISABLED",
          message: "Redis is not configured. Cases are unavailable.",
        },
      });
      return;
    }

    const caseKeys = await redis.keys("case:*");
    if (caseKeys.length === 0) {
      res.json({ cases: [] });
      return;
    }

    const cases = await redis
      .mGet(caseKeys)
      .then((cases) => cases.map((c) => JSON.parse(c as string)));

    res.json({ cases });
  } catch (err) {
    console.error("Error fetching cases from Redis:", err);
    res.status(500).json({
      error: {
        code: "REDIS_ERROR",
        message: "An error occurred while fetching cases from Redis.",
      },
    });
  }
});

export default router;
