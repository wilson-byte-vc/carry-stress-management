from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    send_from_directory,
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
import json
import re
import uuid

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

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
GROQ_MODEL = "openai/gpt-oss-120b"


def estimate_task_effort(task_title):
    prompt = f"""
You are helping a university student manage workload.

Evaluate how much energy this task will likely require.

Task: {task_title}

Return ONLY one number from 1 to 5.

1 = very low energy
2 = low energy
3 = moderate energy
4 = high energy
5 = very high energy
"""

    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            max_tokens=10,
            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ],
        )

        result = response.choices[0].message.content.strip()

        effort = int(result)
        return max(1, min(5, effort))

    except Exception as e:
        print("AI effort error:", e)
        return 3

def generate_personalized_questions(user_context):
    default_questions = {
        "time": "How manageable does your schedule feel today?",
        "social": "How socially connected or drained do you feel today?",
        "physical": "How is your body feeling — energy, sleep, movement?",
        "mental": "How clear and focused does your mind feel?",
    }

    prompt = f"""
You help university students manage stress.

Based on this student's recent information:

{user_context}

Create exactly one personalized check-in question for each category:
time, social, physical, mental.

Return ONLY valid JSON exactly like this:

{{
  "time": "question",
  "social": "question",
  "physical": "question",
  "mental": "question"
}}

Rules:
- Keep each question short
- Sound natural and supportive
- Use the student's information when relevant
- Do not include markdown
- Do not include any text outside the JSON
"""
    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            max_tokens=300,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
        text = response.choices[0].message.content or ""
        text = text.strip()
        # Remove ```json ... ``` if Groq adds it
        text = re.sub(
            r"^```(?:json)?\s*|\s*```$",
            "",
            text,
            flags=re.IGNORECASE
        )
        data = json.loads(text)

        for key in ["time", "social", "physical", "mental"]:
            if key not in data or not isinstance(data[key], str) or not data[key].strip():
                return default_questions

        return {
            "time": data["time"].strip(),
            "social": data["social"].strip(),
            "physical": data["physical"].strip(),
            "mental": data["mental"].strip(),
        }

    except Exception as e:
        print("Personalized question error:", e)
        return default_questions

# The assistant is usable in demo mode, but /chat spends real Groq quota and
# sits on a public URL -- cap what one anonymous session can burn.
DEMO_CHAT_LIMIT = 10


# --- Auth kill switch ---
#
# On by default: an account is required to reach the app, and the landing
# page at "/" is the only thing an anonymous visitor can see.
#
# Set AUTH_ENABLED=0 in the environment to disconnect signup/login again --
# no auth code is deleted, the routes just answer 404, the UI that points at
# them is hidden, and the session loader refuses to resolve anyone.
AUTH_ENABLED = os.environ.get("AUTH_ENABLED", "1") == "1"


def auth_route(view):
    """404 a route while auth is switched off.

    404 rather than 503: with the UI hidden there is no reason for anyone to
    be here, and a 404 doesn't advertise that a disabled feature exists.
    """

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not AUTH_ENABLED:
            abort(404)
        return view(*args, **kwargs)

    return wrapped


@login_manager.user_loader
def load_user(user_id):
    # Auth off -- treat every visitor as a guest, including anyone still
    # holding a valid session cookie from when it was on.
    if not AUTH_ENABLED:
        return None
    try:
        uid = uuid.UUID(user_id)
    except (ValueError, TypeError):
        return None
    return db.session.get(User, uid)


@app.context_processor
def inject_demo_mode():
    """Every page can ask whether it's being viewed without an account.
    The chat limit is exposed too so the account panel quotes the real number
    instead of a hardcoded one that could drift."""
    return {
        "demo_mode": not current_user.is_authenticated,
        "demo_chat_limit": DEMO_CHAT_LIMIT,
        "auth_enabled": AUTH_ENABLED,
    }


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
        )
        db.session.add(profile)
    elif auth_user.email and profile.email != auth_user.email:
        profile.email = auth_user.email

    db.session.commit()
    return profile


def callback_url():
    return url_for("auth_callback", _external=True)


