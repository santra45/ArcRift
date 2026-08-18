import React, { useEffect, useState } from "react";
import { extractErrorMessage, fetchWorkingMemory, saveWorkingMemory, type WorkingMemory } from "../api/ArcRift";
import type { Session } from "../types";

interface WorkingMemoryViewProps {
  activeSession: Session | null;
}

const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border-main)",
  borderRadius: "16px",
  backdropFilter: "var(--surface-blur)"
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 16px",
  borderRadius: "10px",
  fontSize: "13px",
  lineHeight: 1.6,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--border-main)",
  color: "white",
  outline: "none",
  resize: "vertical",
  fontFamily: "inherit"
};

/** The API stores these as arrays; the editor works in one-per-line text. */
const toLines = (values: string[]) => values.join("\n");
const fromLines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);

interface ListFieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}

const ListField: React.FC<ListFieldProps> = ({ label, hint, value, onChange }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
    <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>{label}</label>
    <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.4, margin: 0 }}>{hint}</p>
    <textarea rows={4} value={value} onChange={e => onChange(e.target.value)} style={fieldStyle} placeholder="One per line" />
  </div>
);

const WorkingMemoryView: React.FC<WorkingMemoryViewProps> = ({ activeSession }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [briefing, setBriefing] = useState("");
  const [focusAreas, setFocusAreas] = useState("");
  const [activeDecisions, setActiveDecisions] = useState("");
  const [blockers, setBlockers] = useState("");
  const [original, setOriginal] = useState({ briefing: "", focusAreas: "", activeDecisions: "", blockers: "" });

  const apply = (wm: WorkingMemory | null) => {
    const next = {
      briefing: wm?.briefing || "",
      focusAreas: toLines(wm?.focusAreas || []),
      activeDecisions: toLines(wm?.activeDecisions || []),
      blockers: toLines(wm?.blockers || [])
    };
    setBriefing(next.briefing);
    setFocusAreas(next.focusAreas);
    setActiveDecisions(next.activeDecisions);
    setBlockers(next.blockers);
    setOriginal(next);
    setLastUpdated(wm?.updatedAt || null);
  };

  useEffect(() => {
    if (!activeSession) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchWorkingMemory(activeSession._id)
      .then(wm => { if (!cancelled) apply(wm); })
      .catch(err => { if (!cancelled) setError(`Failed to load working memory: ${extractErrorMessage(err)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [activeSession?._id]);

  const dirty =
    briefing !== original.briefing ||
    focusAreas !== original.focusAreas ||
    activeDecisions !== original.activeDecisions ||
    blockers !== original.blockers;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { workingMemory } = await saveWorkingMemory(activeSession._id, {
        briefing,
        focusAreas: fromLines(focusAreas),
        activeDecisions: fromLines(activeDecisions),
        blockers: fromLines(blockers)
      });
      apply(workingMemory);
      setSuccess("Briefing saved.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(`Failed to save working memory: ${extractErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!activeSession) {
    return (
      <div style={{ maxWidth: "800px", margin: "100px auto 40px auto", padding: "0 24px" }}>
        <div style={{ ...cardStyle, padding: "48px", textAlign: "center", color: "var(--text-secondary)" }}>
          <p style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>No project selected</p>
          <p style={{ fontSize: "13px" }}>Working memory is recorded per project. Pick one from the sidebar.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "40px", color: "var(--text-secondary)" }}>
        <div className="processing-dot" style={{ width: "16px", height: "16px", marginBottom: "16px" }} />
        <span>Loading briefing…</span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "800px", margin: "100px auto 40px auto", padding: "0 24px" }}>
      <div style={{ ...cardStyle, padding: "32px", marginBottom: "24px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%)" }} />
        <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", marginBottom: "4px" }}>
          Working Memory
        </h1>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
          The standing briefing for {activeSession.projectName}. Assistants read this through{" "}
          <code style={{ color: "var(--primary)", background: "rgba(249, 115, 22, 0.08)", padding: "1px 4px", borderRadius: "3px" }}>get_working_memory</code>{" "}
          before they start work.
        </p>
        {lastUpdated && (
          <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "10px" }}>
            Last updated {new Date(lastUpdated).toLocaleString()}
          </p>
        )}
      </div>

      <form onSubmit={handleSave} style={{ ...cardStyle, padding: "32px", display: "flex", flexDirection: "column", gap: "28px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>Executive Briefing</label>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.4, margin: 0 }}>
            What someone joining this project today would need to know first.
          </p>
          <textarea rows={6} value={briefing} onChange={e => setBriefing(e.target.value)} style={fieldStyle} />
        </div>

        <ListField
          label="Current Focus Areas"
          hint="What is actively being worked on right now."
          value={focusAreas}
          onChange={setFocusAreas}
        />
        <ListField
          label="Active Decisions"
          hint="Architectural and design choices that are settled and should be followed."
          value={activeDecisions}
          onChange={setActiveDecisions}
        />
        <ListField
          label="Known Blockers"
          hint="Gotchas and obstacles worth knowing before touching this code."
          value={blockers}
          onChange={setBlockers}
        />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-main)", paddingTop: "24px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {error && <span style={{ color: "var(--danger)", fontSize: "13px", fontWeight: 600 }}>{error}</span>}
            {success && <span style={{ color: "var(--success)", fontSize: "13px", fontWeight: 600 }}>{success}</span>}
            {!error && !success && dirty && (
              <span style={{ color: "var(--primary)", fontSize: "12px", fontWeight: 500 }}>Unsaved changes detected.</span>
            )}
          </div>

          <button
            type="submit"
            disabled={!dirty || saving}
            style={{
              padding: "12px 28px",
              borderRadius: "10px",
              fontSize: "14px",
              fontWeight: 700,
              cursor: dirty && !saving ? "pointer" : "not-allowed",
              background: dirty ? "var(--primary)" : "rgba(255,255,255,0.05)",
              color: dirty ? "white" : "var(--text-dim)",
              border: dirty ? "1px solid transparent" : "1px solid var(--border-dim)",
              boxShadow: dirty ? "0 0 15px var(--primary-glow)" : "none",
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)"
            }}
          >
            {saving ? "Saving…" : "Save Briefing"}
          </button>
        </div>
      </form>
    </div>
  );
};

export default WorkingMemoryView;
