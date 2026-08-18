import React, { useCallback, useEffect, useState } from "react";
import {
  deleteMemory,
  extractErrorMessage,
  fetchMemories,
  fetchMemoryChain,
  fetchMemoryRelations,
  type Memory,
  type MemoryRelation
} from "../api/ArcRift";
import type { Session } from "../types";

interface MemoriesViewProps {
  activeSession: Session | null;
}

const CATEGORIES = ["Architecture", "Decision", "Gotcha", "Rule", "Tech", "Note"];

// Mirrors the level names the MCP tools take, so the filter reads the same way
// the memory was written. The backend treats these as a lower bound.
const IMPORTANCE_FILTERS = [
  { value: "", label: "Any importance" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High and above" },
  { value: "medium", label: "Medium and above" },
  { value: "low", label: "Low and above" }
];

function importanceColor(score: number): string {
  if (score >= 0.9) return "var(--danger)";
  if (score >= 0.7) return "var(--primary)";
  if (score >= 0.4) return "var(--text-secondary)";
  return "var(--text-dim)";
}

function importanceLabel(score: number): string {
  if (score >= 0.9) return "CRITICAL";
  if (score >= 0.7) return "HIGH";
  if (score >= 0.4) return "MEDIUM";
  return "LOW";
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border-main)",
  borderRadius: "16px",
  backdropFilter: "var(--surface-blur)"
};

const inputStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "10px",
  fontSize: "13px",
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--border-main)",
  color: "white",
  outline: "none"
};

