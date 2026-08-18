import { Router, Request, Response } from "express";
import { memoryStore } from "../services/storage";
import { logger } from "../utils/logger";
import { isValidObjectId } from "../utils/validators";

const router = Router();

// GET /api/working-memory/:sessionId
router.get("/:sessionId", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;

  if (!isValidObjectId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId format" });
    return;
  }

  try {
    const workingMemory = await memoryStore.getWorkingMemory(sessionId);
    if (!workingMemory) {
      res.status(404).json({ error: "No working memory recorded for this session" });
      return;
    }
    res.json({ success: true, workingMemory });
  } catch (err) {
    logger.error("Failed to fetch working memory:", err);
    res.status(500).json({ error: "Failed to fetch working memory" });
  }
});

// POST /api/working-memory/:sessionId
router.post("/:sessionId", async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { briefing, focusAreas, activeDecisions, blockers } = req.body;

  if (!isValidObjectId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId format" });
    return;
  }

  try {
    const workingMemory = await memoryStore.saveWorkingMemory({
      sessionId,
      briefing,
      focusAreas: Array.isArray(focusAreas) ? focusAreas : undefined,
      activeDecisions: Array.isArray(activeDecisions) ? activeDecisions : undefined,
      blockers: Array.isArray(blockers) ? blockers : undefined
    });
    res.json({ success: true, workingMemory });
  } catch (err) {
    logger.error("Failed to save working memory:", err);
    res.status(500).json({ error: "Failed to save working memory" });
  }
});

export default router;
