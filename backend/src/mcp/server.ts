/**
 * mcp/server.ts — ArcRift MCP Server (stdio transport)
 *
 * Transforms ArcRift into a universal memory layer accessible from any
 * MCP-compatible AI tool: Claude Code, Cursor, Windsurf, Claude Desktop.
 *
 * Five tools exposed:
 *   - recall_context      → retrieve relevant memory for a prompt
 *   - store_memory        → save text to ArcRift long-term memory
 *   - search_memory       → semantic search across all sessions
 *   - list_projects       → list all saved project names
 *   - get_project_summary → get knowledge graph summary for a project
 *
 * Updated: v1.6.3
 */
process.env.ARCRIFT_MCP_MODE = "true";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";

// Load env — try common locations relative to dist/src/mcp
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../../backend/.env") });

import { recall } from "./tools/recall";
import { store } from "./tools/store";
import { prune } from "./tools/prune";
import { search } from "./tools/search";
import { listProjects } from "./tools/projects";
import { getSummary } from "./tools/summary";
import { identifyProject } from "./tools/detector";
import { indexCodebase } from "./tools/index_codebase";
import { getWorkingMemory, updateWorkingMemory } from "./tools/working_memory";
import { memorySupersede } from "./tools/memory_supersede";
import { memoryEvolvesChain } from "./tools/memory_evolves_chain";
import { memoryRelationAdd } from "./tools/memory_relation_add";
import { memoryRelationList } from "./tools/memory_relation_list";
import { memoryRelationDelete } from "./tools/memory_relation_delete";
import { DEFAULT_IMPORTANCE, IMPORTANCE_LEVELS, ImportanceLevel } from "../utils/importance";
import { initStorage, sessionStore } from "../services/storage";
import { MemoryCategory } from "../services/storage.types";
import { logger } from "../utils/logger";

/** Advertised to callers as an enum; mirrors the MemoryCategory union. */
const MEMORY_CATEGORIES: MemoryCategory[] = ["Architecture", "Decision", "Gotcha", "Rule", "Tech", "Note"];

