/**
 * mcp/tools/working_memory.ts — get_working_memory / update_working_memory tools
 *
 * The standing briefing for a project: what it is about, what is being worked
 * on, what has already been decided, and what is in the way.
 */

import { memoryStore, sessionStore } from "../../services/storage";
import { resolveSession } from "./resolve";

const bullets = (items: string[], fallback: string): string =>
  items.length > 0 ? items.map(i => `- ${i}`).join("\n") : `- ${fallback}`;

export async function getWorkingMemory(project?: string): Promise<string> {
  try {
    // Without an explicit project, fall back to whatever the dashboard or the
    // last save marked active.
    const key = project ? String(project) : await sessionStore.getActiveSessionId();

    if (!key) {
      return "No active ArcRift project. Pass a project name, or use list_projects to see valid IDs.";
    }

    const session = await resolveSession(key);
    if (!session) {
      return `ArcRift project ID "${key}" not found. Use list_projects to see valid IDs.`;
    }

    const wm = await memoryStore.getWorkingMemory(session._id);

    if (!wm || (!wm.briefing && wm.focusAreas.length === 0)) {
      return `No working memory recorded yet for project "${session.projectName}". ` +
             `Use update_working_memory to record the briefing.`;
    }

    return `<WORKING_MEMORY project="${session.projectName}" updated="${wm.updatedAt.toISOString()}">\n` +
           `Working memory for project "${session.projectName}":\n\n` +
           `BRIEFING:\n${wm.briefing || "No briefing recorded."}\n\n` +
           `CURRENT FOCUS:\n${bullets(wm.focusAreas, "Ongoing development")}\n\n` +
           `ACTIVE DECISIONS:\n${bullets(wm.activeDecisions, "Follow existing codebase patterns")}\n\n` +
           `KNOWN BLOCKERS:\n${bullets(wm.blockers, "None reported")}\n` +
           `</WORKING_MEMORY>`;
  } catch (err: any) {
    return `get_working_memory failed: ${err.message ?? String(err)}`;
  }
}

export async function updateWorkingMemory(
  project: string,
  briefing?: string,
  focusAreas?: string[],
  activeDecisions?: string[],
  blockers?: string[]
): Promise<string> {
  try {
    const projectStr = String(project);

    // Mirrors store_memory: a name that does not resolve becomes a new project.
    const session =
      (await resolveSession(projectStr)) ||
      (await sessionStore.createSession(projectStr, "mcp"));

    const saved = await memoryStore.saveWorkingMemory({
      sessionId: session._id,
      briefing,
      focusAreas: Array.isArray(focusAreas) ? focusAreas : undefined,
      activeDecisions: Array.isArray(activeDecisions) ? activeDecisions : undefined,
      blockers: Array.isArray(blockers) ? blockers : undefined
    });

    return `Updated working memory for project "${session.projectName}":\n` +
           `- Focus areas: ${saved.focusAreas.length}\n` +
           `- Active decisions: ${saved.activeDecisions.length}\n` +
           `- Blockers: ${saved.blockers.length}`;
  } catch (err: any) {
    return `update_working_memory failed: ${err.message ?? String(err)}`;
  }
}
