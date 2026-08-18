import React, { useEffect, useMemo, useState } from "react";
import { extractErrorMessage, listProviderModels, type EmbeddingProvider, type ProviderModel } from "../api/ArcRift";

interface ModelPickerModalProps {
  provider: EmbeddingProvider;
  baseUrl: string;
  /** Empty when the caller wants the backend to use the key it already stores. */
  apiKey: string;
  currentModel: string;
  onSelect: (model: ProviderModel) => void;
  onClose: () => void;
}

const ModelPickerModal: React.FC<ModelPickerModalProps> = ({
  provider, baseUrl, apiKey, currentModel, onSelect, onClose
}) => {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listProviderModels({ provider, baseUrl, apiKey: apiKey || undefined })
      .then(data => {
        if (cancelled) return;
        setModels(data.models);
        // Providers list far more chat models than embedding ones. Only fall
        // back to the full list when nothing embeddable was detected.
        setShowAll(!data.models.some(m => m.embedding));
      })
      .catch(err => { if (!cancelled) setError(extractErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [provider, baseUrl, apiKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const embeddingCount = useMemo(() => models.filter(m => m.embedding).length, [models]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return models
      .filter(m => showAll || m.embedding)
      .filter(m => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  }, [models, showAll, filter]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px"
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--surface)", border: "1px solid var(--border-main)", borderRadius: "16px",
          backdropFilter: "var(--surface-blur)", width: "100%", maxWidth: "620px", maxHeight: "80vh",
          display: "flex", flexDirection: "column", overflow: "hidden"
        }}
      >
        <div style={{ padding: "24px 24px 16px 24px", borderBottom: "1px solid var(--border-main)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "12px" }}>
            <div>
              <h2 style={{ fontFamily: "'Outfit', sans-serif", fontSize: "20px", fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>
                Select a model
              </h2>
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
                {loading ? "Asking the provider what it can run…" : `${models.length} available, ${embeddingCount} can embed.`}
              </p>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "22px", lineHeight: 1, padding: 0 }}>×</button>
          </div>

          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <input
              autoFocus
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter models…"
              style={{ flex: 1, padding: "10px 14px", borderRadius: "10px", fontSize: "13px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none" }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} style={{ cursor: "pointer" }} />
              Show non-embedding
            </label>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: "16px 24px 24px 24px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px", color: "var(--text-secondary)" }}>
              <div className="processing-dot" style={{ width: "16px", height: "16px", marginBottom: "16px" }} />
              <span style={{ fontSize: "13px" }}>Loading models…</span>
            </div>
          ) : error ? (
            <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "10px", padding: "16px", color: "var(--danger)", fontSize: "13px", fontWeight: 600 }}>
              {error}
              <p style={{ color: "var(--text-secondary)", fontWeight: 400, fontSize: "12px", marginTop: "8px", lineHeight: 1.5 }}>
                {provider === "gemini"
                  ? "Paste a valid API key in the form behind this dialog, then try again."
                  : "Check the base URL and key, then try again."}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <p style={{ color: "var(--text-secondary)", fontSize: "13px", textAlign: "center", padding: "32px" }}>
              Nothing matches that filter.
            </p>
          ) : (
            visible.map(model => {
              const active = model.id === currentModel;
              return (
                <button
                  key={model.id}
                  onClick={() => { onSelect(model); onClose(); }}
                  style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: "10px", cursor: "pointer",
                    background: active ? "rgba(249, 115, 22, 0.08)" : "rgba(0,0,0,0.2)",
                    border: `1px solid ${active ? "var(--primary)" : "var(--border-dim)"}`,
                    display: "flex", flexDirection: "column", gap: "4px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{model.label}</span>
                    <span style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                      {model.embedding && (
                        <span style={{ fontSize: "9px", fontWeight: 800, letterSpacing: "0.05em", color: "var(--success)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: "4px", padding: "2px 6px" }}>
                          EMBEDDING
                        </span>
                      )}
                      {active && <span style={{ fontSize: "9px", fontWeight: 800, color: "var(--primary)" }}>CURRENT</span>}
                    </span>
                  </div>
                  {model.label !== model.id && (
                    <code style={{ fontSize: "11px", color: "var(--text-dim)" }}>{model.id}</code>
                  )}
                  {model.description && (
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {model.description}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default ModelPickerModal;