@app.route("/signup", methods=["GET", "POST"])
@auth_route
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

            # A fresh signup should land in the account, not an inbox. With
            # email confirmation on, sign_up withholds the session until the
            # link is clicked, so confirm the address server-side with the
            # service-role key and sign them straight in. The inbox page is
            # still the fallback if that confirm fails for any reason.
            if result.session is None:
                try:
                    supabase_admin.auth.admin.update_user_by_id(
                        result.user.id, {"email_confirm": True}
                    )
                    result = supabase.auth.sign_in_with_password(
                        {"email": email, "password": password}
                    )
                except Exception:
                    app.logger.exception("auto-confirm after signup failed")
                    return render_template("check_email.html", email=email)

            profile = sync_profile(result.user)
            login_user(profile)
            flash(f"Welcome, {profile.display_name}!")
            return redirect(url_for("home"))

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
@auth_route
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
@auth_route
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
@auth_route
def auth_callback():
    """Landing page for email confirmations and OAuth returns.

    Supabase puts the tokens in the URL *fragment*, which never reaches the
    server, so this page's JS reads them and posts them to /auth/session.
    """
    return render_template("auth_callback.html")


@app.route("/auth/session", methods=["POST"])
@auth_route
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


# --- App pages ---

@app.route("/")
def welcome():
    """Public hero page -- the front door of the site.

    Sits on "/" so a first-time visitor arrives at the pitch, the way any
    site works, and enters the product from its "Open Carry" button. The week
    itself lives one click deeper at /app. landingyuji.html does not extend
    base.html and carries its own CSS, so it needs nothing from here.
    """
    return render_template("landingyuji.html")


# Moved off "/" so the landing page can own the root. The endpoint is still
# "home", so every url_for("home") link in the templates follows it here.
@app.route("/app")
@login_required
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
@login_required
def add_commitment():
    title = request.form.get("title", "").strip()[:160]
    if not title:
        flash("A commitment needs a title.")
        return redirect(url_for("home"))

    category = request.form.get("category", "academic")
    if category not in Commitment.CATEGORIES:
        category = "academic"

    ai_effort = estimate_task_effort(title)

    entry = {
        "title": title,
        "category": category,
        # Absent checkbox means unchecked, which here means fixed.
        "movable": request.form.get("movable") == "1",
        "due_at": parse_due_date(request.form.get("due_at")),
        "effort": ai_effort,
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

    flash(f"Added “{title}” — AI estimated effort: {ai_effort}/5.")
    return redirect(url_for("home"))


@app.route("/commitments/<int:commitment_id>/toggle", methods=["POST"])
@login_required
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
@login_required
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
@login_required
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
    checkin_data = current_checkin() or DEFAULT_CHECKIN

    user_context = f"""
Time capacity: {checkin_data.get('time', 3)}/5
Social capacity: {checkin_data.get('social', 3)}/5
Physical capacity: {checkin_data.get('physical', 3)}/5
Mental capacity: {checkin_data.get('mental', 3)}/5
Note: {checkin_data.get('note', '')}
"""

    questions = generate_personalized_questions(user_context)

    return render_template(
        "checkin.html",
        checkin=checkin_data,
        labels=CATEGORY_LABELS,
        questions=questions,
    )


@app.route("/insights")
@login_required
def insights():
    history = current_user.checkins[:7] if current_user.is_authenticated else []
    return render_template("insights.html", history=history)


@app.route("/assistant")
@login_required
def assistant():
    return render_template("chat.html")

@app.route("/game")
@login_required
def game():
    return render_template("pressure_valve.html")

@app.route("/landingyuji")
def landingyuji():
    return render_template("landingyuji.html")


# --- PWA ---
# The worker has to be served from the site root: a script under /static/ can
# only control /static/, so it would never see a page load.
@app.route("/sw.js")
def service_worker():
    response = send_from_directory("static/js", "sw.js")
    response.headers["Content-Type"] = "application/javascript"
    # Without this the browser can serve a stale worker for up to 24h, so a
    # deploy's new cache version would sit unused.
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/offline")
def offline():
    """Fallback the worker shows when a page load fails with no network."""
    return render_template("offline.html")

# Keep-alive / health check.
#
# Two jobs in one request. Hitting it keeps Render's free instance from
# spinning down, and the SELECT 1 puts real traffic on the Supabase
# connection -- a plain "/" request would do neither for the database, since
# an anonymous home page is served entirely from the session cookie.
#
# 503 on failure is deliberate: the pinger then reports a failure instead of
# quietly succeeding while the database is unreachable.
@app.route("/healthz")
def healthz():
    try:
        db.session.execute(db.text("SELECT 1"))
    except Exception:
        # No detail in the body -- this endpoint is public, and connection
        # errors leak host names and credentials fragments.
        app.logger.exception("health check failed")
        return jsonify({"status": "error", "database": "unreachable"}), 503
    return jsonify({"status": "ok", "database": "ok"})


# Digital Asset Links: proves this site and the Android APK are published by
# the same people. Without a match, a Trusted Web Activity still runs but
# Chrome keeps its address bar pinned to the top, so it looks like a browser
# rather than an app.
#
# The fingerprint comes from whatever key signs the APK -- PWABuilder shows it
# after generating the package. Kept in the environment because it is tied to
# the signing key, not to the source.
@app.route("/.well-known/assetlinks.json")
def assetlinks():
    fingerprint = os.environ.get("ANDROID_CERT_FINGERPRINT")
    if not fingerprint:
        # Nothing signed yet -- 404 is honest. Serving an empty or placeholder
        # list would make Chrome cache a failed verification.
        abort(404)
    return jsonify([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": os.environ.get(
                "ANDROID_PACKAGE_NAME", "com.balance.twa"
            ),
            "sha256_cert_fingerprints": [
                f.strip() for f in fingerprint.split(",") if f.strip()
            ],
        },
    }])


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


