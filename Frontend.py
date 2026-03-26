import gradio as gr
import requests

BACKEND_URL = "http://localhost:8000"

# ── API helpers ─────────────────────────────────────────────

def create_session():
    resp = requests.post(f"{BACKEND_URL}/session/new", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data["session_id"], data["message"]

def send_message(session_id: str, message: str) -> dict:
    resp = requests.post(
        f"{BACKEND_URL}/chat",
        json={"session_id": session_id, "message": message},
        timeout=180,
    )
    resp.raise_for_status()
    return resp.json()

def delete_session(session_id: str):
    try:
        requests.delete(f"{BACKEND_URL}/session/{session_id}", timeout=5)
    except:
        pass

# ── FIXED: Initialize Chat ─────────────────────────────────

def initialize_chat(session_state):
    if session_state.get("session_id"):
        delete_session(session_state["session_id"])

    try:
        sid, welcome_msg = create_session()
        session_state["session_id"] = sid

        # ✅ CORRECT FORMAT (dict)
        history = [{"role": "assistant", "content": welcome_msg}]
    except:
        history = [{"role": "assistant", "content": "⚠️ Backend not connected"}]

    return session_state, history, ""

# ── FIXED: Chat Function ─────────────────────────────────

def user_submit(user_message, history, session_state):
    if not user_message.strip():
        return history, "", session_state

    sid = session_state.get("session_id")
    if not sid:
        session_state, history, _ = initialize_chat(session_state)
        sid = session_state.get("session_id")

    # ✅ Add user message
    history.append({"role": "user", "content": user_message})

    try:
        result = send_message(sid, user_message)
        reply = result.get("reply", "Sorry, I could not process that.")
    except Exception as e:
        reply = f"⚠️ Error: {str(e)}"

    # ✅ Add bot reply
    history.append({"role": "assistant", "content": reply})

    return history, "", session_state

# ── New Chat ─────────────────────────────────────────────

def new_chat(session_state):
    return initialize_chat(session_state)

# ── UI ───────────────────────────────────────────────────

with gr.Blocks(title="WebAnalyzer AI") as demo:

    session_state = gr.State({})

    gr.Markdown("## 🤖 WebAnalyzer AI")

    chatbot = gr.Chatbot(
        height=450,
        show_label=False,
        # ❗ IMPORTANT: DO NOT add type="messages"
    )

    with gr.Row():
        msg_input = gr.Textbox(
            placeholder="Type your message...",
            show_label=False,
            scale=8
        )
        send_btn = gr.Button("Send", scale=1)
        new_chat_btn = gr.Button("New Chat", scale=1)

    # ── Events ─────────────────────────────────────────

    demo.load(
        fn=initialize_chat,
        inputs=[session_state],
        outputs=[session_state, chatbot, msg_input],
    )

    send_btn.click(
        fn=user_submit,
        inputs=[msg_input, chatbot, session_state],
        outputs=[chatbot, msg_input, session_state],
    )

    msg_input.submit(
        fn=user_submit,
        inputs=[msg_input, chatbot, session_state],
        outputs=[chatbot, msg_input, session_state],
    )

    new_chat_btn.click(
        fn=new_chat,
        inputs=[session_state],
        outputs=[chatbot, msg_input, session_state],
    )

# ── Run ───────────────────────────────────────────────

if __name__ == "__main__":
    demo.launch(
        server_port=7860,
        inbrowser=True
    )