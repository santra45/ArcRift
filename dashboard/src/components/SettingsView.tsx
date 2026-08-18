import React, { useEffect, useState, useMemo } from "react";
import {
  fetchSettings,
  updateSettings,
  extractErrorMessage,
  fetchSessions,
  testEmbeddingProvider,
  reindexEmbeddings,
  type EmbeddingProvider,
  type EmbeddingSettings,
  type ProviderModel
} from "../api/ArcRift";
import ModelPickerModal from "./ModelPickerModal";

// Applied when switching provider, so the previous provider's endpoint does not
// linger in the form and get saved against a backend that cannot use it.
const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { baseUrl: string; model: string }> = {
  ollama: { baseUrl: "http://localhost:11434", model: "nomic-embed-text" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-embedding-001" }
};

const PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible",
  gemini: "Google Gemini"
};

const PROVIDER_HINTS: Record<EmbeddingProvider, string> = {
  ollama: "Runs on this machine. No key needed, nothing leaves the host.",
  "openai-compatible": "Any endpoint speaking the OpenAI embeddings API — OpenAI itself, SiliconFlow, or a local gateway.",
  gemini: "Google's hosted embedding models. Requires an API key."
};

const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"config" | "providers" | "analytics">("config");
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [ollamaReachable, setOllamaReachable] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [activeEmbeddingModel, setActiveEmbeddingModel] = useState("nomic-embed-text");
  const [activeExtractionModel, setActiveExtractionModel] = useState("llama3.1:8b");
  const [contextMode, setContextMode] = useState<"raw" | "summarized">("raw");

  const [originalSettings, setOriginalSettings] = useState({
    embedding: "nomic-embed-text",
    extraction: "llama3.1:8b",
    contextMode: "raw",
  });

  const [saving, setSaving] = useState(false);

  // Embedding provider config. The key is write-only: the backend sends back a
  // hint, never the value, so an untouched field must not be submitted.
  const [embedding, setEmbedding] = useState<EmbeddingSettings | null>(null);
  const [provider, setProvider] = useState<EmbeddingProvider>("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [dimension, setDimension] = useState(768);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [indexState, setIndexState] = useState<{ provider: string; model: string; stale: boolean } | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [reindexing, setReindexing] = useState(false);

  /**
   * Switching provider carries nothing over. Keeping the old base URL meant
   * pointing Gemini at a local Ollama port, which only surfaced as a confusing
   * failure much later.
   */
  const handleProviderChange = (next: EmbeddingProvider) => {
    setProvider(next);
    setTestResult(null);
    if (embedding && next === embedding.provider) {
      setBaseUrl(embedding.baseUrl);
      setEmbeddingModel(embedding.model);
    } else {
      setBaseUrl(PROVIDER_DEFAULTS[next].baseUrl);
      setEmbeddingModel(PROVIDER_DEFAULTS[next].model);
    }
  };

  const handleModelPicked = (model: ProviderModel) => {
    setEmbeddingModel(model.id);
    // Some providers pin a width; adopting it avoids saving a request the
    // model cannot satisfy.
    if (model.dimension) setDimension(model.dimension);
    setTestResult(null);
  };

  const applyEmbedding = (next: EmbeddingSettings) => {
    setEmbedding(next);
    setProvider(next.provider);
    setBaseUrl(next.baseUrl);
    setEmbeddingModel(next.model);
    setDimension(next.dimension);
    setApiKey("");
    setApiKeyTouched(false);
  };

  const loadSettingsData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSettings();
      setOllamaReachable(data.ollamaReachable);
      setAvailableModels(data.availableModels);
      setActiveEmbeddingModel(data.activeEmbeddingModel);
      setActiveExtractionModel(data.activeExtractionModel);
      const fetchedMode = data.contextMode === "summarized" ? "summarized" : "raw";
      setContextMode(fetchedMode);
      setOriginalSettings({
        embedding: data.activeEmbeddingModel,
        extraction: data.activeExtractionModel,
        contextMode: fetchedMode,
      });

      if (data.embedding) applyEmbedding(data.embedding);
      setIndexState(data.index);

      const sessionData = await fetchSessions();
      setSessions(sessionData.sessions || []);
    } catch (err) {
      setError(`Failed to load settings: ${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettingsData();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await updateSettings({
        activeEmbeddingModel,
        activeExtractionModel,
        contextMode,
      });
      setOriginalSettings({
        embedding: activeEmbeddingModel,
        extraction: activeExtractionModel,
        contextMode,
      });
      setSuccessMessage("Configuration saved successfully!");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(`Failed to save settings: ${extractErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const providerDirty =
    !!embedding &&
    (provider !== embedding.provider ||
      baseUrl !== embedding.baseUrl ||
      embeddingModel !== embedding.model ||
      dimension !== embedding.dimension ||
      apiKeyTouched);

  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    setTestResult(null);
    try {
      const result = await updateSettings({
        embeddingProvider: provider,
        embeddingBaseUrl: baseUrl,
        embeddingModel,
        embeddingDimension: dimension,
        // Leaving the field alone must not wipe the stored key.
        ...(apiKeyTouched ? { embeddingApiKey: apiKey } : {})
      });
      applyEmbedding(result.embedding);
      setSuccessMessage(
        result.reindexRequired
          ? "Provider saved. The existing index was built with different settings — rebuild it before searching."
          : "Provider saved."
      );
      const refreshed = await fetchSettings();
      setIndexState(refreshed.index);
    } catch (err) {
      setError(`Failed to save provider: ${extractErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestProvider = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testEmbeddingProvider();
      const mismatch = result.dimension !== result.expectedDimension;
      setTestResult({
        ok: !mismatch,
        message: mismatch
          ? `Reached ${result.model}, but it returned ${result.dimension} dimensions and the index holds ${result.expectedDimension}.`
          : `${result.model} responded in ${result.latencyMs}ms with ${result.dimension} dimensions.`
      });
    } catch (err) {
      setTestResult({ ok: false, message: extractErrorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleReindex = async () => {
    if (!window.confirm("Re-embed every stored chunk with the current provider? This can take a while on a large project.")) return;
    setReindexing(true);
    setError(null);
    try {
      await reindexEmbeddings();
      const refreshed = await fetchSettings();
      setIndexState(refreshed.index);
      setSuccessMessage("Index rebuilt with the current provider.");
    } catch (err) {
      setError(`Reindex failed: ${extractErrorMessage(err)}`);
    } finally {
      setReindexing(false);
    }
  };

  const hasUnsavedChanges =
    activeEmbeddingModel !== originalSettings.embedding ||
    activeExtractionModel !== originalSettings.extraction ||
    contextMode !== originalSettings.contextMode;

  const totalTokensSaved = useMemo(() => sessions.reduce((sum, s) => sum + (s.tokensSaved || 0), 0), [sessions]);
  const totalRetrievals = useMemo(() => sessions.reduce((sum, s) => sum + (s.retrievalCount || 0), 0), [sessions]);
  const costSaved = ((totalTokensSaved / 1000000) * 3.00).toFixed(4);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "40px", color: "var(--text-secondary)" }}>
        <div className="processing-dot" style={{ width: "16px", height: "16px", marginBottom: "16px" }} />
        <span>Loading system configurations...</span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "800px", margin: "100px auto 40px auto", padding: "0 24px" }}>
      {pickerOpen && (
        <ModelPickerModal
          provider={provider}
          baseUrl={baseUrl}
          // Only pass a key the user just typed; otherwise the backend uses the
          // one it already holds, which never reaches the browser.
          apiKey={apiKeyTouched ? apiKey : ""}
          currentModel={embeddingModel}
          onSelect={handleModelPicked}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* Header Card */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border-main)", borderRadius: "16px", backdropFilter: "var(--surface-blur)", padding: "32px", marginBottom: "24px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
          <div>
            <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", marginBottom: "4px" }}>
              System Settings
            </h1>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
              Configure active models for local embeddings generation and knowledge graph relationship extraction.
            </p>
          </div>
          <button onClick={loadSettingsData} className="action-btn" title="Refresh Settings" style={{ padding: "8px" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        </div>

        {/* Ollama Status Pill */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "rgba(0,0,0,0.2)", padding: "6px 12px", borderRadius: "20px", border: "1px solid var(--border-dim)", fontSize: "12px" }}>
          <span className={`health-indicator ${ollamaReachable ? "green" : "red"}`} style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", boxShadow: ollamaReachable ? "0 0 8px #10B981" : "0 0 8px #EF4444" }} />
          <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Ollama Connection:</span>
          <span style={{ color: ollamaReachable ? "var(--success)" : "var(--danger)", fontWeight: 700 }}>
            {ollamaReachable ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "24px" }}>
        <button
          onClick={() => setActiveTab("config")}
          style={{
            padding: "10px 24px", borderRadius: "8px", fontSize: "14px", fontWeight: 600,
            background: activeTab === "config" ? "var(--primary)" : "transparent",
            color: activeTab === "config" ? "#fff" : "var(--text-secondary)",
            border: activeTab === "config" ? "1px solid transparent" : "1px solid var(--border-main)",
            cursor: "pointer", transition: "all 0.2s"
          }}
        >
          Configuration
        </button>
        <button
          onClick={() => setActiveTab("providers")}
          style={{
            padding: "10px 24px", borderRadius: "8px", fontSize: "14px", fontWeight: 600,
            background: activeTab === "providers" ? "var(--primary)" : "transparent",
            color: activeTab === "providers" ? "#fff" : "var(--text-secondary)",
            border: activeTab === "providers" ? "1px solid transparent" : "1px solid var(--border-main)",
            cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "center", gap: "8px"
          }}
        >
          Embedding Provider
          {indexState?.stale && (
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--danger)", boxShadow: "0 0 6px var(--danger)" }} />
          )}
        </button>
        <button
          onClick={() => setActiveTab("analytics")}
          style={{
            padding: "10px 24px", borderRadius: "8px", fontSize: "14px", fontWeight: 600,
            background: activeTab === "analytics" ? "var(--primary)" : "transparent",
            color: activeTab === "analytics" ? "#fff" : "var(--text-secondary)",
            border: activeTab === "analytics" ? "1px solid transparent" : "1px solid var(--border-main)",
            cursor: "pointer", transition: "all 0.2s"
          }}
        >
          Session Analytics
        </button>
      </div>

      {activeTab === "config" && (
      <form onSubmit={handleSave} style={{ background: "var(--surface)", border: "1px solid var(--border-main)", borderRadius: "16px", backdropFilter: "var(--surface-blur)", padding: "32px", display: "flex", flexDirection: "column", gap: "28px" }}>
        
        {/* Ollama Offline Warning Banner */}
        {!ollamaReachable && (
          <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "10px", padding: "16px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" style={{ flexShrink: 0, marginTop: "2px" }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
            </svg>
            <div>
              <h4 style={{ color: "var(--text-primary)", fontSize: "14px", fontWeight: 700, marginBottom: "4px" }}>Local LLM Connection Offline</h4>
              <p style={{ color: "var(--text-secondary)", fontSize: "12px", lineHeight: "1.4" }}>
                Make sure Ollama is running locally with <code style={{ color: "var(--text-primary)", background: "rgba(255,255,255,0.05)", padding: "2px 4px", borderRadius: "4px" }}>ollama serve</code> so ArcRift can query available models and process your knowledge graph locally.
              </p>
            </div>
          </div>
        )}

        {/* Embedding Model Config */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", display: "flex", justifyContent: "space-between" }}>
            <span>Text Embedding Model</span>
            <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--text-secondary)" }}>
              Recommended: <code style={{ color: "var(--primary)", background: "rgba(249, 115, 22, 0.08)", padding: "1px 4px", borderRadius: "3px" }}>nomic-embed-text</code>
            </span>
          </label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Generates vector embeddings for your project data. Used to powersemantic retrieval in the RAG pipeline.
          </p>
          <select
            className="settings-select"
            value={activeEmbeddingModel}
            onChange={(e) => setActiveEmbeddingModel(e.target.value)}
            disabled={!ollamaReachable}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none", cursor: ollamaReachable ? "pointer" : "not-allowed" }}
          >
            {!ollamaReachable ? (
              <option value="nomic-embed-text">nomic-embed-text (Fallback — Offline)</option>
            ) : availableModels.length === 0 ? (
              <option value="nomic-embed-text">nomic-embed-text (No models found)</option>
            ) : (
              availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>
        </div>

        {/* Extraction Model Config */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", display: "flex", justifyContent: "space-between" }}>
            <span>Extraction LLM Model</span>
            <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--text-secondary)" }}>
              Recommended: <code style={{ color: "var(--primary)", background: "rgba(249, 115, 22, 0.08)", padding: "1px 4px", borderRadius: "3px" }}>llama3.1:8b</code> or higher
            </span>
          </label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Powers the precision extraction pipeline. Summarizes chats, identifies key developer decisions, and builds entity relationships.
          </p>
          <select
            className="settings-select"
            value={activeExtractionModel}
            onChange={(e) => setActiveExtractionModel(e.target.value)}
            disabled={!ollamaReachable}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none", cursor: ollamaReachable ? "pointer" : "not-allowed" }}
          >
            {!ollamaReachable ? (
              <option value="llama3.1:8b">llama3.1:8b (Fallback — Offline)</option>
            ) : availableModels.length === 0 ? (
              <option value="llama3.1:8b">llama3.1:8b (No models found)</option>
            ) : (
              availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>
        </div>

        {/* Context Mode Config */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", display: "flex", justifyContent: "space-between" }}>
            <span>Context Injection Mode</span>
          </label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Controls how memory chunks are injected into your RAG queries. <strong>Raw</strong> is faster and exact. <strong>Summarized</strong> reduces token consumption for large context windows.
          </p>
          <select
            className="settings-select"
            value={contextMode}
            onChange={(e) => setContextMode(e.target.value as "raw" | "summarized")}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none", cursor: "pointer" }}
          >
            <option value="raw">Raw Chunks (Fast & High Fidelity)</option>
            <option value="summarized">Summarized Context (Token Efficient & Cohesive)</option>
          </select>
        </div>

        {/* Action Panel */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-main)", paddingTop: "24px", marginTop: "8px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {error && <span style={{ color: "var(--danger)", fontSize: "13px", fontWeight: 600 }}>{error}</span>}
            {successMessage && <span style={{ color: "var(--success)", fontSize: "13px", fontWeight: 600 }}>{successMessage}</span>}
            {!error && !successMessage && hasUnsavedChanges && (
              <span style={{ color: "var(--primary)", fontSize: "12px", fontWeight: 500 }}>Unsaved changes detected.</span>
            )}
          </div>

          <button
            type="submit"
            disabled={!hasUnsavedChanges || saving}
            style={{
              padding: "12px 28px",
              borderRadius: "10px",
              fontSize: "14px",
              fontWeight: 700,
              cursor: hasUnsavedChanges && !saving ? "pointer" : "not-allowed",
              background: hasUnsavedChanges ? "var(--primary)" : "rgba(255,255,255,0.05)",
              color: hasUnsavedChanges ? "white" : "var(--text-dim)",
              border: hasUnsavedChanges ? "1px solid transparent" : "1px solid var(--border-dim)",
              boxShadow: hasUnsavedChanges ? "0 0 15px var(--primary-glow)" : "none",
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
              transform: hasUnsavedChanges && !saving ? "scale(1.02)" : "scale(1)"
            }}
          >
            {saving ? "Saving Changes..." : "Save Configuration"}
          </button>
        </div>
      </form>
      )}

      {activeTab === "providers" && (
      <form onSubmit={handleSaveProvider} style={{ background: "var(--surface)", border: "1px solid var(--border-main)", borderRadius: "16px", backdropFilter: "var(--surface-blur)", padding: "32px", display: "flex", flexDirection: "column", gap: "28px" }}>

        {indexState?.stale && (
          <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "10px", padding: "16px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" style={{ flexShrink: 0, marginTop: "2px" }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
            </svg>
            <div style={{ flex: 1 }}>
              <h4 style={{ color: "var(--text-primary)", fontSize: "14px", fontWeight: 700, marginBottom: "4px" }}>Index does not match these settings</h4>
              <p style={{ color: "var(--text-secondary)", fontSize: "12px", lineHeight: "1.4", marginBottom: "10px" }}>
                Stored vectors were built with <strong>{indexState.model}</strong> on <strong>{indexState.provider}</strong>. Vectors from
                different models are not comparable, so search stays blocked until the index is rebuilt.
              </p>
              <button
                type="button"
                onClick={handleReindex}
                disabled={reindexing}
                style={{ padding: "8px 16px", borderRadius: "8px", fontSize: "12px", fontWeight: 700, background: "var(--danger)", color: "white", border: "1px solid transparent", cursor: reindexing ? "not-allowed" : "pointer" }}
              >
                {reindexing ? "Rebuilding…" : "Rebuild index now"}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Embedding Provider</label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            {PROVIDER_HINTS[provider]}
          </p>
          <select
            className="settings-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as EmbeddingProvider)}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none", cursor: "pointer" }}
          >
            {(embedding?.providers || ["ollama"]).map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Model</label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Browse asks the provider what it can run, so the name does not have to be typed from memory.
          </p>
          <div style={{ display: "flex", gap: "12px" }}>
            <input
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              placeholder="nomic-embed-text"
              style={{ flex: 1, padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none" }}
            />
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              style={{ padding: "12px 20px", borderRadius: "10px", fontSize: "13px", fontWeight: 700, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-main)", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Browse…
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Base URL</label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Leave as-is unless you are pointing at a self-hosted or proxied endpoint.
          </p>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none" }}
          />
        </div>

        {provider !== "ollama" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", display: "flex", justifyContent: "space-between" }}>
              <span>API Key</span>
              {embedding?.apiKeySet && !apiKeyTouched && (
                <span style={{ fontSize: "11px", fontWeight: 500, color: "var(--success)" }}>Stored: {embedding.apiKeyHint}</span>
              )}
            </label>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
              Held on this machine and never sent to the browser. Leave blank to keep the stored key.
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); }}
              placeholder={embedding?.apiKeySet ? "•••••••• (unchanged)" : "Paste your key"}
              autoComplete="off"
              style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none" }}
            />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Vector Dimension</label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: "1.4", marginBottom: "4px" }}>
            Fixed when the index was created. Changing it needs a full rebuild, and the provider must be able to return this width.
          </p>
          <input
            type="number"
            value={dimension}
            onChange={(e) => setDimension(Number(e.target.value))}
            style={{ width: "100%", padding: "12px 16px", borderRadius: "10px", fontSize: "14px", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-main)", color: "white", outline: "none" }}
          />
        </div>

        {testResult && (
          <div style={{ background: testResult.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)", border: `1px solid ${testResult.ok ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)"}`, borderRadius: "10px", padding: "14px", fontSize: "13px", color: testResult.ok ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
            {testResult.message}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-main)", paddingTop: "24px", marginTop: "8px", gap: "16px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {error && <span style={{ color: "var(--danger)", fontSize: "13px", fontWeight: 600 }}>{error}</span>}
            {successMessage && <span style={{ color: "var(--success)", fontSize: "13px", fontWeight: 600 }}>{successMessage}</span>}
            {!error && !successMessage && providerDirty && (
              <span style={{ color: "var(--primary)", fontSize: "12px", fontWeight: 500 }}>Unsaved changes detected.</span>
            )}
          </div>

          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <button
              type="button"
              onClick={handleTestProvider}
              disabled={testing || providerDirty}
              title={providerDirty ? "Save your changes first — the test uses the stored configuration" : undefined}
              style={{
                padding: "12px 20px", borderRadius: "10px", fontSize: "13px", fontWeight: 700,
                background: "transparent", color: providerDirty ? "var(--text-dim)" : "var(--text-secondary)",
                border: "1px solid var(--border-main)", cursor: testing || providerDirty ? "not-allowed" : "pointer"
              }}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>

            <button
              type="submit"
              disabled={!providerDirty || saving}
              style={{
                padding: "12px 28px", borderRadius: "10px", fontSize: "14px", fontWeight: 700,
                cursor: providerDirty && !saving ? "pointer" : "not-allowed",
                background: providerDirty ? "var(--primary)" : "rgba(255,255,255,0.05)",
                color: providerDirty ? "white" : "var(--text-dim)",
                border: providerDirty ? "1px solid transparent" : "1px solid var(--border-dim)",
                boxShadow: providerDirty ? "0 0 15px var(--primary-glow)" : "none",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)"
              }}
            >
              {saving ? "Saving…" : "Save Provider"}
            </button>
          </div>
        </div>
      </form>
      )}

      {activeTab === "analytics" && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border-main)", borderRadius: "16px", backdropFilter: "var(--surface-blur)", padding: "32px", display: "flex", flexDirection: "column", gap: "28px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 800, color: "var(--text-primary)", margin: 0 }}>Global Telemetry</h2>
            <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
              ArcRift automatically reduces your AI prompt costs by contextually extracting and injecting only the precise information needed for the active turn.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
            {/* Stat Card 1 */}
            <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-dim)", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Tokens Saved</div>
              <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--primary)", lineHeight: 1 }}>{totalTokensSaved.toLocaleString()}</div>
              <div style={{ fontSize: "11px", color: "var(--text-dim)" }}>Tokens stripped from raw context</div>
            </div>

            {/* Stat Card 2 */}
            <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-dim)", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Estimated Savings</div>
              <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--success)", lineHeight: 1 }}>${costSaved}</div>
              <div style={{ fontSize: "11px", color: "var(--text-dim)" }}>Calculated at $3.00 per 1M input tokens</div>
            </div>

            {/* Stat Card 3 */}
            <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-dim)", borderRadius: "12px", padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Retrievals</div>
              <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--text-primary)", lineHeight: 1 }}>{totalRetrievals.toLocaleString()}</div>
              <div style={{ fontSize: "11px", color: "var(--text-dim)" }}>Successful context injections</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsView;