const MemoriesView: React.FC<MemoriesViewProps> = ({ activeSession }) => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [importance, setImportance] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const [selected, setSelected] = useState<Memory | null>(null);
  const [chain, setChain] = useState<Awaited<ReturnType<typeof fetchMemoryChain>> | null>(null);
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMemories({
        sessionId: activeSession?._id,
        query: query.trim() || undefined,
        category: category || undefined,
        importance: importance || undefined,
        includeSuperseded
      });
      setMemories(data.memories || []);
    } catch (err) {
      setError(`Failed to load memories: ${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [activeSession?._id, query, category, importance, includeSuperseded]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  // A memory selected under one filter can vanish under the next, which would
  // otherwise leave the detail pane showing something no longer in the list.
  useEffect(() => {
    if (selected && !memories.some(m => m.id === selected.id)) {
      setSelected(null);
    }
  }, [memories, selected]);

  useEffect(() => {
    if (!selected) {
      setChain(null);
      setRelations([]);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    Promise.all([fetchMemoryChain(selected.id), fetchMemoryRelations(selected.id)])
      .then(([chainData, relationData]) => {
        if (cancelled) return;
        setChain(chainData);
        setRelations(relationData.relations || []);
      })
      .catch(err => {
        if (!cancelled) setError(`Failed to load memory detail: ${extractErrorMessage(err)}`);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => { cancelled = true; };
  }, [selected]);

  const handleDelete = async (memory: Memory) => {
    if (!window.confirm(`Delete "${memory.title}"? Its relations are removed with it.`)) return;
    try {
      await deleteMemory(memory.id);
      setSelected(null);
      await load();
    } catch (err) {
      setError(`Failed to delete memory: ${extractErrorMessage(err)}`);
    }
  };

  return (
    <div style={{ maxWidth: "1100px", margin: "100px auto 40px auto", padding: "0 24px" }}>
      <div style={{ ...cardStyle, padding: "32px", marginBottom: "24px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%)" }} />
        <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", marginBottom: "4px" }}>
          Memories
        </h1>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
          Structured recollections saved by the MCP tools, newest revision first.
          {activeSession ? ` Scoped to ${activeSession.projectName}.` : " Across every project."}
        </p>
      </div>

      <div style={{ ...cardStyle, padding: "20px", marginBottom: "24px", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search titles and content…"
          style={{ ...inputStyle, flex: "1 1 260px" }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={importance} onChange={e => setImportance(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
          {IMPORTANCE_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={includeSuperseded} onChange={e => setIncludeSuperseded(e.target.checked)} style={{ cursor: "pointer" }} />
          Show superseded
        </label>
      </div>

      {error && (
        <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "10px", padding: "14px", marginBottom: "16px", color: "var(--danger)", fontSize: "13px", fontWeight: 600 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px", color: "var(--text-secondary)" }}>
          <div className="processing-dot" style={{ width: "16px", height: "16px", marginBottom: "16px" }} />
          <span>Loading memories…</span>
        </div>
      ) : memories.length === 0 ? (
        <div style={{ ...cardStyle, padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
          <p style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>No memories yet</p>
          <p style={{ fontSize: "13px", lineHeight: 1.5 }}>
            Memories are recorded when an assistant calls <code style={{ color: "var(--primary)", background: "rgba(249, 115, 22, 0.08)", padding: "1px 4px", borderRadius: "3px" }}>store_memory</code>.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 1fr" : "1fr", gap: "16px", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {memories.map(memory => (
              <button
                key={memory.id}
                onClick={() => setSelected(selected?.id === memory.id ? null : memory)}
                style={{
                  ...cardStyle,
                  padding: "18px 20px",
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: selected?.id === memory.id ? "var(--primary)" : "var(--border-main)",
                  opacity: memory.isLatest ? 1 : 0.55,
                  transition: "border-color 0.2s, opacity 0.2s"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", marginBottom: "6px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>{memory.title}</span>
                  <span style={{ fontSize: "10px", fontWeight: 800, letterSpacing: "0.05em", color: importanceColor(memory.importance), flexShrink: 0 }}>
                    {importanceLabel(memory.importance)}
                  </span>
                </div>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: "10px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {memory.content}
                </p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", fontSize: "11px" }}>
                  <span style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--border-dim)", borderRadius: "6px", padding: "2px 8px", color: "var(--text-secondary)", fontWeight: 600 }}>
                    {memory.category}
                  </span>
                  {!memory.isLatest && (
                    <span style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--border-dim)", borderRadius: "6px", padding: "2px 8px", color: "var(--text-dim)", fontWeight: 600 }}>
                      superseded
                    </span>
                  )}
                  {memory.tags.slice(0, 4).map(tag => (
                    <span key={tag} style={{ color: "var(--text-dim)" }}>#{tag}</span>
                  ))}
                  <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>
                    {new Date(memory.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <div style={{ ...cardStyle, padding: "24px", position: "sticky", top: "100px", display: "flex", flexDirection: "column", gap: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                <h2 style={{ fontSize: "18px", fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>{selected.title}</h2>
                <button onClick={() => setSelected(null)} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "20px", lineHeight: 1, padding: 0 }}>×</button>
              </div>

              <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0 }}>
                {selected.content}
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: "12px" }}>
                <span style={{ color: "var(--text-dim)" }}>Importance</span>
                <span style={{ color: importanceColor(selected.importance), fontWeight: 700 }}>
                  {importanceLabel(selected.importance)} ({selected.importance.toFixed(2)})
                </span>
                <span style={{ color: "var(--text-dim)" }}>Type</span>
                <span style={{ color: "var(--text-secondary)" }}>{selected.unitType}</span>
                <span style={{ color: "var(--text-dim)" }}>Claim</span>
                <span style={{ color: "var(--text-secondary)" }}>{selected.claimStatus}</span>
                <span style={{ color: "var(--text-dim)" }}>Source</span>
                <span style={{ color: "var(--text-secondary)" }}>{selected.source || "unknown"}</span>
              </div>

              {detailLoading ? (
                <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>Loading history…</span>
              ) : (
                <>
                  {chain && chain.totalVersions > 1 && (
                    <div>
                      <h3 style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)", marginBottom: "10px" }}>
                        Revisions ({chain.totalVersions})
                      </h3>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {chain.chain.map((rev, i) => (
                          <div
                            key={rev.id}
                            style={{
                              background: "rgba(0,0,0,0.2)",
                              border: `1px solid ${rev.id === selected.id ? "var(--primary)" : "var(--border-dim)"}`,
                              borderRadius: "8px",
                              padding: "10px 12px"
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "2px" }}>
                              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)" }}>
                                v{i + 1} · {rev.title}
                              </span>
                              {rev.isLatest && <span style={{ fontSize: "10px", fontWeight: 800, color: "var(--success)" }}>CURRENT</span>}
                            </div>
                            {rev.evolvesRelation && (
                              <span style={{ fontSize: "11px", color: "var(--text-dim)" }}>{rev.evolvesRelation} the previous revision</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {relations.length > 0 && (
                    <div>
                      <h3 style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)", marginBottom: "10px" }}>
                        Relations ({relations.length})
                      </h3>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {relations.map(rel => (
                          <div key={rel.id} style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", gap: "8px", alignItems: "center" }}>
                            <span style={{ color: "var(--primary)", fontWeight: 700 }}>
                              {rel.sourceMemoryId === selected.id ? "→" : "←"} {rel.relationType}
                            </span>
                            <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {rel.reason || (rel.sourceMemoryId === selected.id ? rel.targetMemoryId : rel.sourceMemoryId)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <button
                onClick={() => handleDelete(selected)}
                style={{ alignSelf: "flex-start", padding: "8px 16px", borderRadius: "8px", fontSize: "12px", fontWeight: 700, background: "transparent", color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)", cursor: "pointer" }}
              >
                Delete memory
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MemoriesView;
