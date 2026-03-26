from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from bs4 import BeautifulSoup
import re, uuid, traceback, requests
from typing import Optional

app = FastAPI(title="Web Analyzer AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sessions = {}

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "gemma3:1b"


# ─────────────────────────────────────────────
# ASK OLLAMA
# ─────────────────────────────────────────────
def ask_ollama(system, user):
    prompt = f"{system}\n\nUser: {user}\nAssistant:"
    try:
        r = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False
            },
            timeout=120
        )
        return r.json().get("response", "").strip()
    except:
        return "⚠️ Ollama not responding"


# ─────────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────────
class ChatRequest(BaseModel):
    session_id: str
    message: str


# ─────────────────────────────────────────────
# URL DETECTION
# ─────────────────────────────────────────────
URL_RE = re.compile(r"https?://[^\s]+")

def extract_url(text):
    m = URL_RE.search(text)
    if not m:
        return None
    url = re.split(r"[,\s]+", m.group(0))[0]
    return url.rstrip(".,)\"'")


# ─────────────────────────────────────────────
# FETCH URL
# ─────────────────────────────────────────────
async def fetch_url(url):
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
            r = await c.get(url)
            return {"status": r.status_code, "html": r.text}
    except:
        return {"error": "Cannot access website"}


# ─────────────────────────────────────────────
# LOGIN DETECTION
# ─────────────────────────────────────────────
def detect_login(html, url):
    soup = BeautifulSoup(html, "html.parser")

    # password field
    if soup.find("input", {"type": "password"}):
        return "login_required"

    text = html.lower()

    keywords = ["login", "sign in", "password", "username"]
    if sum(1 for k in keywords if k in text) >= 3:
        return "login_required"

    # special cases
    if "github.com" in url:
        return "partial_login"

    if "linkedin.com" in url:
        return "login_required"

    return "public"


# ─────────────────────────────────────────────
# PARSING
# ─────────────────────────────────────────────
def get_text(html):
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "nav", "footer"]):
        t.decompose()
    return soup.get_text()[:4000]

def get_title(html):
    soup = BeautifulSoup(html, "html.parser")
    t = soup.find("title")
    return t.text if t else "Untitled"


# ─────────────────────────────────────────────
# SESSION
# ─────────────────────────────────────────────
def new_session():
    return {
        "state": "idle",
        "page": None,
        "title": None,
        "url": None
    }

def get_session(sid):
    if sid not in sessions:
        sessions[sid] = new_session()
    return sessions[sid]


# ─────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────
@app.post("/session/new")
def new_chat():
    sid = str(uuid.uuid4())
    sessions[sid] = new_session()
    return {"session_id": sid, "message": "👋 Hi! How can I help you?"}


@app.post("/chat")
async def chat(req: ChatRequest):
    try:
        sess = get_session(req.session_id)
        msg = req.message.strip()

        # ───────── URL FLOW ─────────
        url = extract_url(msg)

        if url:
            result = await fetch_url(url)

            if "error" in result:
                return {"reply": "⚠️ Cannot access website", "state": "idle"}

            html = result["html"]
            login_status = detect_login(html, url)

            title = get_title(html)
            content = get_text(html)

            sess["page"] = content
            sess["title"] = title
            sess["url"] = url
            sess["state"] = "awaiting_choice"

            # 🔥 ONLY ASK — NO ANALYSIS
            if login_status == "login_required":
                return {
                    "reply": """🔒 This site requires login.

👉 What would you like to do?

1️⃣ Provide credentials  
2️⃣ Cancel""",
                    "state": "awaiting_choice",
                }

            elif login_status == "partial_login":
                return {
                    "reply": """🌐 This site is partially public.

✅ You can view homepage without login  
🔒 Deeper access requires login  

👉 What would you like to do?

1️⃣ View homepage content  
2️⃣ Access deeper (requires login)""",
                    "state": "awaiting_choice",
                }

            else:
                return {
                    "reply": """🌐 This site is publicly accessible.

👉 Do you want me to analyze it? (yes/no)""",
                    "state": "awaiting_choice",
                }

        # ───────── HANDLE USER CHOICE ─────────
        if sess["state"] == "awaiting_choice":
            lower = msg.lower()

            # homepage
            if "1" in lower or "home" in lower or "yes" in lower:
                summary = ask_ollama(
                    "Summarize this webpage in bullet points",
                    sess["page"]
                )

                sess["state"] = "ready"

                return {
                    "reply": f"""📄 **Homepage Summary: {sess['title']}**

{summary}

🙏 Thank you! You can ask more questions.""",
                    "state": "ready",
                }

            # deeper
            elif "2" in lower or "deep" in lower or "login" in lower:
                sess["state"] = "awaiting_credentials"

                return {
                    "reply": """🔐 Please provide credentials:

username: your_email  
password: your_password""",
                    "state": "awaiting_credentials",
                }

            else:
                return {
                    "reply": "⚠️ Please choose option 1 or 2 🙂",
                    "state": "awaiting_choice",
                }

        # ───────── HANDLE CREDENTIALS ─────────
        if sess["state"] == "awaiting_credentials":
            if "username" in msg.lower() and "password" in msg.lower():
                sess["state"] = "ready"

                return {
                    "reply": """✅ Credentials received. Thank you.

(Note: Login is NOT performed — this is only for interaction)

👉 You can now continue.""",
                    "state": "ready",
                }
            else:
                return {
                    "reply": "⚠️ Please provide in format:\nusername: ... password: ...",
                    "state": "awaiting_credentials",
                }

        # ───────── Q&A MODE ─────────
        if sess["state"] == "ready" and sess["page"]:
            answer = ask_ollama(
                "Answer based on webpage content:",
                f"{sess['page']}\n\nQuestion: {msg}"
            )
            return {"reply": answer, "state": "ready"}

        # ───────── NORMAL CHAT ─────────
        answer = ask_ollama("Be helpful and conversational.", msg)
        return {"reply": answer, "state": "idle"}

    except Exception as e:
        print(traceback.format_exc())
        return {"reply": f"⚠️ Error: {str(e)}", "state": "idle"}


# ─────────────────────────────────────────────
# RUN
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("🚀 Backend running at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)