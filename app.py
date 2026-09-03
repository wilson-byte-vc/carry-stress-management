from datetime import datetime, timedelta, timezone
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
from supabase import ClientOptions, create_client

import os

from models import CheckIn, Commitment, Insight, User, db

load_dotenv()

app = Flask(__name__)
# Sessions are just a signed cookie -- Flask needs a secret key to sign them.
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")

# Render/Heroku hand out "postgres://" URLs, but SQLAlchemy 2.x only accepts
# "postgresql://". Falls back to local SQLite when DATABASE_URL is unset.
database_url = os.environ.get("DATABASE_URL", "sqlite:///spaceman.db")
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
# Supabase's pooler drops idle connections; recycle before it does so we don't
# hand a dead socket to a request.
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True, "pool_recycle": 280}

db.init_app(app)
migrate = Migrate(app, db)

login_manager = LoginManager(app)
login_manager.login_view = "login"
login_manager.login_message = "Please log in to continue."

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Implicit flow, not the library default of PKCE. PKCE needs the per-user code
# verifier that was generated on the way out to still be in memory when the
# callback comes back -- under gunicorn on Render the callback can hit a
# different worker, which fails intermittently and is miserable to debug.
# Implicit keeps the server stateless; /auth/session still verifies the token
# against Supabase before anyone is logged in, so the browser is never trusted.
_auth_options = ClientOptions(flow_type="implicit")

# Anon client performs auth on behalf of the visitor. The service-role client
# bypasses RLS entirely -- server-side only, never expose it to a template.
supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY, options=_auth_options)
supabase_admin = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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
    return db.session.get(User, user_id)


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

CATEGORY_LABELS = {
    "time": ["Overloaded", "Busy", "Balanced", "Manageable", "Light"],
    "social": ["Isolated", "Quiet", "Neutral", "Connected", "Very connected"],
    "physical": ["Drained", "Tired", "Okay", "Good", "Energized"],
    "mental": ["Foggy", "Distracted", "Steady", "Focused", "Sharp"],
}
# Only used to seed the check-in sliders before anything is logged. The
# dashboard never presents these as if they were real readings.
DEFAULT_CHECKIN = {"time": 3, "social": 3, "physical": 4, "mental": 4, "note": ""}

# Effort points that constitute a "full" week. Load is measured against this,
# so 30 points of upcoming work reads as completely committed.
WEEK_EFFORT_BUDGET = 30
# How much a completely full week can eat into felt energy. At 1.0 a full slate
# would zero you out regardless of how you feel, which isn't true -- half is a
# more honest ceiling.
LOAD_WEIGHT = 0.5
# Commitments this far ahead count toward current load.
LOAD_HORIZON_DAYS = 7


def current_checkin():
    """The latest real check-in, or None if the user has never logged one.

    Returning None rather than a default is deliberate: the dashboard needs to
    tell "no data yet" apart from "genuinely middling", and inventing numbers
    for a new user is exactly what made this a mockup.
    """
    if current_user.is_authenticated:
        latest = current_user.latest_checkin
        return latest.as_dict() if latest else None
    return session.get("checkin")


def energy_percent(checkin):
    """How much is in the tank, straight from the last check-in."""
    levels = [checkin["time"], checkin["social"], checkin["physical"], checkin["mental"]]
    return round(sum(levels) / (len(levels) * 5) * 100)


def load_points(commitments):
    """Effort already claimed by what's coming up.

    Counts incomplete commitments falling inside the horizon. Undated ones
    count too -- work with no date attached is still work.
    """
    horizon = datetime.now(timezone.utc) + timedelta(days=LOAD_HORIZON_DAYS)
    total = 0
    for c in commitments:
        if c["completed"]:
            continue
        due = c["due_at"]
        if due is None or due <= horizon:
            total += c["effort"]
    return total


def compute_capacity(checkin, commitments):
    """Blend felt energy with committed load into a single percentage.

        energy   = mean(check-in sliders) / 5
        load     = min(1, upcoming effort / WEEK_EFFORT_BUDGET)
        capacity = energy * (1 - LOAD_WEIGHT * load)

    Returns None when there's no check-in, because capacity without a check-in
    would be a guess dressed up as a measurement.
    """
    if checkin is None:
        return None
    energy = energy_percent(checkin)
    load = min(1.0, load_points(commitments) / WEEK_EFFORT_BUDGET)
    return max(0, round(energy * (1 - LOAD_WEIGHT * load)))


def clamp_level(raw, fallback=3):
    """Slider values arrive as strings from the form and are attacker-controlled
    -- coerce to an int inside 1..5 rather than trusting them."""
    try:
        return min(5, max(1, int(raw)))
    except (TypeError, ValueError):
        return fallback


