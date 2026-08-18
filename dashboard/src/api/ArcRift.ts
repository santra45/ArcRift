import { apiClient, extractErrorMessage } from "./client";

export async function fetchGraphBySession(sessionId: string) {
  const res = await apiClient.get(`/api/graph/session/${sessionId}`);
  return res.data as {
    nodes: { id: string; type: string }[];
    links: { source: string; target: string; relation: string }[];
  };
}

export async function fetchContext(sessionId: string) {
  const res = await apiClient.get(`/api/context/retrieve/${sessionId}`);
  return res.data;
}

export async function fetchSessions() {
  const res = await apiClient.get(`/api/context/sessions`);
  return res.data as {
    sessions: {
      _id: string;
      projectName: string;
      platform: string;
      tripleCount: number;
      topicCount?: number;
      hasFullChat?: boolean;
      tokensSaved?: number;
      retrievalCount?: number;
      createdAt: string;
      updatedAt: string;
    }[];
  };
}

export async function setActiveSession(sessionId: string) {
  const res = await apiClient.post(`/api/context/active`, { sessionId });
  return res.data;
}

export async function deleteSession(sessionId: string) {
  const res = await apiClient.delete(`/api/context/session/${sessionId}`);
  return res.data;
}

export async function exportSession(sessionId: string) {
  // Use direct URL for download - assumes API_URL is correct in apiClient
  const baseUrl = apiClient.defaults.baseURL || "http://localhost:3001";
  const url = new URL(`${baseUrl}/api/session/export/${sessionId}`);
  window.open(url.toString(), "_blank");
}

export async function importSession(data: any) {
  const res = await apiClient.post(`/api/session/import`, { data });
  return res.data;
}

export async function searchGlobal(prompt: string) {
  const res = await apiClient.post(`/api/rag/global`, { prompt, topN: 10 });
  return res.data as {
    found: boolean;
    chunks: { content: string; projectName?: string }[];
    graphFacts: { subject: string; relation: string; object: string; sessionId?: string }[];
    scores?: number[];
  };
}

export async function pruneGraphNode(nodeId: string, sessionId?: string) {
  const res = await apiClient.post(`/api/graph/prune`, { nodeId, sessionId });
  return res.data;
}

export async function renameGraphNode(oldName: string, newName: string, sessionId?: string) {
  const res = await apiClient.post(`/api/graph/rename-node`, { oldName, newName, sessionId });
  return res.data;
}

export async function deleteGraphEdge(source: string, target: string, relation: string, sessionId?: string) {
  const res = await apiClient.post(`/api/graph/delete-edge`, { source, target, relation, sessionId });
  return res.data;
}

export type EmbeddingProvider = "ollama" | "openai-compatible" | "gemini";

export interface EmbeddingSettings {
  providers: EmbeddingProvider[];
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dimension: number;
  /** The key itself never leaves the backend — only whether one is stored. */
  apiKeySet: boolean;
  apiKeyHint: string;
}

export async function fetchSettings() {
  const res = await apiClient.get("/api/settings");
  return res.data as {
    ollamaReachable: boolean;
    availableModels: string[];
    activeEmbeddingModel: string;
    activeExtractionModel: string;
    contextMode: string;
    embedding: EmbeddingSettings;
    index: { provider: string; model: string; dimension: number; stale: boolean } | null;
  };
}

export async function updateSettings(data: {
  activeEmbeddingModel?: string;
  activeExtractionModel?: string;
  contextMode?: string;
  embeddingProvider?: EmbeddingProvider;
  embeddingBaseUrl?: string;
  /** Omit to keep the stored key; empty string clears it. */
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}) {
  const res = await apiClient.post("/api/settings", data);
  return res.data as { success: boolean; embedding: EmbeddingSettings; reindexRequired: boolean };
}

export async function testEmbeddingProvider() {
  const res = await apiClient.post("/api/settings/embedding/test");
  return res.data as {
    success: boolean;
    provider: string;
    model: string;
    dimension: number;
    expectedDimension: number;
    latencyMs: number;
  };
}

export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
  dimension?: number;
  embedding: boolean;
}

/**
 * Credentials go in the body so a key can be browsed with before it is saved.
 * Omitted fields fall back to whatever the backend already has stored.
 */
export async function listProviderModels(body: {
  provider?: EmbeddingProvider;
  baseUrl?: string;
  apiKey?: string;
}) {
  const res = await apiClient.post("/api/settings/embedding/models", body);
  return res.data as { success: boolean; provider: EmbeddingProvider; models: ProviderModel[] };
}

export async function reindexEmbeddings() {
  const res = await apiClient.post("/api/rag/reindex");
  return res.data;
}

// ── Memories ─────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  importance: number;
  category: string;
  unitType: string;
  labels: string[];
  tags: string[];
  claimStatus: string;
  evolvesFromId?: string;
  evolvesRelation?: string;
  isLatest: boolean;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelation {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  relationType: string;
  reason?: string;
  strength: number;
  confidence: number;
  bidirectional: boolean;
  status: string;
}

export async function fetchMemories(params: {
  sessionId?: string;
  query?: string;
  category?: string;
  importance?: string;
  includeSuperseded?: boolean;
}) {
  const res = await apiClient.get("/api/memories", {
    params: {
      ...params,
      includeSuperseded: params.includeSuperseded ? "true" : undefined
    }
  });
  return res.data as { success: boolean; memories: Memory[] };
}

export async function fetchMemoryChain(id: string) {
  const res = await apiClient.get(`/api/memories/${id}/chain`);
  return res.data as {
    success: boolean;
    chain: { id: string; title: string; content: string; isLatest: boolean; evolvesRelation?: string; createdAt: string }[];
    position: number;
    totalVersions: number;
  };
}

export async function fetchMemoryRelations(id: string) {
  const res = await apiClient.get(`/api/memories/${id}/relations`);
  return res.data as { success: boolean; relations: MemoryRelation[] };
}

export async function deleteMemory(id: string) {
  const res = await apiClient.delete(`/api/memories/${id}`);
  return res.data;
}

// ── Working memory ───────────────────────────────────────────────────

export interface WorkingMemory {
  sessionId: string;
  briefing: string;
  focusAreas: string[];
  activeDecisions: string[];
  blockers: string[];
  lastGeneratedAt: string;
  updatedAt: string;
}

/** Null when the project has no briefing recorded yet — a 404, not an error. */
export async function fetchWorkingMemory(sessionId: string): Promise<WorkingMemory | null> {
  try {
    const res = await apiClient.get(`/api/working-memory/${sessionId}`);
    return res.data.workingMemory as WorkingMemory;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

export async function saveWorkingMemory(sessionId: string, data: Partial<WorkingMemory>) {
  const res = await apiClient.post(`/api/working-memory/${sessionId}`, data);
  return res.data as { success: boolean; workingMemory: WorkingMemory };
}

export async function mergeSessions(sourceId: string, targetId: string) {
  const res = await apiClient.post("/api/session/merge", { sourceId, targetId });
  return res.data;
}

export { extractErrorMessage, apiClient };
