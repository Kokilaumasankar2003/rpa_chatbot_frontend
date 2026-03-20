import { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:8002";

// ── New agent-based workflow endpoints ──────────────────────────────────────
const EP_ANALYZE = `${API_BASE}/workflow/analyze`;
const EP_LOGIN   = `${API_BASE}/workflow/login`;
const EP_ASK     = `${API_BASE}/workflow/ask`;
const EP_STATUS  = `${API_BASE}/workflow/status`;
const EP_SESSION_END = `${API_BASE}/session/end`;
const EP_MANUAL_LOGIN = `${API_BASE}/session/manual-login`;

axios.defaults.withCredentials = true;

const isProbablyUrl = (v) => /^https?:\/\/\S+$/i.test((v || "").trim());

const parseError = (err) => {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (detail && typeof detail === "object")
    return { status, message: detail.message || "Request failed.", authTypes: detail.auth_types || [], requiredFields: detail.required_fields || [] };
  return { status, message: typeof detail === "string" ? detail : "Server error.", authTypes: [], requiredFields: [] };
};

const SESSION_MS = 3 * 60 * 60 * 1000;

const EMPTY_CREDS = { email:"", username:"", password:"", otp:"", pin:"", verification_code:"" };
const FIELD_LABELS = {
  email: "Email Address", username: "Username", password: "Password",
  otp: "One-Time Password (OTP)", pin: "PIN", verification_code: "Verification Code",
};
const FIELD_TYPES = {
  email: "email", username: "text", password: "password",
  otp: "text", pin: "text", verification_code: "text",
};

const formatPreviewBlock = (preview) => {
  const text = (preview || "").trim();
  if (!text) return "";
  return `**Extracted content preview:**\n\n\`\`\`\n${text}\n\`\`\``;
};

// ── Session Timer ────────────────────────────────────────────────────────────
function SessionTimer({ startTime }) {
  const [rem, setRem] = useState(SESSION_MS);
  useEffect(() => {
    if (!startTime) return;
    const tick = () => setRem(Math.max(0, SESSION_MS - (Date.now() - startTime)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [startTime]);
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  const pct = (rem / SESSION_MS) * 100;
  const col = pct > 50 ? "#00ff9d" : pct > 20 ? "#ffb800" : "#ff4545";
  return (
    <div className="session-timer">
      <div className="timer-label">SESSION EXPIRES IN</div>
      <div className="timer-value" style={{ color: col }}>
        {String(h).padStart(2,"0")}:{String(m).padStart(2,"0")}:{String(s).padStart(2,"0")}
      </div>
      <div className="timer-bar-track">
        <div className="timer-bar-fill" style={{ width:`${pct}%`, background:col }} />
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [urlInput,    setUrlInput]    = useState("");
  const [question,    setQuestion]    = useState("");
  const [sessionId,   setSessionId]   = useState("");
  const [sessionStart,setSessionStart]= useState(null);
  const [activeUrl,   setActiveUrl]   = useState("");
  const [messages,    setMessages]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [phase,       setPhase]       = useState("idle"); // idle|analyzing|authing|chatting|blocked
  const [authRequired,setAuthRequired]= useState(false);
  const [requiredFields,setRequiredFields] = useState([]);
  const [authTypes,   setAuthTypes]   = useState([]);
  const [contentChars,setContentChars]= useState(0);
  const [creds, setCreds] = useState(() => ({ ...EMPTY_CREDS }));
  const [error, setError] = useState("");
  const [urlLocked, setUrlLocked] = useState(false);
  const msgEnd = useRef(null);
  const [manualLoginRequired, setManualLoginRequired] = useState(false);
  const [manualLoginMessage, setManualLoginMessage] = useState("");
  const [manualOpened, setManualOpened] = useState(false);
  const resetCreds = useCallback(() => setCreds({ ...EMPTY_CREDS }), []);
  const resetManualState = useCallback(() => {
    setManualLoginRequired(false);
    setManualLoginMessage("");
    setManualOpened(false);
  }, []);

  useEffect(() => { msgEnd.current?.scrollIntoView({ behavior:"smooth" }); }, [messages, loading]);

  useEffect(() => {
    if (!sessionId) return;
    const h = () => navigator.sendBeacon(EP_SESSION_END,
      new Blob([JSON.stringify({ session_id: sessionId })], { type:"application/json" }));
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [sessionId]);

  const addMsg = (role, content) =>
    setMessages(p => [...p, { role, content, ts: Date.now() }]);

  const saveSession = (sid) => {
    if (sid && !sessionId) { setSessionId(sid); setSessionStart(Date.now()); }
  };

  // ── ANALYZE ────────────────────────────────────────────────────────────────
  const handleAnalyze = useCallback(async (overrideUrl) => {
    const url = (overrideUrl || urlInput).trim();
    if (!url) return;
    setError(""); setLoading(true); setPhase("analyzing"); setUrlLocked(true);
    resetCreds();
    resetManualState();
    addMsg("system", `🔍 Opening → ${url}`);

    try {
      const resp = await axios.get(EP_ANALYZE, { params: { url } });
      const d = resp.data;
      saveSession(d.session_id);

      if (d.status === "manual_login_required") {
        setManualLoginRequired(true);
        setManualLoginMessage(d.message || "SSO login detected; automated login is blocked. Authenticate manually in a browser and click Continue.");
        setAuthRequired(false);
        setPhase("blocked");
        setUrlLocked(false);
        return;
      }

      if (d.status === "needs_credentials") {
        setActiveUrl(d.final_url || url);
        setAuthRequired(true);
        setAuthTypes(d.auth_types || []);
        setRequiredFields(d.required_fields?.length ? d.required_fields : ["username","password"]);
        setPhase("authing");
        const fields = (d.required_fields?.length ? d.required_fields : ["username","password"])
          .map(f => FIELD_LABELS[f] || f).join(", ");
        addMsg("assistant",
          `🔐 **Authentication Required**\n\n` +
          `**Type:** \`${(d.auth_types||[]).join(", ") || "login"}\`\n\n` +
          `**Please enter:** ${fields}\n\n` +
          `Fill in the credentials panel and click **Submit**.`
        );
      } else if (d.status === "ok") {
        setActiveUrl(d.final_url || url);
        setContentChars(d.content_chars || 0);
        setPhase("chatting");
        resetManualState();
        const previewBlock = formatPreviewBlock(d.content_preview);
        const chars = d.content_chars || 0;
        const qual  = chars > 3000 ? "✅" : chars > 300 ? "⚠️" : "🔴";
        addMsg("assistant",
          `${qual} **${d.message}**\n\n` +
          (chars < 500
            ? `> ⚠️ **Low content detected.** This site likely uses bot-protection or heavy JS rendering. ` +
              `I'll answer using what was captured + general knowledge about this site type.\n\n` +
              `> 💡 For better results, try a **specific product/article page** instead of the homepage.`
              + (previewBlock ? `\n\n${previewBlock}` : "")
            : (previewBlock
                ? `${previewBlock}\n\nAsk me anything about this page!`
                : `Ask me anything about this page!`))
        );
      } else {
        addMsg("system", `❌ ${d.message || "Failed to analyze URL."}`);
        setPhase("idle"); setUrlLocked(false);
        setError(d.message);
      }
    } catch (err) {
      const e = parseError(err);
      setError(e.message);
      addMsg("system", `❌ ${e.message}`);
      setPhase("idle"); setUrlLocked(false);
    } finally {
      setLoading(false);
    }
  }, [urlInput, sessionId, resetCreds, resetManualState]);

  const handleManualContinue = useCallback(async () => {
    if (!activeUrl || loading) return;
    setError("");
    try {
      await axios.post(EP_MANUAL_LOGIN);
      resetManualState();
      await handleAnalyze(activeUrl);
    } catch (err) {
      const e = parseError(err);
      setError(e.message);
      addMsg("system", `✘ ${e.message}`);
    }
  }, [activeUrl, handleAnalyze, loading, resetManualState]);

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!activeUrl || loading) return;
    setError(""); setLoading(true);
    resetManualState();
    try {
      const payload = { url: activeUrl };
      if (creds.email.trim())             payload.email             = creds.email.trim();
      if (creds.username.trim())          payload.username          = creds.username.trim();
      if (creds.password)                 payload.password          = creds.password;
      if (creds.otp.trim())              payload.otp               = creds.otp.trim();
      if (creds.pin.trim())              payload.pin               = creds.pin.trim();
      if (creds.verification_code.trim()) payload.verification_code = creds.verification_code.trim();

      const resp = await axios.post(EP_LOGIN, payload);
      const d = resp.data;
        saveSession(d.session_id);

        if (d.status === "manual_login_required") {
          setManualLoginRequired(true);
          setManualLoginMessage(d.message || "SSO login detected; automated login is blocked. Authenticate manually in a browser and click Continue.");
          setAuthRequired(false);
          setPhase("blocked");
          setUrlLocked(false);
          return;
        }

        if (d.status === "ok") {
        setAuthRequired(false); setRequiredFields([]); setAuthTypes([]);
        setPhase("chatting"); setContentChars(d.content_chars || 0);
        setCreds({ ...EMPTY_CREDS });
        resetManualState();
        const previewBlock = formatPreviewBlock(d.content_preview);
        addMsg("assistant", `✅ **${d.message}**\n\nYou're logged in! Ask me anything about this page.`);

      } else if (d.status === "needs_2fa") {
        setRequiredFields(d.required_fields || []);
        setAuthTypes(d.auth_types || []);
        setCreds(p => ({ ...p, password:"", otp:"", pin:"", verification_code:"" }));
        const fl = (d.required_fields || []).map(f => FIELD_LABELS[f]||f).join(", ");
        addMsg("assistant", `🔑 **${d.message}**\n\nPlease enter: **${fl}**`);

      } else if (d.status === "blocked") {
        setPhase("blocked"); setAuthRequired(false);
        addMsg("assistant",
          `🚫 **Login Blocked**\n\n${d.message}\n\n` +
          `**What to try:**\n- Use a URL with simple username/password login\n` +
          `- Avoid homepages of major sites (Amazon, Google, GitHub)\n- Reset session and try a different page`
        );
      } else {
        addMsg("assistant", `❌ **${d.message}**\n\nPlease check your credentials and try again.`);
      }
    } catch (err) {
      const e = parseError(err);
      setError(e.message);
      addMsg("system", `❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // ── ASK ────────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const q = question.trim();
    if (!q || loading || authRequired) return;

    if (!activeUrl && isProbablyUrl(urlInput.trim())) {
      addMsg("user", q);
      setQuestion("");
      await handleAnalyze(urlInput.trim());
      return;
    }
    if (!activeUrl) { setError("Enter a URL and click Analyze URL first."); return; }

    addMsg("user", q);
    setQuestion(""); setError(""); setLoading(true);

    try {
      const resp = await axios.post(EP_ASK, { question: q, url: activeUrl });
      const d = resp.data;
      saveSession(d.session_id);
      if (d.status === "ok") {
        addMsg("assistant", d.answer);
      } else if (d.status === "needs_credentials") {
        setAuthRequired(true);
        setAuthTypes(d.auth_types||[]);
        setRequiredFields(d.required_fields?.length ? d.required_fields : ["username","password"]);
        setPhase("authing");
        addMsg("assistant","🔐 **Session requires credentials.** Please fill in the form and submit.");
      } else {
        addMsg("system", `❌ ${d.message || "Something went wrong."}`);
        setError(d.message);
      }
    } catch (err) {
      const e = parseError(err);
      setError(e.message);
      addMsg("system", `❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── RESET ──────────────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (sessionId) { try { await axios.post(EP_SESSION_END, { session_id: sessionId }); } catch {} }
    setSessionId(""); setSessionStart(null); setActiveUrl(""); setMessages([]);
    setQuestion(""); setUrlInput(""); setError(""); setLoading(false); setPhase("idle");
    setAuthRequired(false); setAuthTypes([]); setRequiredFields([]); setContentChars(0);
    resetCreds();
    resetManualState();
    setUrlLocked(false);
  };

  const fieldsToShow = requiredFields.length > 0 ? requiredFields : ["username","password"];
  const canSend = question.trim().length > 0 && !loading && !authRequired
    && (!!activeUrl || isProbablyUrl(urlInput.trim()));

  const phaseLabel = { idle:"STANDBY", analyzing:"SCANNING", authing:"AUTH REQ", chatting:"ACTIVE", blocked:"BLOCKED" }[phase] || "STANDBY";
  const phaseColor = { idle:"#4a5568", analyzing:"#ffb800", authing:"#ff4545", chatting:"#00ff9d", blocked:"#ff4545" }[phase];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;700;800&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        :root{
          --bg:#0a0c10;--panel:#0f1117;--panel2:#141720;
          --border:#1e2330;--border2:#252b3b;
          --text:#c8d3e8;--dim:#4a5568;--muted:#6b7a99;
          --accent:#00e5ff;--accent2:#7c3aed;
          --green:#00ff9d;--yellow:#ffb800;--red:#ff4545;
          --font:'JetBrains Mono',monospace;--display:'Syne',sans-serif;
        }
        body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;overflow-x:hidden;}
        body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
          background:radial-gradient(ellipse 80% 40% at 20% 0%,rgba(0,229,255,.04) 0%,transparent 60%),
                     radial-gradient(ellipse 60% 30% at 80% 100%,rgba(124,58,237,.06) 0%,transparent 60%);}
        .shell{position:relative;z-index:1;display:grid;grid-template-columns:260px 1fr;height:100vh;overflow:hidden;}

        /* SIDEBAR */
        .sidebar{background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
        .logo{padding:20px 18px 16px;border-bottom:1px solid var(--border);}
        .logo-row{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
        .logo-icon{width:30px;height:30px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;}
        .logo-name{font-family:var(--display);font-weight:800;font-size:1rem;color:#fff;}
        .logo-sub{font-size:.6rem;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;}
        .sb-section{padding:14px 18px;border-bottom:1px solid var(--border);}
        .sb-title{font-size:.6rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;}
        .url-box{width:100%;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--font);font-size:.71rem;padding:8px 10px;resize:none;line-height:1.5;transition:border-color .2s;}
        .url-box:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,229,255,.1);}
        .url-box:disabled{opacity:.45;cursor:not-allowed;}
        .analyze-btn{width:100%;margin-top:8px;padding:9px;background:linear-gradient(135deg,rgba(0,229,255,.12),rgba(124,58,237,.12));border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-family:var(--font);font-size:.7rem;font-weight:700;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
        .analyze-btn:hover:not(:disabled){background:linear-gradient(135deg,rgba(0,229,255,.22),rgba(124,58,237,.22));}
        .analyze-btn:disabled{opacity:.35;cursor:not-allowed;}
        .status-block{display:flex;flex-direction:column;gap:7px;}
        .st-row{display:flex;align-items:center;justify-content:space-between;font-size:.67rem;}
        .st-key{color:var(--muted);}
        .st-val{font-weight:700;font-size:.62rem;letter-spacing:.06em;padding:2px 7px;border-radius:4px;}
        .active-url{font-size:.62rem;color:var(--accent);word-break:break-all;line-height:1.4;margin-top:6px;padding:6px 8px;background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.12);border-radius:6px;}
        .chars-bar{margin-top:6px;}
        .chars-label{font-size:.58rem;color:var(--muted);margin-bottom:3px;}
        .chars-track{height:3px;background:var(--border2);border-radius:2px;overflow:hidden;}
        .chars-fill{height:100%;border-radius:2px;transition:width .4s ease;}
        .sb-bottom{margin-top:auto;padding:14px 18px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px;}
        .reset-btn{width:100%;padding:8px;background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--muted);font-family:var(--font);font-size:.68rem;font-weight:600;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
        .reset-btn:hover:not(:disabled){border-color:var(--red);color:var(--red);background:rgba(255,69,69,.05);}
        .reset-btn:disabled{opacity:.35;cursor:not-allowed;}
        .session-timer{text-align:center;}
        .timer-label{font-size:.57rem;letter-spacing:.14em;color:var(--muted);margin-bottom:4px;}
        .timer-value{font-family:var(--font);font-size:1.05rem;font-weight:700;letter-spacing:.1em;margin-bottom:5px;}
        .timer-bar-track{height:2px;background:var(--border2);border-radius:1px;overflow:hidden;}
        .timer-bar-fill{height:100%;border-radius:1px;transition:width 1s linear,background 1s ease;}

        /* MAIN */
        .main{display:flex;flex-direction:column;overflow:hidden;}
        .topbar{padding:12px 22px;border-bottom:1px solid var(--border);background:var(--panel);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px;}
        .tb-url{font-size:.73rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
        .tb-url span{color:var(--accent);}
        .sb-badge{font-size:.6rem;letter-spacing:.1em;padding:3px 9px;border-radius:4px;font-weight:700;flex-shrink:0;}
        .sb-badge.active{background:rgba(0,255,157,.1);border:1px solid rgba(0,255,157,.3);color:var(--green);}
        .sb-badge.none{background:rgba(74,85,104,.15);border:1px solid rgba(74,85,104,.3);color:var(--dim);}

        /* AGENT PIPELINE INDICATOR */
        .pipeline{padding:10px 22px;background:rgba(0,229,255,.03);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0;flex-shrink:0;overflow-x:auto;}
        .step{display:flex;align-items:center;gap:0;}
        .step-box{font-size:.58rem;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:4px;white-space:nowrap;transition:all .3s;}
        .step-box.done{background:rgba(0,255,157,.1);border:1px solid rgba(0,255,157,.3);color:var(--green);}
        .step-box.active{background:rgba(255,184,0,.15);border:1px solid rgba(255,184,0,.4);color:var(--yellow);animation:pulse-step 1.2s ease infinite;}
        .step-box.pending{background:var(--panel2);border:1px solid var(--border2);color:var(--dim);}
        .step-arrow{color:var(--border2);font-size:.7rem;padding:0 4px;}
        @keyframes pulse-step{0%,100%{opacity:.7;}50%{opacity:1;}}

        /* AUTH PANEL */
        .auth-panel{padding:14px 22px;background:rgba(255,69,69,.04);border-bottom:2px solid rgba(255,69,69,.2);flex-shrink:0;}
        .auth-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
        .auth-icon{width:22px;height:22px;background:rgba(255,69,69,.15);border:1px solid rgba(255,69,69,.4);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;}
        .auth-title{font-family:var(--display);font-size:.78rem;font-weight:700;color:var(--red);letter-spacing:.06em;}
        .auth-tag{font-size:.6rem;color:var(--muted);background:rgba(255,69,69,.08);border:1px solid rgba(255,69,69,.15);border-radius:4px;padding:2px 7px;margin-left:auto;}
        .fields-note{font-size:.65rem;color:var(--yellow);margin-bottom:10px;}
        .fields-note strong{color:#fff;}
        .cred-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:12px;}
        .cred-field{display:flex;flex-direction:column;gap:4px;}
        .cred-label{font-size:.58rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700;}
        .cred-input{background:var(--panel2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--font);font-size:.75rem;padding:8px 10px;transition:border-color .2s;}
        .cred-input:focus{outline:none;border-color:rgba(255,69,69,.6);box-shadow:0 0 0 2px rgba(255,69,69,.1);}
        .cred-input:disabled{opacity:.45;}
        .submit-btn{padding:9px 18px;background:rgba(255,69,69,.15);border:1px solid var(--red);border-radius:8px;color:var(--red);font-family:var(--font);font-size:.7rem;font-weight:700;letter-spacing:.12em;cursor:pointer;transition:all .2s;}
        .submit-btn:hover:not(:disabled){background:rgba(255,69,69,.25);}
        .submit-btn:disabled{opacity:.35;cursor:not-allowed;}
          .captcha-warn{margin-top:10px;font-size:.63rem;color:var(--yellow);padding:7px 10px;background:rgba(255,184,0,.07);border:1px solid rgba(255,184,0,.2);border-radius:6px;line-height:1.5;}
          .manual-panel{padding:16px 22px;background:rgba(0,112,255,.08);border:1px solid rgba(0,112,255,.2);border-radius:10px;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;}
          .manual-title{font-size:.68rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);}
          .manual-body{font-size:.78rem;color:var(--text);line-height:1.6;}
          .manual-actions{display:flex;gap:10px;flex-wrap:wrap;}
          .manual-btn{padding:8px 14px;border-radius:8px;border:1px solid rgba(0,112,255,.6);background:radial-gradient(circle at top right,rgba(0,112,255,.4),rgba(0,0,0,0));color:var(--accent);font-weight:700;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
          .manual-btn.secondary{background:linear-gradient(135deg,rgba(124,58,237,.16),rgba(0,229,255,.16));border-color:rgba(124,58,237,.45);color:#fff;}
          .manual-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3);}

        /* MESSAGES */
        .msgs{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:var(--border2) transparent;}
        .msgs::-webkit-scrollbar{width:3px;}
        .msgs::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
        .empty{margin:auto;text-align:center;max-width:380px;}
        .empty-icon{font-size:2.8rem;margin-bottom:14px;display:block;}
        .empty-title{font-family:var(--display);font-size:1.3rem;font-weight:800;color:#fff;margin-bottom:8px;letter-spacing:-.02em;}
        .empty-desc{font-size:.76rem;color:var(--muted);line-height:1.7;}
        .step-list{list-style:none;margin-top:14px;display:flex;flex-direction:column;gap:8px;text-align:left;}
        .step-item{display:flex;align-items:flex-start;gap:10px;font-size:.71rem;color:var(--muted);}
        .step-num{width:20px;height:20px;background:rgba(0,229,255,.08);border:1px solid rgba(0,229,255,.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:700;color:var(--accent);flex-shrink:0;}
        .msg{display:flex;flex-direction:column;gap:3px;animation:msg-in .22s ease;}
        @keyframes msg-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
        .msg-user{align-items:flex-end;} .msg-assistant{align-items:flex-start;} .msg-system{align-items:center;}
        .msg-meta{font-size:.57rem;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;display:flex;align-items:center;gap:5px;}
        .msg-dot{width:5px;height:5px;border-radius:50%;}
        .msg-user .msg-dot{background:var(--accent2);}
        .msg-assistant .msg-dot{background:var(--accent);}
        .msg-system .msg-dot{background:var(--dim);}
        .bubble{max-width:min(720px,92%);padding:11px 15px;border-radius:12px;font-size:.81rem;line-height:1.65;word-break:break-word;}
        .msg-user .bubble{background:#1a1040;border:1px solid #3b1fa8;border-bottom-right-radius:4px;color:#d4c8f8;}
        .msg-assistant .bubble{background:var(--panel2);border:1px solid var(--border2);border-bottom-left-radius:4px;}
        .msg-system .bubble{background:#0d1520;border:1px solid #1e3050;border-radius:8px;color:var(--muted);font-size:.7rem;padding:7px 14px;max-width:100%;text-align:center;}
        .bubble p{margin-bottom:7px;} .bubble p:last-child{margin-bottom:0;}
        .bubble h1,.bubble h2,.bubble h3{margin-bottom:7px;font-size:.92rem;color:#e2e8f0;}
        .bubble ul,.bubble ol{margin:5px 0 7px 18px;} .bubble li{margin:3px 0;}
        .bubble strong{color:var(--accent);font-weight:700;}
        .bubble code{background:rgba(0,229,255,.08);color:var(--accent);border-radius:4px;padding:1px 5px;font-size:.87em;}
        .bubble pre{background:#070910;border:1px solid var(--border);border-radius:8px;padding:10px;overflow-x:auto;margin:7px 0;}
        .bubble pre code{background:transparent;color:#a8d8f0;padding:0;}
        .bubble a{color:var(--accent);}
        .bubble blockquote{border-left:3px solid var(--accent2);padding-left:10px;color:var(--muted);margin:6px 0;}
        .thinking{display:flex;align-items:center;gap:10px;font-size:.7rem;color:var(--muted);padding:8px 0;}
        .dots{display:flex;gap:4px;}
        .dot{width:5px;height:5px;border-radius:50%;background:var(--accent);animation:dp 1.2s ease infinite;}
        .dot:nth-child(2){animation-delay:.2s;} .dot:nth-child(3){animation-delay:.4s;}
        @keyframes dp{0%,80%,100%{opacity:.2;transform:scale(.8);}40%{opacity:1;transform:scale(1);}}

        /* COMPOSER */
        .composer{padding:12px 22px 16px;border-top:1px solid var(--border);background:var(--panel);flex-shrink:0;display:flex;flex-direction:column;gap:8px;}
        .cmp-row{display:flex;gap:10px;align-items:flex-end;}
        .cmp-area{flex:1;background:var(--panel2);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-family:var(--font);font-size:.81rem;padding:10px 14px;resize:none;line-height:1.5;transition:border-color .2s;}
        .cmp-area:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,229,255,.08);}
        .cmp-area:disabled{opacity:.4;}
        .send-btn{padding:10px 18px;background:linear-gradient(135deg,rgba(0,229,255,.18),rgba(124,58,237,.18));border:1px solid var(--accent);border-radius:10px;color:var(--accent);font-family:var(--font);font-size:.73rem;font-weight:700;letter-spacing:.1em;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0;}
        .send-btn:hover:not(:disabled){background:linear-gradient(135deg,rgba(0,229,255,.28),rgba(124,58,237,.28));box-shadow:0 0 10px rgba(0,229,255,.18);}
        .send-btn:disabled{opacity:.3;cursor:not-allowed;}
        .hint{font-size:.6rem;color:var(--dim);letter-spacing:.05em;}
        .err-bar{padding:8px 22px;background:rgba(255,69,69,.08);border-top:1px solid rgba(255,69,69,.2);font-size:.7rem;color:var(--red);flex-shrink:0;}
      `}</style>

      <div className="shell">
        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="logo">
            <div className="logo-row">
              <div className="logo-icon">🌐</div>
              <div className="logo-name">WebAgent AI</div>
            </div>
            <div className="logo-sub">Ollama · Playwright · FastAPI</div>
          </div>

          <div className="sb-section">
            <div className="sb-title">Target URL</div>
            <textarea className="url-box" rows={3}
              placeholder="https://example.com"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              disabled={loading || urlLocked}
            />
            <button className="analyze-btn"
              onClick={() => handleAnalyze()}
              disabled={loading || !urlInput.trim() || urlLocked}
            >
              {loading && phase === "analyzing" ? "[ SCANNING... ]" : "[ ANALYZE URL ]"}
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-title">Status</div>
            <div className="status-block">
              <div className="st-row">
                <span className="st-key">AGENT</span>
                <span className="st-val" style={{
                  background:`${phaseColor}18`, border:`1px solid ${phaseColor}44`, color:phaseColor
                }}>{phaseLabel}</span>
              </div>
              <div className="st-row">
                <span className="st-key">SESSION</span>
                <span className="st-val" style={sessionId
                  ? {background:"rgba(0,255,157,.1)",border:"1px solid rgba(0,255,157,.3)",color:"var(--green)"}
                  : {background:"#1a2030",border:"1px solid #252b3b",color:"var(--muted)"}
                }>{sessionId ? "LIVE" : "NONE"}</span>
              </div>
              {activeUrl && <div className="active-url">{activeUrl}</div>}
              {contentChars > 0 && (
                <div className="chars-bar">
                  <div className="chars-label">
                    Content: {contentChars.toLocaleString()} chars
                    {contentChars < 500 ? " ⚠️ sparse" : contentChars > 5000 ? " ✅ rich" : " 🟡 partial"}
                  </div>
                  <div className="chars-track">
                    <div className="chars-fill" style={{
                      width:`${Math.min(100,(contentChars/40000)*100)}%`,
                      background: contentChars < 500 ? "var(--red)" : contentChars > 5000 ? "var(--green)" : "var(--yellow)"
                    }}/>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="sb-bottom">
            {sessionId && <SessionTimer startTime={sessionStart} />}
            <button className="reset-btn" onClick={handleReset} disabled={loading}>↺ RESET SESSION</button>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          {/* Topbar */}
          <div className="topbar">
            <div className="tb-url">
              {activeUrl
                ? <><span style={{color:"var(--dim)"}}>// </span><span>{activeUrl}</span></>
                : <span style={{color:"var(--dim)"}}>// No target loaded</span>}
            </div>
            <span className={`sb-badge ${sessionId ? "active":"none"}`}>
              {sessionId ? `SID: ${sessionId.slice(0,8)}…` : "NO SESSION"}
            </span>
          </div>

          {/* Agent Pipeline */}
          <div className="pipeline">
            {[
              { label:"1. OPEN URL",   done: phase!=="idle",             active: phase==="analyzing" },
              { label:"2. AUTH CHECK", done: ["authing","chatting","blocked"].includes(phase), active: false },
              { label:"3. LOGIN",      done: phase==="chatting",          active: phase==="authing"   },
              { label:"4. EXTRACT",    done: phase==="chatting" && contentChars > 0, active: false },
              { label:"5. QA",         done: false,                       active: phase==="chatting"  },
            ].map((s, i, arr) => (
              <div key={i} className="step">
                <div className={`step-box ${s.done?"done":s.active?"active":"pending"}`}>{s.label}</div>
                {i < arr.length-1 && <span className="step-arrow">→</span>}
              </div>
            ))}
          </div>

          {/* Auth Panel */}
            {authRequired && !manualLoginRequired && (
              <div className="auth-panel">
                <div className="auth-hdr">
                  <div className="auth-icon">🔐</div>
                  <div className="auth-title">AUTHENTICATION REQUIRED</div>
                  <div className="auth-tag">{authTypes.length > 0 ? authTypes.join(" · ") : "login"}</div>
                </div>
                <div className="fields-note">
                  Please provide: <strong>{fieldsToShow.map(f=>FIELD_LABELS[f]||f).join(", ")}</strong>
                </div>
                <div className="cred-grid">
                  {fieldsToShow.map(field => (
                    <div key={field} className="cred-field">
                      <label className="cred-label">{FIELD_LABELS[field]||field}</label>
                      <input className="cred-input"
                        type={FIELD_TYPES[field]||"text"}
                        value={creds[field]||""}
                        onChange={e => setCreds(p=>({...p,[field]:e.target.value}))}
                        disabled={loading}
                        placeholder={FIELD_LABELS[field]||field}
                        autoComplete={field==="password"?"new-password":"off"}
                        onKeyDown={e=>{ if(e.key==="Enter") handleLogin(); }}
                      />
                    </div>
                  ))}
                </div>
                <button className="submit-btn" onClick={handleLogin} disabled={loading}>
                  {loading ? "[ LOGGING IN... ]" : "[ SUBMIT CREDENTIALS ]"}
                </button>
                {(authTypes.includes("sso")||authTypes.includes("captcha")) && (
                  <div className="captcha-warn">
                    ⚠ SSO / CAPTCHA detected — automated login is blocked. Try a site with simple username/password login.
                  </div>
                )}
              </div>
            )}

            {manualLoginRequired && (
              <div className="manual-panel">
                <div className="manual-title">SSO / Protected login detected</div>
                <div className="manual-body">
                  {manualLoginMessage || "Automated login is blocked for this site. Open the login page in your browser, complete the SSO/MFA flow, then click Continue below once the session is authenticated."}
                </div>
                <div className="manual-actions">
                  {activeUrl && (
                    <button
                      className="manual-btn"
                      onClick={() => {
                        window.open(activeUrl, "_blank");
                        setManualOpened(true);
                      }}
                    >
                      OPEN LOGIN PAGE
                    </button>
                  )}
                  {activeUrl && (
                    <button
                      className="manual-btn secondary"
                      onClick={handleManualContinue}
                      disabled={loading || !manualOpened}
                    >
                      CONTINUE AFTER LOGIN
                    </button>
                  )}
                </div>
              </div>
            )}

          {/* Messages */}
          <div className="msgs">
            {messages.length === 0 ? (
              <div className="empty">
                <span className="empty-icon">⬡</span>
                <div className="empty-title">AI Web Agent</div>
                <div className="empty-desc">
                  Scrape any webpage — public or login-protected — and ask questions using AI.
                </div>
                <ol className="step-list">
                  {[
                    "Paste a URL in the sidebar → click Analyze URL",
                    "System opens page & checks for authentication",
                    "Enter credentials if login is required",
                    "Content is extracted & stored in your session",
                    "Ask questions — AI answers from page content",
                    "Session auto-expires in 3 hours",
                  ].map((s,i) => (
                    <li key={i} className="step-item">
                      <span className="step-num">{i+1}</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : messages.map((msg,i) => (
              <div key={i} className={`msg msg-${msg.role}`}>
                <div className="msg-meta">
                  <span className="msg-dot"/>
                  {msg.role==="user"?"YOU":msg.role==="system"?"SYSTEM":"AI"}
                  <span style={{marginLeft:4,opacity:.5}}>
                    {new Date(msg.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
                  </span>
                </div>
                <div className="bubble">
                  {msg.role==="assistant"
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    : msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="thinking">
                <div className="dots">
                  <div className="dot"/><div className="dot"/><div className="dot"/>
                </div>
                {phase==="analyzing"?"Opening page & scanning…":phase==="authing"?"Authenticating…":"Generating answer…"}
              </div>
            )}
            <div ref={msgEnd}/>
          </div>

          {/* Composer */}
          <div className="composer">
            <div className="cmp-row">
              <textarea className="cmp-area"
                placeholder={
                  authRequired ? "Complete authentication above to continue…"
                  : phase==="idle" ? "Enter a URL, click Analyze URL, then ask questions…"
                  : "Ask anything about this page…"
                }
                value={question}
                onChange={e=>setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={3}
                disabled={loading||authRequired}
              />
              <button className="send-btn" onClick={handleSend} disabled={!canSend}>
                {loading?"…":"SEND ↵"}
              </button>
            </div>
            <div className="hint">↵ Enter to send · Shift+↵ newline · Session auto-expires in 3h · Follow-up questions remember context</div>
          </div>

          {error && <div className="err-bar">⚠ {error}</div>}
        </main>
      </div>
    </>
  );
}

