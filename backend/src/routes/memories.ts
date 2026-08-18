import { Router, Request, Response } from "express";
import { memoryStore, sessionStore } from "../services/storage";
import { logger } from "../utils/logger";

const router = Router();

// GET /api/memories
router.get("/", async (req: Request, res: Response) => {
  const { sessionId, importance, category, unitType, query, limit } = req.query;

  try {
    const memories = await memoryStore.getMemories(
      typeof sessionId === "string" ? sessionId : undefined,
      {
        importance: typeof importance === "string" ? importance : undefined,
        category: typeof category === "string" ? category : undefined,
        unitType: typeof unitType === "string" ? unitType : undefined,
        query: typeof query === "string" ? query : undefined,
        limit: typeof limit === "string" ? parseInt(limit, 10) : undefined
      }
    );
    res.json({ success: true, memories });
  } catch (err) {
    logger.error("Failed to fetch memories:", err);
    res.status(500).json({ error: "Failed to fetch memories" });
  }
});

// GET /api/memories/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const memory = await memoryStore.getMemory(req.params.id as string);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ success: true, memory });
  } catch (err) {
    logger.error("Failed to fetch memory:", err);
    res.status(500).json({ error: "Failed to fetch memory" });
  }
});

// POST /api/memories
router.post("/", async (req: Request, res: Response) => {
  const { sessionId, content } = req.body;

  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  try {
    // The memories row has a foreign key onto sessions, so a name that has
    // never been saved before becomes a project rather than a constraint error.
    const session =
      (await sessionStore.getSession(sessionId)) ||
      (await sessionStore.getSessionByName(sessionId)) ||
      (await sessionStore.createSession(sessionId, "manual"));

    const memory = await memoryStore.createMemory({ ...req.body, sessionId: session._id });
    res.json({ success: true, memory });
  } catch (err) {
    logger.error("Failed to create memory:", err);
    res.status(500).json({ error: "Failed to create memory" });
  }
});

// POST /api/memories/:id — partial update
router.post("/:id", async (req: Request, res: Response) => {
  try {
    const memory = await memoryStore.updateMemory(req.params.id as string, req.body);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ success: true, memory });
  } catch (err) {
    logger.error("Failed to update memory:", err);
    res.status(500).json({ error: "Failed to update memory" });
  }
});

// DELETE /api/memories/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const deleted = await memoryStore.deleteMemory(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error("Failed to delete memory:", err);
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

export default router;
