import { WindowChunk } from "./chunker";

export interface Session {
  _id: string;
  projectName: string;
  platform: string;
  summary?: string;
  tripleCount: number;
  hasFullChat: boolean;
  topicCount: number;
  externalChatId?: string;
  tokensSaved?: number;
  retrievalCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FullChat {
  sessionId: string;
  rawText: string;
  processedText?: string; // v1.4.7: Track what has already been extracted for triples
  messageCount: number;
  platform: string;
  createdAt: Date;
}

export interface Job {
  _id: string;
  type: "triple_extraction";
  payload: any;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  deadLettered: boolean;
  failedAt?: Date;
  error?: string;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Triple {
  subject: string;
  subjectType: string;
  relation: string;
  object: string;
  objectType: string;
  sessionId: string;
  timestamp: string;
}

export interface RetrievedChunk {
  chunkIndex: number;
  content: string;
  score: number;
  engines?: string[];
  /** Set by global search so results can say which project they came from. */
  sessionId?: string;
  [key: string]: any;
}

export interface ISessionStore {
  // Session
  createSession(projectName: string, platform: string, externalChatId?: string, customId?: string): Promise<Session>;
  getSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  getSessionByName(projectName: string): Promise<Session | null>;
  getSessionByExternalId(externalChatId: string): Promise<Session | null>;
  updateSession(id: string, update: Partial<Session>): Promise<void>;
  deleteSession(id: string): Promise<void>;
  mergeSession(sourceId: string, targetId: string): Promise<void>;

  // Active Session
  getActiveSessionId(): Promise<string | null>;
  setActiveSessionId(sessionId: string | null): Promise<void>;

  // Full Chat
  saveFullChat(sessionId: string, rawText: string, messageCount: number, platform: string): Promise<void>;
  updateFullChat(sessionId: string, update: Partial<FullChat>): Promise<void>;
  getFullChat(sessionId: string): Promise<FullChat | null>;

  // Jobs
  createJob(type: string, payload: any): Promise<Job>;
  getNextJob(): Promise<Job | null>;
  updateJob(id: string, update: Partial<Job>): Promise<void>;
  getJobStatus(): Promise<{ pending: number; processing: number; deadLettered: number }>;
  getJobStatusBySession(sessionId: string): Promise<{ pending: number; processing: number; deadLettered: number }>;
  resetGhostJobs(): Promise<void>;
  clearJobs(): Promise<void>;
}

export interface IGraphStore {
  saveTriple(triple: Triple): Promise<void>;
  getTripleCountBySession(sessionId: string): Promise<number>;
  getTriplesBySession(sessionId: string): Promise<Triple[]>;
  getGraphData(filters: { sessionId?: string; type?: string; relation?: string; limit?: number }): Promise<{ nodes: any[]; links: any[] }>;
  findRelatedTriples(entities: string[], sessionId: string): Promise<Triple[]>;
  findRelatedTriplesGlobal(entities: string[]): Promise<Triple[]>;
  deleteTriples(entities: string[], sessionId: string): Promise<number>;
  renameNode(oldName: string, newName: string, sessionId?: string): Promise<number>;
  deleteEdge(source: string, target: string, relation: string, sessionId?: string): Promise<number>;
  mergeSession(sourceId: string, targetId: string): Promise<void>;
}

export interface IVectorStore {
  storeChunks(chunks: WindowChunk[]): Promise<void>;
  storeFileChunks(chunks: WindowChunk[]): Promise<void>;
  retrieveRelevantChunks(query: string, sessionId: string, topN?: number, keywords?: string[]): Promise<RetrievedChunk[]>;
  retrieveGlobalChunks(query: string, topN?: number, keywords?: string[]): Promise<RetrievedChunk[]>;
  hybridSearch(query: string, sessionId: string, topN?: number): Promise<RetrievedChunk[]>;
  deleteChunksBySession(sessionId: string): Promise<void>;
  deleteChunksByFile(filePath: string, sessionId: string): Promise<number>;
  deleteChunksByQuery(query: string, sessionId: string): Promise<number>;
  mergeSession(sourceId: string, targetId: string): Promise<void>;
}

export type MemoryCategory = "Architecture" | "Decision" | "Gotcha" | "Rule" | "Tech" | "Note";

export interface Memory {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  /** 0–1. Stored as a REAL so memories can be ordered and thresholded. */
  importance: number;
  category: MemoryCategory;
  unitType: "fact" | "preference" | "decision" | "plan" | "procedure" | "learning" | "context" | "event";
  labels: string[];
  /** Same list as `labels` — both names are accepted on write and returned on read. */
  tags: string[];
  claimStatus?: "asserted" | "explored" | "proposed" | "planned" | "unverified" | "deprecated" | "disputed";
  evolvesFromId?: string;
  evolvesRelation?: "replaces" | "enriches" | "confirms" | "challenges";
  isLatest?: boolean;
  source?: string;
  sourceApp?: string;
  temporalContext?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkingMemory {
  sessionId: string;
  briefing: string;
  focusAreas: string[];
  activeDecisions: string[];
  blockers: string[];
  lastGeneratedAt: Date;
  updatedAt: Date;
}

/** A typed link from one memory to another, e.g. "replaces" or "caused_by". */
export interface MemoryRelation {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  relationType: string;
  reason?: string;
  strength: number;
  confidence: number;
  bidirectional: boolean;
  status: "active" | "suggested";
  createdAt: Date;
  updatedAt: Date;
}

/** One step of an evolution chain, as returned by getEvolutionChain. */
export interface MemoryRevision {
  id: string;
  title: string;
  unitType: string;
  isLatest: boolean;
  createdAt: string;
  evolvesFromId?: string;
  evolvesRelation?: string;
}

export interface IMemoryStore {
  createMemory(memory: Partial<Memory> & { content: string; sessionId: string }): Promise<Memory>;
  /** Returns only the latest revision of each claim unless `includeSuperseded` is set. */
  getMemories(sessionId?: string, filters?: { importance?: string | number; category?: string; query?: string; unitType?: string; limit?: number; includeSuperseded?: boolean }): Promise<Memory[]>;
  getMemory(id: string): Promise<Memory | null>;
  updateMemory(id: string, update: Partial<Memory>): Promise<Memory | null>;
  deleteMemory(id: string): Promise<boolean>;

  // Memory Relations
  addRelation(relation: {
    sourceMemoryId: string;
    targetMemoryId: string;
    relationType: string;
    reason?: string;
    strength?: number;
    confidence?: number;
    bidirectional?: boolean;
    status?: "active" | "suggested";
  }): Promise<MemoryRelation>;
  listRelations(memoryId: string, options?: { direction?: "out" | "in" | "both"; relationTypes?: string[]; status?: string; limit?: number }): Promise<MemoryRelation[]>;
  deleteRelation(relationId: string): Promise<boolean>;

  // Memory Evolution
  getEvolutionChain(memoryId: string, maxDepth?: number): Promise<{ chain: MemoryRevision[]; position: number; totalVersions: number }>;
  supersedeMemory(oldMemoryId: string, newMemoryId: string, reason?: string): Promise<{
    status: string;
    oldMemory: { id: string; isLatest: boolean };
    newMemory: { id: string; isLatest: boolean; evolvesFromId: string };
  }>;

  // Working Memory
  getWorkingMemory(sessionId: string): Promise<WorkingMemory | null>;
  saveWorkingMemory(workingMemory: Partial<WorkingMemory> & { sessionId: string }): Promise<WorkingMemory>;
}