# The mobile app has no Flask session to hang a transcript on, so it owns the
# history and sends the whole thing. Cap the length: the transcript is
# attacker-controlled and every turn is billed on the way to Groq.
MAX_CLIENT_HISTORY = 40


def _client_history(payload):
    """Validate a caller-supplied transcript, or None if there isn't one.

    Returns None (rather than raising) when `messages` is absent, so the
    browser's session-backed path is left alone.
    """
    raw = payload.get("messages")
    if not isinstance(raw, list) or not raw:
        return None

    cleaned = []
    for item in raw[-MAX_CLIENT_HISTORY:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        # Only user and assistant turns -- accepting "system" would let a
        # caller replace the prompt that keeps this on-topic.
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            cleaned.append({"role": role, "content": content[:4000]})

    if not cleaned or cleaned[-1]["role"] != "user":
        return None
    return cleaned


@app.route("/chat", methods=["POST"])
@login_required
def chat():
    payload = request.json or {}
    client_history = _client_history(payload)

    user_message = client_history[-1]["content"] if client_history else payload.get("message")
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

    if client_history is not None:
        history = client_history
    else:
        history = session.get("chat_history", [])
        history.append({"role": "user", "content": user_message})

    user_context = ""
    if current_user.is_authenticated:
        latest = current_user.latest_checkin
        if latest:
            user_context = f"""
User's latest stress check-in:
- Time capacity: {latest.time}/5
- Social capacity: {latest.social}/5
- Physical capacity: {latest.physical}/5
- Mental capacity: {latest.mental}/5
- Note: {latest.note}
"""
    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            max_tokens=600,
            # Send the FULL history every time, not just the latest message --
            # the model has no memory of its own between requests.
            messages=[
    CHAT_SYSTEM_PROMPT,
    {
        "role": "system",
        "content": user_context
    }
] + history,
        )
    except Exception as e:
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 502

    reply = response.choices[0].message.content

    # A stateless caller keeps its own transcript; only the browser's
    # session-backed conversation is written back here.
    if client_history is None:
        history.append({"role": "assistant", "content": reply})
        session["chat_history"] = history

    return jsonify({"reply": reply})


@app.route("/chat/reset", methods=["POST"])
@login_required
def chat_reset():
    session.pop("chat_history", None)
    return jsonify({"ok": True})


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)