# --- Commitments (database when signed in, session cookie in demo mode) ---

def _commitment_dict(c):
    return {
        "id": c.id,
        "title": c.title,
        "category": c.category,
        "movable": c.movable,
        "due_at": c.due_at,
        "effort": c.effort,
        "completed": c.completed,
    }


def get_commitments():
    """Uniform list of dicts so templates don't care where they came from."""
    if current_user.is_authenticated:
        return [_commitment_dict(c) for c in current_user.commitments]

    items = []
    for raw in session.get("commitments", []):
        item = dict(raw)
        # Session data round-trips through JSON, so dates come back as strings.
        if item.get("due_at"):
            try:
                item["due_at"] = datetime.fromisoformat(item["due_at"])
            except ValueError:
                item["due_at"] = None
        else:
            item["due_at"] = None
        items.append(item)
    items.sort(key=lambda i: (i["due_at"] is None, i["due_at"] or datetime.max.replace(tzinfo=timezone.utc)))
    return items


def parse_due_date(raw):
    """<input type="date"> gives YYYY-MM-DD, or empty for no deadline."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def upcoming_commitments(commitments):
    return [c for c in commitments if not c["completed"]]


# --- Auth ---

def sync_profile(auth_user):
    """Make sure a Supabase auth user has a matching local profile row.

    Called after any successful sign-in (password, Google, or email
    confirmation), so a profile exists no matter which route the user took in.
    """
    profile = db.session.get(User, auth_user.id)
    metadata = auth_user.user_metadata or {}

    if profile is None:
        # First profile in the table becomes the admin -- there's no other
        # bootstrap path into the admin panel.
        is_first = db.session.scalar(db.select(db.func.count(User.id))) == 0
        display_name = (
            metadata.get("display_name")
            or metadata.get("full_name")
            or metadata.get("name")
            or (auth_user.email or "there").split("@")[0]
        )
        profile = User(
            id=auth_user.id,
            email=auth_user.email or "",
            display_name=display_name[:80],
            is_admin=is_first,
        )
        db.session.add(profile)
    elif auth_user.email and profile.email != auth_user.email:
        profile.email = auth_user.email

    db.session.commit()
    return profile


def callback_url():
    return url_for("auth_callback", _external=True)


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
        else:
            try:
                result = supabase.auth.sign_up(
                    {
                        "email": email,
                        "password": password,
                        "options": {
                            "email_redirect_to": callback_url(),
                            "data": {"display_name": display_name},
                        },
                    }
                )
            except Exception as e:
                flash(f"Could not sign you up: {e}")
                return render_template("signup.html")

            # Email confirmation is on, so sign_up returns a user but no
            # session -- they have to click the link before they can log in.
            if result.session is None:
                return render_template("check_email.html", email=email)

            profile = sync_profile(result.user)
            login_user(profile)
            flash(f"Welcome, {profile.display_name}!")
            return redirect(url_for("home"))

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        try:
            result = supabase.auth.sign_in_with_password(
                {"email": email, "password": password}
            )
        except Exception as e:
            # Supabase distinguishes these two; everything else stays vague so
            # we don't confirm whether an address is registered.
            message = str(e).lower()
            if "not confirmed" in message:
                flash("Please confirm your email first — check your inbox.")
            else:
                flash("Incorrect email or password.")
            return render_template("login.html")

        profile = sync_profile(result.user)
        login_user(profile, remember=bool(request.form.get("remember")))
        flash(f"Welcome back, {profile.display_name}!")

        # Only honour a relative "next" -- an absolute URL here would let a
        # crafted link bounce people to another site after login.
        next_url = request.args.get("next", "")
        if next_url.startswith("/") and not next_url.startswith("//"):
            return redirect(next_url)
        return redirect(url_for("home"))

    return render_template("login.html")


@app.route("/auth/google")
def auth_google():
    """Kick off Google sign-in; Supabase handles the handshake and sends the
    user back to /auth/callback."""
    try:
        result = supabase.auth.sign_in_with_oauth(
            {"provider": "google", "options": {"redirect_to": callback_url()}}
        )
    except Exception as e:
        flash(f"Could not start Google sign-in: {e}")
        return redirect(url_for("login"))
    return redirect(result.url)


@app.route("/auth/callback")
def auth_callback():
    """Landing page for email confirmations and OAuth returns.

    Supabase puts the tokens in the URL *fragment*, which never reaches the
    server, so this page's JS reads them and posts them to /auth/session.
    """
    return render_template("auth_callback.html")


@app.route("/auth/session", methods=["POST"])
def auth_session():
    """Exchange an access token from the callback fragment for a login.

    The token is verified against Supabase before anyone is logged in -- the
    browser's claim about who it is counts for nothing on its own.
    """
    token = (request.json or {}).get("access_token", "")
    if not token:
        return jsonify({"error": "access_token is required"}), 400

    try:
        result = supabase.auth.get_user(token)
    except Exception as e:
        return jsonify({"error": f"Could not verify session: {e}"}), 401

    if not result or not result.user:
        return jsonify({"error": "Invalid or expired token"}), 401

    profile = sync_profile(result.user)
    login_user(profile, remember=True)
    flash(f"Welcome, {profile.display_name}!")
    return jsonify({"ok": True, "redirect": url_for("home")})


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    try:
        supabase.auth.sign_out()
    except Exception:
        # Local logout matters more than tidying up the remote session.
        pass
    logout_user()
    session.pop("chat_history", None)
    session.pop("demo_chat_count", None)
    flash("You've been logged out.")
    return redirect(url_for("login"))


# --- Settings ---

@app.route("/settings", methods=["POST"])
@login_required
def settings():
    display_name = request.form.get("display_name", "").strip()
    if display_name:
        current_user.display_name = display_name[:80]
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
    return render_template("admin.html", users=users, total_checkins=total_checkins)


@app.route("/admin/users/<user_id>/toggle-admin", methods=["POST"])
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
    commitments = get_commitments()
    upcoming = upcoming_commitments(commitments)
    points = load_points(commitments)

    return render_template(
        "home.html",
        checkin=checkin,
        capacity=compute_capacity(checkin, commitments),
        energy=energy_percent(checkin) if checkin else None,
        labels=CATEGORY_LABELS,
        commitments=upcoming,
        fixed_count=sum(1 for c in upcoming if not c["movable"]),
        movable_count=sum(1 for c in upcoming if c["movable"]),
        load_points=points,
        load_pct=min(100, round(points / WEEK_EFFORT_BUDGET * 100)),
        load_horizon=LOAD_HORIZON_DAYS,
        categories=Commitment.CATEGORIES,
        today=datetime.now(timezone.utc).date().isoformat(),
        just_saved=request.args.get("saved") == "1",
    )


# --- Commitments ---

@app.route("/commitments", methods=["POST"])
def add_commitment():
    title = request.form.get("title", "").strip()[:160]
    if not title:
        flash("A commitment needs a title.")
        return redirect(url_for("home"))

    category = request.form.get("category", "academic")
    if category not in Commitment.CATEGORIES:
        category = "academic"

    entry = {
        "title": title,
        "category": category,
        # Absent checkbox means unchecked, which here means fixed.
        "movable": request.form.get("movable") == "1",
        "due_at": parse_due_date(request.form.get("due_at")),
        "effort": clamp_level(request.form.get("effort")),
        "completed": False,
    }

    if current_user.is_authenticated:
        db.session.add(Commitment(user_id=current_user.id, **entry))
        db.session.commit()
    else:
        items = session.get("commitments", [])
        entry_json = dict(entry)
        entry_json["due_at"] = entry["due_at"].isoformat() if entry["due_at"] else None
        entry_json["id"] = (max((i["id"] for i in items), default=0) + 1)
        items.append(entry_json)
        session["commitments"] = items

    flash(f"Added “{title}”.")
    return redirect(url_for("home"))


@app.route("/commitments/<int:commitment_id>/toggle", methods=["POST"])
def toggle_commitment(commitment_id):
    if current_user.is_authenticated:
        c = db.session.get(Commitment, commitment_id)
        # Scope by owner as well as id -- otherwise anyone could toggle anyone's.
        if c is None or c.user_id != current_user.id:
            abort(404)
        c.completed = not c.completed
        db.session.commit()
    else:
        items = session.get("commitments", [])
        for item in items:
            if item["id"] == commitment_id:
                item["completed"] = not item["completed"]
                break
        session["commitments"] = items
    return redirect(url_for("home"))


@app.route("/commitments/<int:commitment_id>/delete", methods=["POST"])
def delete_commitment(commitment_id):
    if current_user.is_authenticated:
        c = db.session.get(Commitment, commitment_id)
        if c is None or c.user_id != current_user.id:
            abort(404)
        db.session.delete(c)
        db.session.commit()
    else:
        items = [i for i in session.get("commitments", []) if i["id"] != commitment_id]
        session["commitments"] = items
    flash("Commitment removed.")
    return redirect(url_for("home"))


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

    # Sliders need somewhere to start; that's a form default, not a reading.
    return render_template(
        "checkin.html", checkin=current_checkin() or DEFAULT_CHECKIN, labels=CATEGORY_LABELS
    )


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
