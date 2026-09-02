from functools import wraps

from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from flask_login import (
    LoginManager,
    current_user,
    login_required,
    login_user,
    logout_user,
)
from flask_migrate import Migrate
from dotenv import load_dotenv
from groq import Groq

import os

from models import CheckIn, User, db

load_dotenv()

app = Flask(__name__)
# Sessions are just a signed cookie -- Flask needs a secret key to sign them.
# Falls back to a dev-only value locally; set a real SECRET_KEY in .env / on
# Render before this handles anything real, or every restart invalidates
# everyone's session (and logs everyone out).
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")

# Render/Heroku hand out "postgres://" URLs, but SQLAlchemy 2.x only accepts
# "postgresql://". Fall back to a local SQLite file when DATABASE_URL is unset.
database_url = os.environ.get("DATABASE_URL", "sqlite:///spaceman.db")
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
migrate = Migrate(app, db)

login_manager = LoginManager(app)
login_manager.login_view = "login"
login_manager.login_message = "Please log in to continue."

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
# gpt-oss is a reasoning model: it spends some of max_tokens on hidden
# "thinking" before writing the visible reply, so keep max_tokens generous
# or short answers can come back empty.
GROQ_MODEL = "openai/gpt-oss-120b"

# The assistant is usable in demo mode, but /chat spends real Groq quota and
# sits on a public URL -- cap what one anonymous session can burn.
DEMO_CHAT_LIMIT = 10


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


@app.context_processor
def inject_demo_mode():
    """Every page can ask whether it's being viewed without an account.
    The chat limit is exposed too so the account panel quotes the real number
    instead of a hardcoded one that could drift."""
    return {
        "demo_mode": not current_user.is_authenticated,
        "demo_chat_limit": DEMO_CHAT_LIMIT,
    }


def admin_required(view):
    """Gate a route to admins only -- 404 rather than 403 so the existence of
    the admin page isn't advertised to signed-in non-admins."""

    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not current_user.is_admin:
            abort(404)
        return view(*args, **kwargs)

    return wrapped


# --- Check-in vocabulary ---

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


def current_checkin():
    """Signed-in users read their latest row; demo visitors get whatever is in
    their session cookie, so the app is fully usable without an account."""
    if current_user.is_authenticated:
        latest = current_user.latest_checkin
        return latest.as_dict() if latest else DEFAULT_CHECKIN
    return session.get("checkin", DEFAULT_CHECKIN)


def clamp_level(raw, fallback=3):
    """Slider values arrive as strings from the form and are attacker-controlled
    -- coerce to an int inside 1..5 rather than trusting them."""
    try:
        return min(5, max(1, int(raw)))
    except (TypeError, ValueError):
        return fallback


# --- Auth ---

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        display_name = request.form.get("display_name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        if not display_name or not email or not password:
            flash("All fields are required.")
        elif len(password) < 8:
            flash("Password must be at least 8 characters.")
        elif db.session.scalar(db.select(User).filter_by(email=email)):
            flash("That email is already registered. Try logging in.")
        else:
            user = User(
                display_name=display_name,
                email=email,
                # The very first account to register becomes the admin -- there's
                # no other bootstrap path into the admin page.
                is_admin=db.session.scalar(db.select(db.func.count(User.id))) == 0,
            )
            user.set_password(password)
            db.session.add(user)
            db.session.commit()
            login_user(user)
            flash(f"Welcome, {user.display_name}!")
            return redirect(url_for("home"))

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = db.session.scalar(db.select(User).filter_by(email=email))

        if user and user.check_password(password):
            login_user(user, remember=bool(request.form.get("remember")))
            flash(f"Welcome back, {user.display_name}!")
            # Only honour a relative "next" -- an absolute URL here would let a
            # crafted link bounce people to another site after login.
            next_url = request.args.get("next", "")
            if next_url.startswith("/") and not next_url.startswith("//"):
                return redirect(next_url)
            return redirect(url_for("home"))

        # Deliberately vague: don't reveal whether the email exists.
        flash("Incorrect email or password.")

    return render_template("login.html")


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    logout_user()
    session.pop("chat_history", None)
    flash("You've been logged out.")
    return redirect(url_for("login"))


# --- Settings ---

@app.route("/settings", methods=["POST"])
@login_required
def settings():
    display_name = request.form.get("display_name", "").strip()
    if display_name:
        current_user.display_name = display_name
        db.session.commit()
        flash("Preferences saved.")
    else:
        flash("Display name can't be empty.")
    return redirect(request.referrer or url_for("home"))


@app.route("/settings/theme", methods=["POST"])
@login_required
def settings_theme():
    theme = (request.json or {}).get("theme")
    if theme not in ("light", "dark"):
        return jsonify({"error": "theme must be 'light' or 'dark'"}), 400
    current_user.theme = theme
    db.session.commit()
    return jsonify({"ok": True, "theme": theme})


# --- Admin ---

@app.route("/admin")
@admin_required
def admin():
    users = db.session.scalars(db.select(User).order_by(User.created_at)).all()
    total_checkins = db.session.scalar(db.select(db.func.count(CheckIn.id)))
    return render_template(
        "admin.html",
        users=users,
        total_checkins=total_checkins,
    )


@app.route("/admin/users/<int:user_id>/toggle-admin", methods=["POST"])
@admin_required
def admin_toggle(user_id):
    user = db.get_or_404(User, user_id)
    if user.id == current_user.id:
        flash("You can't remove your own admin access.")
    else:
        user.is_admin = not user.is_admin
        db.session.commit()
        state = "now an admin" if user.is_admin else "no longer an admin"
        flash(f"{user.display_name} is {state}.")
    return redirect(url_for("admin"))


# --- App pages ---

@app.route("/")
def home():
    checkin = current_checkin()
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
        entry = {
            "time": clamp_level(request.form.get("time_level")),
            "social": clamp_level(request.form.get("social_level")),
            "physical": clamp_level(request.form.get("physical_level")),
            "mental": clamp_level(request.form.get("mental_level")),
            "note": request.form.get("note", "").strip()[:2000],
        }
        if current_user.is_authenticated:
            db.session.add(CheckIn(user_id=current_user.id, **entry))
            db.session.commit()
        else:
            # Demo mode: keep it in the session cookie. It survives navigation
            # but not a new browser -- signing up is what makes it durable.
            session["checkin"] = entry
        return redirect(url_for("home", saved=1))

    return render_template("checkin.html", checkin=current_checkin(), labels=CATEGORY_LABELS)


@app.route("/insights")
def insights():
    history = current_user.checkins[:7] if current_user.is_authenticated else []
    return render_template("insights.html", history=history)


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
    user_message = (request.json or {}).get("message")
    if not user_message:
        return jsonify({"error": "message is required"}), 400

    if not current_user.is_authenticated:
        used = session.get("demo_chat_count", 0)
        if used >= DEMO_CHAT_LIMIT:
            return (
                jsonify(
                    {
                        "error": "You've used all the demo messages. "
                        "Create a free account to keep chatting.",
                        "limit_reached": True,
                    }
                ),
                429,
            )
        session["demo_chat_count"] = used + 1

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


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(debug=False, port=5000)
