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

export interface IMemoryStore {
  createMemory(memory: Partial<Memory> & { content: string; sessionId: string }): Promise<Memory>;
  getMemories(sessionId?: string, filters?: { importance?: string | number; category?: string; query?: string; unitType?: string; limit?: number }): Promise<Memory[]>;
  getMemory(id: string): Promise<Memory | null>;
  updateMemory(id: string, update: Partial<Memory>): Promise<Memory | null>;
  deleteMemory(id: string): Promise<boolean>;

  // Working Memory
  getWorkingMemory(sessionId: string): Promise<WorkingMemory | null>;
  saveWorkingMemory(workingMemory: Partial<WorkingMemory> & { sessionId: string }): Promise<WorkingMemory>;
}
