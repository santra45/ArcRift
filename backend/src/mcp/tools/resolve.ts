/**
 * mcp/tools/resolve.ts — look up a project by ID or by name.
 *
 * store_memory accepts a project name and auto-creates from it, so callers
 * naturally reuse that name afterwards. The read tools accepted only the
 * generated UUID, which meant an assistant could store a memory and then be
 * told its own project did not exist.
 */

import { sessionStore } from "../../services/storage";
import { Session } from "../../services/storage.types";

export async function resolveSession(project: string): Promise<Session | null> {
  const key = String(project);
  return (await sessionStore.getSession(key)) || (await sessionStore.getSessionByName(key));
}
