import express from "express";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "./swagger-output.json" with { type: "json" };

const router = express.Router();
router.use("/", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

export default router;