// ── Tool definitions ────────────────────────────────────────────────
const TOOLS = [
  {
    name: "recall_context",
    description:
      "Retrieve the most relevant memory chunks for a given prompt. " +
      "Returns sanitised chunks wrapped in <ARCRIFT_retrieved_context> delimiters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The current task or question" },
        project: { type: "string", description: "Project ID to scope the search (optional)" },
        topN: { type: "number", description: "Max chunks to return (default 3, max 6)" },
        debug: { type: "boolean", description: "Include engine attribution in results (default false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "store_memory",
    description:
      "Save text or a full conversation transcript to ArcRift long-term memory. " +
      "This updates the Knowledge Graph and makes the chat visible in the Dashboard history. " +
      "Use this to 'save' a coding session or a key decision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The fact, decision, or context to remember" },
        project: { type: "string", description: "Project ID or a NEW project name (auto-creates)" },
        title: { type: "string", description: "Title for the memory card (default: the first line of content)" },
        importance: { type: "string", enum: IMPORTANCE_LEVELS, description: `How much this matters (default ${DEFAULT_IMPORTANCE})` },
        category: { type: "string", enum: MEMORY_CATEGORIES, description: "What kind of memory this is (default Note)" },
        tags: { type: "array", items: { type: "string" }, description: "Labels to file the memory card under" },
      },
      required: ["content", "project"],
    },
  },
  {
    name: "prune_memory",
    description:
      "Surgically remove facts or context chunks from a project. " +
      "Use this to correct errors or tell ArcRift to 'forget' outdated info.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "What information should be removed?" },
        project: { type: "string", description: "Project ID to prune from" },
      },
      required: ["prompt", "project"],
    },
  },
  {
    name: "search_memory",
    description:
      "Semantic search across all sessions and projects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
        topN: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_projects",
    description: "List all project names and IDs stored in ArcRift Memory.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_project_summary",
    description:
      "Get a structured knowledge-graph summary for a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID" },
      },
      required: ["project"],
    },
  },
  {
    name: "identify_active_project",
    description: "Automatically identify the ArcRift project ID based on a folder path or CWD.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "The current working directory or folder path" },
      },
      required: ["path"],
    },
  },
  {
    name: "index_codebase",
    description: "Scans a local directory and indexes the raw source code files into the current session's memory graph. Call this to give the AI access to the actual codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        directoryPath: {
          type: "string",
          description: "The absolute path to the directory to index (e.g., C:/Code/MyProject)."
        },
        sessionId: {
          type: "string",
          description: "(Optional) The target session ID. Defaults to the active project if omitted."
        }
      },
      required: ["directoryPath"]
    }
  },
  {
    name: "get_working_memory",
    description:
      "Get the standing briefing for a project: current focus, active decisions and known blockers. " +
      "Call this at the start of a task to pick up where the project left off.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID or name (defaults to the active project)" },
      },
      required: [],
    },
  },
  {
    name: "update_working_memory",
    description:
      "Record or revise the standing briefing for a project. " +
      "Fields that are omitted keep their current value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID or a NEW project name (auto-creates)" },
        briefing: { type: "string", description: "Short summary of where the project stands" },
        focusAreas: { type: "array", items: { type: "string" }, description: "What is being worked on now" },
        activeDecisions: { type: "array", items: { type: "string" }, description: "Decisions already settled" },
        blockers: { type: "array", items: { type: "string" }, description: "Open issues and gotchas" },
      },
      required: ["project"],
    },
  },
  {
    name: "memory_supersede",
    description:
      "Record that one memory replaced another. The old memory stops being returned by " +
      "ordinary reads but stays readable as history. Use this when a fact changes rather " +
      "than storing a second, contradictory memory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        old_memory_id: { type: "string", description: "The memory that is now out of date" },
        new_memory_id: { type: "string", description: "The memory that replaces it" },
        reason: { type: "string", description: "Why the claim changed" },
      },
      required: ["old_memory_id", "new_memory_id"],
    },
  },
  {
    name: "memory_evolves_chain",
    description:
      "List every revision of a claim in order, oldest first, including the superseded ones.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_id: { type: "string", description: "Any memory in the chain" },
        max_depth: { type: "number", description: "How far to walk in each direction (default 10)" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "memory_relation_add",
    description:
      "Link two memories with a named relation, e.g. 'caused_by', 'refines' or 'contradicts'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_memory_id: { type: "string", description: "The memory the link starts from" },
        target_memory_id: { type: "string", description: "The memory the link points at" },
        relation_type: { type: "string", description: "Name of the relation" },
        reason: { type: "string", description: "Why the two are linked" },
        strength: { type: "number", description: "0–1, how strong the link is (default 1)" },
        confidence: { type: "number", description: "0–1, how sure the link is (default 1)" },
        bidirectional: { type: "boolean", description: "Whether the link reads both ways (default false)" },
        status: { type: "string", description: "'active' for a settled link, 'suggested' for a proposal" },
      },
      required: ["source_memory_id", "target_memory_id", "relation_type"],
    },
  },
  {
    name: "memory_relation_list",
    description: "List the typed links into and out of one memory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_id: { type: "string", description: "The memory to list relations for" },
        direction: { type: "string", description: "'out', 'in' or 'both' (default both)" },
        relation_types: { type: "array", items: { type: "string" }, description: "Only these relation names" },
        status: { type: "string", description: "'active' (default) or 'suggested'" },
        limit: { type: "number", description: "Max relations to return (default 50)" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "memory_relation_delete",
    description: "Remove a single typed link. The memories it joined are left in place.",
    inputSchema: {
      type: "object" as const,
      properties: {
        relation_id: { type: "string", description: "ID of the relation to remove" },
      },
      required: ["relation_id"],
    },
  }
];

