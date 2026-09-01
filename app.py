from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from dotenv import load_dotenv
from groq import Groq

import os
import json

load_dotenv()

app = Flask(__name__)
# Sessions are just a signed cookie -- Flask needs a secret key to sign them.
# Falls back to a dev-only value locally; set a real SECRET_KEY in .env / on
# Render before this handles anything real, or every restart invalidates
# everyone's session.
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
# gpt-oss is a reasoning model: it spends some of max_tokens on hidden
# "thinking" before writing the visible reply, so keep max_tokens generous
# or short answers can come back empty.
GROQ_MODEL = "openai/gpt-oss-120b"

# --- Public Pages ---

# Word each slider position maps to, per category -- used both to render the
# saved check-in on the home dashboard and to seed the live label in the
# check-in form's JS (checkin.html reads these off data-labels attributes).
CATEGORY_LABELS = {
    "time": ["Overloaded", "Busy", "Balanced", "Manageable", "Light"],
    "social": ["Isolated", "Quiet", "Neutral", "Connected", "Very connected"],
    "physical": ["Drained", "Tired", "Okay", "Good", "Energized"],
    "mental": ["Foggy", "Distracted", "Steady", "Focused", "Sharp"],
}
DEFAULT_CHECKIN = {"time": 3, "social": 3, "physical": 4, "mental": 4, "note": ""}


def capacity_percent(checkin):
    levels = [checkin["time"], checkin["social"], checkin["physical"], checkin["mental"]]
    return round(sum(levels) / (len(levels) * 5) * 100)


@app.route("/")
def home():
    checkin = session.get("checkin", DEFAULT_CHECKIN)
    return render_template(
        "home.html",
        checkin=checkin,
        capacity=capacity_percent(checkin),
        labels=CATEGORY_LABELS,
        just_saved=request.args.get("saved") == "1",
    )

@app.route("/checkin", methods=["GET", "POST"])
def checkin():
    if request.method == "POST":
        checkin = {
            "time": int(request.form.get("time_level", 3)),
            "social": int(request.form.get("social_level", 3)),
            "physical": int(request.form.get("physical_level", 3)),
            "mental": int(request.form.get("mental_level", 3)),
            "note": request.form.get("note", "").strip(),
        }
        session["checkin"] = checkin
        return redirect(url_for("home", saved=1))

    checkin = session.get("checkin", DEFAULT_CHECKIN)
    return render_template("checkin.html", checkin=checkin, labels=CATEGORY_LABELS)

@app.route("/insights")
def insights():
    return render_template("insights.html")

@app.route("/assistant")
def assistant():
    return render_template("chat.html")

# --- Chat with memory ---

CHAT_SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You help university students manage stress and workload. "
        "Politely decline unrelated questions. "
        "This is a plain-text chat bubble, not a document -- reply in short, "
        "conversational paragraphs. Never use markdown tables, headers, or "
        "bullet-point lists; write like a text message, a few sentences at a time."
    ),
}


@app.route("/chat", methods=["POST"])
def chat():
    user_message = request.json.get("message")
    if not user_message:
        return jsonify({"error": "message is required"}), 400

    # Pull this user's history from wherever you're storing it
    # (session for quick demo, a database table for real persistence)
    history = session.get("chat_history", [])
    history.append({"role": "user", "content": user_message})

    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            max_tokens=600,
            # Send the FULL history every time, not just the latest message --
            # the model has no memory of its own between requests.
            messages=[CHAT_SYSTEM_PROMPT] + history,
        )
    except Exception as e:
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 502

    reply = response.choices[0].message.content

    history.append({"role": "assistant", "content": reply})
    session["chat_history"] = history

    return jsonify({"reply": reply})


@app.route("/chat/reset", methods=["POST"])
def chat_reset():
    session.pop("chat_history", None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=False, port=5000)
