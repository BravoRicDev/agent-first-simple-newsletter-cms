import { Router } from "express";
import { buildHumanGuide } from "../services/human-guide.js";

const router = Router();

router.get("/human-guide", async (req, res, next) => {
  try {
    res.type("text/plain").send(await buildHumanGuide());
  } catch (err) { next(err); }
});

export default router;