// ── Server setup ────────────────────────────────────────────────────
const server = new Server(
  { name: "ArcRift-memory", version: "1.6.3" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Resource handlers ──────────────────────────────────────────────
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const sessions = await sessionStore.getSessions();
  return {
    resources: sessions.map(s => ({
      uri: `ArcRift://projects/${s._id}/graph`,
      name: `${s.projectName} Knowledge Graph`,
      mimeType: "text/markdown",
      description: `Structured knowledge graph facts for ${s.projectName}`
    }))
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = new URL(req.params.uri);
  const match = uri.pathname.match(/\/projects\/([^/]+)\/graph/);

  if (!match) {
    throw new Error(`Invalid resource URI: ${req.params.uri}`);
  }

  const projectId = match[1];
  const summary = await getSummary(projectId);

  return {
    contents: [{
      uri: req.params.uri,
      mimeType: "text/markdown",
      text: summary
    }]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case "recall_context": {
        const result = await recall(
          args.prompt as string,
          args.project as string,
          args.topN as number | undefined,
          args.debug as boolean | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "store_memory": {
        const result = await store(
          args.content as string,
          args.project as string,
          args.importance as ImportanceLevel | number | undefined,
          args.category as MemoryCategory | undefined,
          args.title as string | undefined,
          args.tags as string[] | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "prune_memory": {
        const result = await prune(
          args.prompt as string,
          args.project as string
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "search_memory": {
        const result = await search(
          args.query as string,
          args.topN as number | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "list_projects": {
        const result = await listProjects();
        return { content: [{ type: "text", text: result }] };
      }
      case "get_project_summary": {
        const result = await getSummary(args.project as string);
        return { content: [{ type: "text", text: result }] };
      }
      case "identify_active_project": {
        const result = await identifyProject(args.path as string);
        return { content: [{ type: "text", text: result }] };
      }
      case "index_codebase": {
        const result = await indexCodebase(args.directoryPath as string, args.sessionId as string | undefined);
        return { content: [{ type: "text", text: result }] };
      }
      case "get_working_memory": {
        const result = await getWorkingMemory(args.project as string | undefined);
        return { content: [{ type: "text", text: result }] };
      }
      case "update_working_memory": {
        const result = await updateWorkingMemory(
          args.project as string,
          args.briefing as string | undefined,
          args.focusAreas as string[] | undefined,
          args.activeDecisions as string[] | undefined,
          args.blockers as string[] | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "memory_supersede": {
        const result = await memorySupersede(
          args.old_memory_id as string,
          args.new_memory_id as string,
          args.reason as string | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "memory_evolves_chain": {
        const result = await memoryEvolvesChain(
          args.memory_id as string,
          args.max_depth as number | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "memory_relation_add": {
        const result = await memoryRelationAdd(
          args.source_memory_id as string,
          args.target_memory_id as string,
          args.relation_type as string,
          args.reason as string | undefined,
          args.strength as number | undefined,
          args.confidence as number | undefined,
          args.bidirectional as boolean | undefined,
          args.status as "active" | "suggested" | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "memory_relation_list": {
        const result = await memoryRelationList(
          args.memory_id as string,
          args.direction as "out" | "in" | "both" | undefined,
          args.relation_types as string[] | undefined,
          args.status as string | undefined,
          args.limit as number | undefined
        );
        return { content: [{ type: "text", text: result }] };
      }
      case "memory_relation_delete": {
        const result = await memoryRelationDelete(args.relation_id as string);
        return { content: [{ type: "text", text: result }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
      isError: true,
    };
  }
});

// ── Bootstrap: start server ─────────────────────
import { startWorker } from "../services/jobs";

async function main() {
  await initStorage();
  // Start the background worker so that sentence indexing jobs are processed
  startWorker().catch(err => logger.error("Failed to start job worker:", err));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ArcRift MCP Server running on stdio");
}

main().catch(err => {
  process.stderr.write(`[ArcRift MCP] Fatal: ${err}\n`);
  process.exit(1);
});
