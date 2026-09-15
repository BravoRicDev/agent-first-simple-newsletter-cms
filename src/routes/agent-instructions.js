import { Router } from "express";
import { buildAgentPrompt } from "../services/agent-prompt.js";

const router = Router();

router.get("/agent", async (req, res, next) => {
  try {
    const lang = res.locals.lang || "en";
    res.type("text/plain").send(await buildAgentPrompt(req, lang));
  } catch (err) { next(err); }
});

export default router;
