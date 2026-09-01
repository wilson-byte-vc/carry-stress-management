from flask import Flask, render_template, request, redirect, url_for, flash, session
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from dotenv import load_dotenv
from openai import OpenAI, BadRequestError

import os
import json

load_dotenv()

app = Flask(__name__)

# Groq speaks the same API shape as OpenAI, so the OpenAI SDK works here too
# -- you just point base_url at Groq's endpoint and use a Groq API key.
client = OpenAI(
    api_key=os.environ.get("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1",
)
# gpt-oss is a reasoning model: it spends some of max_tokens on hidden
# "thinking" before writing the visible reply, so keep max_tokens generous
# or short answers can come back empty.
GROQ_MODEL = "openai/gpt-oss-120b"

# --- Public Pages ---

@app.route("/")
def home():
    return render_template("home.html")

@app.route("/checkin")
def checkin():
    return render_template("checkin.html")

@app.route("/insights")
def insights():
    return render_template("insights.html")

# --- AI demo: fundamentals ---

def ask_ai_basic(prompt):
    """The simplest possible call: send text, get text back."""
    response = client.chat.completions.create(
        model=GROQ_MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


# A "tool" is just a JSON schema describing the shape of data you want back.
# Give the model exactly one tool and force it to use that tool, and instead
# of freeform prose you get guaranteed structured JSON you can render as UI.
PRESENT_OPTIONS_TOOL = {
    "type": "function",
    "function": {
        "name": "present_options",
        "description": "Present the user with a short list of options to choose between.",
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question being asked"},
                "options": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Short option text, 1-5 words"},
                            "description": {"type": "string", "description": "One sentence explaining this option"},
                        },
                        "required": ["label", "description"],
                    },
                },
            },
            "required": ["question", "options"],
        },
    },
}


def ask_ai_choices(prompt, attempts=2):
    """Force the model to answer as structured multiple-choice options.

    Groq doesn't always honor tool_choice on the first try -- sometimes the
    model just writes a freeform answer instead, which the API then rejects
    with a 400 (tool_use_failed). Retry a couple of times before giving up.
    """
    last_error = None
    for _ in range(attempts):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                max_tokens=500,
                tools=[PRESENT_OPTIONS_TOOL],
                tool_choice={"type": "function", "function": {"name": "present_options"}},
                messages=[{"role": "user", "content": prompt}],
            )
        except BadRequestError as e:
            last_error = e
            continue

        tool_calls = response.choices[0].message.tool_calls
        if not tool_calls:
            last_error = ValueError("Model did not return a tool call")
            continue

        return json.loads(tool_calls[0].function.arguments)

    raise last_error


@app.route("/ai-demo", methods=["GET", "POST"])
def ai_demo():
    result = None
    error = None
    mode = request.form.get("mode", "basic")
    user_prompt = request.form.get("prompt", "")

    if request.method == "POST" and user_prompt:
        try:
            if mode == "choices":
                result = ask_ai_choices(user_prompt)
            else:
                result = ask_ai_basic(user_prompt)
        except Exception as e:
            error = f"{type(e).__name__}: {e}"

    return render_template("ai_demo.html", result=result, error=error, mode=mode, user_prompt=user_prompt)

if __name__ == "__main__":
    app.run(debug=False, port=5000)
