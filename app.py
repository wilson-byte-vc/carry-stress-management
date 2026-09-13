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

from werkzeug.middleware.proxy_fix import ProxyFix

from flask_migrate import Migrate
from dotenv import load_dotenv
from groq import Groq
from supabase import ClientOptions, create_client
from sqlalchemy import or_

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import webpush, WebPushException

import os
import json
import re
import uuid
import base64
import random
import threading
import time as time_module

from models import ActivitySession, CheckIn, Commitment, Insight, PushSubscription, User, db

load_dotenv()

app = Flask(__name__)
# Render terminates TLS at its edge and forwards plain HTTP to gunicorn, so
# without this Flask believes every request is http:// and builds the OAuth
# callback as http://host/auth/callback. Supabase compares redirect_to against
# its allow-list exactly, scheme included, and silently falls back to the
# project Site URL when it does not match -- which is how sign-in ends up on
# localhost. One proxy hop, so trust exactly one set of X-Forwarded headers.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

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

# Generated once and kept on disk -- regenerating would silently invalidate
# every browser's existing push subscription (they're signed against this
# specific keypair). vapid_private_key=<path> is handed straight to pywebpush,
# which loads it itself.
VAPID_KEY_PATH = os.path.join(os.path.dirname(__file__), "vapid_private_key.pem")
if not os.path.exists(VAPID_KEY_PATH):
    _vapid = Vapid()
    _vapid.generate_keys()
    _vapid.save_key(VAPID_KEY_PATH)

_vapid_public = Vapid.from_file(VAPID_KEY_PATH).public_key
VAPID_PUBLIC_KEY = base64.urlsafe_b64encode(
    _vapid_public.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
).decode().rstrip("=")


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


def parse_commitment_from_speech(text):
    """Turns a spoken sentence into commitment fields, so the add-commitment
    form can be filled from voice instead of typed field by field."""
    now = datetime.now(timezone.utc)
    prompt = f"""
You are helping a university student add a commitment to their planner by voice.

Current date and time (UTC): {now.strftime('%A, %Y-%m-%d %H:%M')}

They said: "{text}"

Extract a single commitment from this. Return ONLY valid JSON exactly like this:

{{
  "title": "short title, under 12 words",
  "category": "one of academic, work, social, health, personal",
  "due_at": "YYYY-MM-DDTHH:MM in UTC, or null if no date or time was mentioned",
  "movable": true or false -- false only if it sounds fixed and unmovable, like a lecture, shift, or exam
}}

Rules:
- Resolve relative dates ("tomorrow", "next Friday", "in two days") against the current date above.
- Resolve rough times of day: morning = 09:00, afternoon = 14:00, evening or tonight = 19:00, night = 21:00.
- If no date or time is mentioned at all, use 09:00.
- Do not include markdown or any text outside the JSON.
"""
    # gpt-oss occasionally burns its whole token budget on hidden reasoning
    # and comes back with an empty visible reply -- one retry clears almost
    # all of these, since it's transient, not a property of the input text.
    for attempt in range(2):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                max_tokens=800,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = (response.choices[0].message.content or "").strip()
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
            data = json.loads(raw)

            title = str(data.get("title", "")).strip()[:160]
            if not title:
                continue

            category = data.get("category")
            if category not in Commitment.CATEGORIES:
                category = "academic"

            due_at = None
            if data.get("due_at"):
                try:
                    due_at = datetime.strptime(data["due_at"], "%Y-%m-%dT%H:%M")
                except (ValueError, TypeError):
                    due_at = None

            return {
                "title": title,
                "category": category,
                "due_at": due_at,
                "movable": bool(data.get("movable", True)),
            }
        except Exception as e:
            print("AI voice-commitment parse error:", e)
    return None


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
    """Every page can ask whether it's being viewed without an account."""
    return {
        "demo_mode": not current_user.is_authenticated,
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


def checkin_dates():
    """Distinct calendar days the user has checked in on -- a day can hold
    more than one CheckIn row, so this dedupes before a streak is counted."""
    if not current_user.is_authenticated:
        return set()
    return {c.created_at.date() for c in current_user.checkins}


def current_streak():
    """Consecutive days ending today (or yesterday, so the streak doesn't
    die the moment the clock ticks past midnight before today's check-in).
    A single missed day breaks it."""
    days = checkin_dates()
    if not days:
        return 0
    today = datetime.now(timezone.utc).date()
    if max(days) < today - timedelta(days=1):
        return 0
    streak = 1
    cursor = max(days)
    while cursor - timedelta(days=1) in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def streak_week(n=7):
    """The last n calendar days, oldest first, each flagged for whether a
    check-in landed on it -- the data behind the week's row of streak dots."""
    days = checkin_dates()
    today = datetime.now(timezone.utc).date()
    return [
        {
            "label": (today - timedelta(days=i)).strftime("%a")[0],
            "done": (today - timedelta(days=i)) in days,
            "is_today": i == 0,
        }
        for i in range(n - 1, -1, -1)
    ]


# Overnight window a sleep gap has to fall inside, and the shortest gap that
# counts as sleep rather than "put the phone down for a bit". UTC, same as
# every other date computation in this file -- no per-user timezone stored.
SLEEP_WINDOW_START_HOUR = 20
SLEEP_WINDOW_END_HOUR = 12
MIN_SLEEP_HOURS = 2


def seed_sleep_history(user, nights=30):
    """Backfills plausible activity gaps for a brand-new account so the sleep
    chart isn't empty on day one. Deterministic per user (seeded on their
    id), so it doesn't reshuffle on every page load -- and since real usage
    naturally produces its own sessions from today onward, these seeded
    nights simply age out of the display window over the following month
    without needing a flag to tell them apart from real data."""
    if user.activity_sessions:
        return

    rng = random.Random(user.id)
    today = datetime.now(timezone.utc).date()
    rows = []
    for i in range(nights, 0, -1):
        night = today - timedelta(days=i)
        bedtime_hour = rng.uniform(21.5, 23.5)
        sleep_hours = rng.uniform(5.5, 8.5)
        went_still_at = datetime.combine(night, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=bedtime_hour)
        woke_at = went_still_at + timedelta(hours=sleep_hours)
        rows.append(ActivitySession(user_id=user.id, started_at=went_still_at - timedelta(minutes=5),
                                     last_ping_at=went_still_at, ended_at=went_still_at))
        rows.append(ActivitySession(user_id=user.id, started_at=woke_at,
                                     last_ping_at=woke_at + timedelta(minutes=5), ended_at=None))
    db.session.add_all(rows)
    db.session.commit()


def compute_sleep_days(user, n=30):
    """The last n nights' inferred sleep, oldest first. Sleep for a night is
    the longest gap between one activity session ending and the next
    starting, clipped to the overnight window so a long weekend nap doesn't
    get counted as that night's sleep. `label` is only set every 7th day
    (a sparse date tick) -- one per bar would be unreadable at 30 bars wide,
    so `date` carries the real value for anything that needs every day
    (the AI summary prompt)."""
    # Naive throughout, to match how db.DateTime round-trips through Postgres
    # (it drops tzinfo on read) -- every value here is implicitly UTC.
    intervals = sorted(
        (s.started_at, s.ended_at or s.last_ping_at) for s in user.activity_sessions
    )
    today = datetime.now(timezone.utc).date()

    results = []
    for i in range(n - 1, -1, -1):
        day = today - timedelta(days=i)
        window_start = datetime.combine(day - timedelta(days=1), datetime.min.time()) \
            + timedelta(hours=SLEEP_WINDOW_START_HOUR)
        window_end = datetime.combine(day, datetime.min.time()) \
            + timedelta(hours=SLEEP_WINDOW_END_HOUR)

        best_hours = 0
        for j in range(len(intervals) - 1):
            gap_start = max(intervals[j][1], window_start)
            gap_end = min(intervals[j + 1][0], window_end)
            if gap_end > gap_start:
                hours = (gap_end - gap_start).total_seconds() / 3600
                if hours >= MIN_SLEEP_HOURS:
                    best_hours = max(best_hours, hours)

        position = n - 1 - i  # 0 = oldest day shown
        # %-d (no leading zero) isn't portable across platforms -- day.day
        # gets the same result everywhere.
        date_label = f"{day.strftime('%b')} {day.day}"
        results.append({
            "label": date_label if position % 7 == 0 else "",
            "date": day.isoformat(),
            "date_label": date_label,
            "hours": round(best_hours, 1),
            "is_today": i == 0,
        })
    return results


def compute_today_sleep_window(user):
    """Last night's inferred sleep as a real (start, end) timestamp pair, or
    None. Same window/gap logic as compute_sleep_days, but keeps the actual
    times instead of collapsing to a duration -- needed to place it on a
    same-day timeline."""
    intervals = sorted(
        (s.started_at, s.ended_at or s.last_ping_at) for s in user.activity_sessions
    )
    today = datetime.now(timezone.utc).date()
    window_start = datetime.combine(today - timedelta(days=1), datetime.min.time()) \
        + timedelta(hours=SLEEP_WINDOW_START_HOUR)
    window_end = datetime.combine(today, datetime.min.time()) \
        + timedelta(hours=SLEEP_WINDOW_END_HOUR)

    best = None
    best_hours = 0
    for j in range(len(intervals) - 1):
        gap_start = max(intervals[j][1], window_start)
        gap_end = min(intervals[j + 1][0], window_end)
        if gap_end > gap_start:
            hours = (gap_end - gap_start).total_seconds() / 3600
            if hours >= MIN_SLEEP_HOURS and hours > best_hours:
                best_hours = hours
                best = (gap_start, gap_end)
    return best


def compute_today_timeline(user, commitments):
    """What's real about today, laid along a 24h strip: last night's
    inferred sleep window (from activity gaps) and today's commitments.
    Commitments only carry a due *moment*, not a duration, so each renders
    as a point on the strip rather than an occupied span."""
    today = datetime.now(timezone.utc).date()
    midnight = datetime.combine(today, datetime.min.time())

    def hour_of(dt):
        if dt.tzinfo:
            dt = dt.replace(tzinfo=None)
        return (dt - midnight).total_seconds() / 3600

    sleep_segments = []
    window = compute_today_sleep_window(user)
    if window:
        start_h = max(0.0, hour_of(window[0]))
        end_h = min(24.0, hour_of(window[1]))
        if end_h > start_h:
            sleep_segments.append({"start_pct": start_h / 24 * 100, "width_pct": (end_h - start_h) / 24 * 100})

    events = []
    for c in commitments:
        due = c["due_at"]
        # Midnight is the "no time given" default (the due-date field's time
        # is optional) -- plotting a dot there would claim a precision that
        # was never actually entered, so those just don't get one.
        if due and due.date() == today and (due.hour, due.minute) != (0, 0):
            hour = hour_of(due)
            hour12 = due.hour % 12 or 12
            events.append({
                "pct": hour / 24 * 100,
                "time_label": f"{hour12}:{due.strftime('%M')} {'AM' if due.hour < 12 else 'PM'}",
                "title": c["title"],
                "category": c["category"],
                "effort": c["effort"],
            })
    events.sort(key=lambda e: e["pct"])

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    now_pct = hour_of(now) / 24 * 100 if now.date() == today else None

    return {"sleep_segments": sleep_segments, "events": events, "now_pct": now_pct}


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
    """How loaded the week feels, as a percentage of the weekly effort budget.

        load_ratio  = upcoming effort / WEEK_EFFORT_BUDGET -- not capped, so a
                      genuinely over-committed week can read over 100
        fatigue     = 2 - energy/100 -- a drained check-in makes the same
                      objective load feel up to 2x heavier
        capacity    = load_ratio * 100 * fatigue

    Higher = more loaded (matches the ring's room/tight/over bands). Zero
    upcoming load reads 0 regardless of mood, since there's nothing to be
    over-loaded by yet.

    Returns None when there's no check-in, because capacity without a check-in
    would be a guess dressed up as a measurement.
    """
    if checkin is None:
        return None
    energy = energy_percent(checkin)
    load_ratio = load_points(commitments) / WEEK_EFFORT_BUDGET
    fatigue = 2 - energy / 100
    return max(0, round(load_ratio * 100 * fatigue))


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


def parse_due_datetime(date_str, time_str):
    """Date is the real field (<input type="date">, YYYY-MM-DD); time is a
    separate, optional <input type="time"> -- left blank, it defaults to
    midnight, same as a commitment with no time ever specified."""
    date_str = (date_str or "").strip()
    if not date_str:
        return None
    time_str = (time_str or "").strip() or "00:00"
    try:
        return datetime.strptime(f"{date_str}T{time_str}", "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def upcoming_commitments(commitments):
    return [c for c in commitments if not c["completed"]]


def draft_decline_message(title, category, upcoming):
    """AI-drafted decline message that cites a real fixed commitment instead
    of a generic excuse -- the honest reason is the whole point."""
    fixed = [c for c in upcoming if not c["movable"]]
    reason_source = sorted(fixed, key=lambda c: c["effort"], reverse=True)[:3]
    reasons = "\n".join(
        f"- {c['title']} ({c['category']}, effort {c['effort']}/5)" for c in reason_source
    ) or "- (no fixed commitments on record -- decline on general capacity grounds)"

    prompt = f"""
A university student was invited to: "{title}" ({category}).

They need to decline. Their real fixed commitments they could honestly cite:
{reasons}

Write ONE short, casual decline message (2-3 sentences) they could send a friend or group-mate.
Reference one of the real commitments above only if it plausibly conflicts or explains why
they're stretched thin -- otherwise give an honest general capacity reason without inventing
a fake event. Return ONLY the message text, no quotes, no markdown.
"""
    for attempt in range(2):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            )
            text = (response.choices[0].message.content or "").strip()
            if text:
                return text
        except Exception:
            app.logger.exception("decline draft failed")
    return None


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
                return render_template("carry-signup.html")

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

    return render_template("carry-signup.html")


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
            return render_template("carry-login.html")

        profile = sync_profile(result.user)
        login_user(profile, remember=bool(request.form.get("remember")))
        flash(f"Welcome back, {profile.display_name}!")

        # Only honour a relative "next" -- an absolute URL here would let a
        # crafted link bounce people to another site after login.
        next_url = request.args.get("next", "")
        if next_url.startswith("/") and not next_url.startswith("//"):
            return redirect(next_url)
        return redirect(url_for("home"))

    return render_template("carry-login.html")


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


# --- Activity tracking (sleep chart's data source) ---
#
# Page Visibility, not a whole-device signal: this only knows whether the
# Carry tab itself is open and focused, not whether the phone is actually
# asleep on the nightstand or just being used elsewhere. Good enough as an
# honest proxy for a class project, not a real sleep tracker.

@app.route("/activity/start", methods=["POST"])
@login_required
def activity_start():
    row = ActivitySession(user_id=current_user.id)
    db.session.add(row)
    db.session.commit()
    return jsonify({"session_id": row.id})


@app.route("/activity/ping", methods=["POST"])
@login_required
def activity_ping():
    session_id = (request.json or {}).get("session_id")
    row = ActivitySession.query.filter_by(id=session_id, user_id=current_user.id).first()
    if row:
        row.last_ping_at = datetime.now(timezone.utc)
        db.session.commit()
    return jsonify({"ok": True})


@app.route("/activity/end", methods=["POST"])
@login_required
def activity_end():
    # Sent via navigator.sendBeacon on tab-hide/unload, which posts a plain
    # text/plain blob rather than application/json -- request.json would
    # reject it, so parse the raw body by hand.
    try:
        data = json.loads(request.get_data(as_text=True) or "{}")
    except ValueError:
        data = {}

    row = ActivitySession.query.filter_by(id=data.get("session_id"), user_id=current_user.id).first()
    if row:
        row.ended_at = datetime.now(timezone.utc)
        db.session.commit()
    return jsonify({"ok": True})


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


# One line per day rather than restating the capacity number the ring
# already shows. Same quote for everyone on a given day -- indexed by date,
# not random, so it doesn't change on every refresh.
CAPACITY_QUOTES = (
    "Rest is part of the work, not a reward for finishing it.",
    "You don't owe anyone your last 10%.",
    "A slower week is still a week that counts.",
    "Saying no to one thing is saying yes to something else.",
    "Capacity isn't a test you pass or fail — it's just where you are today.",
    "Small and finished beats big and stalled.",
    "You're allowed to need a lighter day.",
    "Nobody remembers the week you rested. Everybody feels the week you didn't.",
    "One thing at a time is still progress.",
    "Your worth isn't measured in hours logged.",
)


def quote_of_day():
    return CAPACITY_QUOTES[datetime.now(timezone.utc).toordinal() % len(CAPACITY_QUOTES)]


# Moved off "/" so the landing page can own the root. The endpoint is still
# "home", so every url_for("home") link in the templates follows it here.
@app.route("/app")
@login_required
def home():
    checkin = current_checkin()
    commitments = get_commitments()
    upcoming = upcoming_commitments(commitments)

    seed_sleep_history(current_user)

    return render_template(
        "home.html",
        checkin=checkin,
        capacity=compute_capacity(checkin, commitments),
        quote=quote_of_day(),
        streak=current_streak(),
        streak_days=streak_week(),
        sleep_days=compute_sleep_days(current_user),
        today_timeline=compute_today_timeline(current_user, commitments),
        vapid_public_key=VAPID_PUBLIC_KEY,
        labels=CATEGORY_LABELS,
        commitments=upcoming,
        fixed_count=sum(1 for c in upcoming if not c["movable"]),
        movable_count=sum(1 for c in upcoming if c["movable"]),
        load_horizon=LOAD_HORIZON_DAYS,
        categories=Commitment.CATEGORIES,
        today=datetime.now(timezone.utc).date().isoformat(),
        just_saved=request.args.get("saved") == "1",
        # Lowest check-in slider = the category with the least capacity left.
        top_drain_key=min(CATEGORY_LABELS, key=lambda k: checkin[k]) if checkin else None,
        # Heaviest upcoming work, for the same "what's driving this" panel.
        top_commitments=sorted(upcoming, key=lambda c: c["effort"], reverse=True)[:2],
        # Cost of Yes: lets the add-commitment form preview the capacity hit
        # client-side, with the same formula as compute_capacity().
        energy_pct=energy_percent(checkin) if checkin else None,
        load_now=load_points(commitments),
        week_effort_budget=WEEK_EFFORT_BUDGET,
    )


@app.route("/app/summary", methods=["POST"])
@login_required
def home_summary():
    """One-off AI suggestion for the capacity ring's expandable detail panel.

    Deliberately not computed on every home() render -- it's only fetched
    when a user actually opens the panel, so a page load never waits on or
    pays for a completion nobody asked to see.
    """
    checkin = current_checkin()
    if checkin is None:
        return jsonify({"error": "Do a check-in first and this'll have something to go on."}), 400

    commitments = get_commitments()
    top = sorted(upcoming_commitments(commitments), key=lambda c: c["effort"], reverse=True)[:3]
    load_text = "; ".join(
        f"{c['title']} (effort {c['effort']}/5, {'movable' if c['movable'] else 'fixed'})" for c in top
    ) or "nothing logged"

    prompt = (
        "In this app, \"capacity\" means how loaded/stressed the week is -- higher is worse. "
        "A good check-in (high sliders) lowers it; heavy upcoming commitments raise it. "
        f"Check-in -- time {checkin['time']}/5, social {checkin['social']}/5, "
        f"physical {checkin['physical']}/5, mental {checkin['mental']}/5. "
        f"Note: {checkin['note'] or 'none'}. "
        f"Heaviest upcoming commitments: {load_text}. "
        "In two short sentences: name what's most likely driving their capacity up "
        "this week, then suggest one small, concrete thing they could actually do about it."
    )

    # gpt-oss occasionally burns its whole token budget on hidden reasoning
    # and comes back with an empty visible reply -- one retry clears almost
    # all of these, since it's transient, not a property of the input text.
    for attempt in range(2):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                max_tokens=800,
                messages=[CHAT_SYSTEM_PROMPT, {"role": "user", "content": prompt}],
            )
            summary = (response.choices[0].message.content or "").strip()
            if summary:
                return jsonify({"summary": summary})
        except Exception as e:
            return jsonify({"error": f"{type(e).__name__}: {e}"}), 502

    return jsonify({"error": "Couldn't generate a suggestion -- try again?"}), 502


@app.route("/sleep/summary", methods=["POST"])
@login_required
def sleep_summary():
    """One-off AI suggestion for the sleep card, fetched once when the chart
    scrolls into view -- same lazy, pay-only-if-seen pattern as home_summary."""
    days = compute_sleep_days(current_user)
    nights = ", ".join(f"{d['date']} {d['hours']}h" for d in days)
    avg = round(sum(d["hours"] for d in days) / len(days), 1)

    prompt = (
        f"A university student's inferred sleep for the last 30 nights: {nights}. Average {avg}h/night. "
        "In one or two short sentences: name the one pattern that stands out, then suggest one small, "
        "concrete change to their sleep routine."
    )

    try:
        # A 30-night prompt gives gpt-oss more to reason about before it
        # writes anything visible -- 150 tokens was enough budget for that
        # hidden reasoning alone and cut the actual reply off mid-sentence.
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            max_tokens=350,
            messages=[CHAT_SYSTEM_PROMPT, {"role": "user", "content": prompt}],
        )
    except Exception as e:
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 502

    return jsonify({"summary": response.choices[0].message.content})


@app.route("/push/subscribe", methods=["POST"])
@login_required
def push_subscribe():
    """Saves (or clears) the bedtime reminder. `subscription` is only present
    when turning the reminder on -- the browser's PushSubscription object,
    JSON-serialized. `bedtime` null/absent disables the reminder."""
    data = request.json or {}
    bedtime = data.get("bedtime")

    if bedtime:
        if not re.fullmatch(r"[0-2]\d:[0-5]\d", bedtime):
            return jsonify({"error": "bedtime must be HH:MM"}), 400

        sub = data.get("subscription") or {}
        endpoint = sub.get("endpoint")
        keys = sub.get("keys") or {}
        if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
            return jsonify({"error": "missing push subscription"}), 400

        row = PushSubscription.query.filter_by(endpoint=endpoint).first()
        if row is None:
            row = PushSubscription(endpoint=endpoint)
            db.session.add(row)
        row.user_id = current_user.id
        row.p256dh = keys["p256dh"]
        row.auth = keys["auth"]

        current_user.bedtime_reminder = bedtime
        current_user.bedtime_reminder_sent_date = None
    else:
        current_user.bedtime_reminder = None

    db.session.commit()
    return jsonify({"ok": True, "bedtime": current_user.bedtime_reminder})


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
        "due_at": parse_due_datetime(request.form.get("due_date"), request.form.get("due_time")),
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


@app.route("/commitments/decline-draft", methods=["POST"])
@login_required
def decline_draft():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()[:160]
    if not title:
        return jsonify({"error": "Type what you'd be declining first."}), 400
    category = data.get("category")
    if category not in Commitment.CATEGORIES:
        category = "academic"

    upcoming = upcoming_commitments(get_commitments())
    message = draft_decline_message(title, category, upcoming)
    if not message:
        return jsonify({"error": "Couldn't draft one -- try again."}), 500
    return jsonify({"message": message})


@app.route("/commitments/voice/transcribe", methods=["POST"])
@login_required
def voice_transcribe():
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "No audio received"}), 400
    try:
        result = client.audio.transcriptions.create(
            file=(audio.filename or "audio.webm", audio.read()),
            model="whisper-large-v3-turbo",
        )
        return jsonify({"text": (result.text or "").strip()})
    except Exception as e:
        app.logger.exception("voice transcribe failed")
        return jsonify({"error": "Could not transcribe that — try again?"}), 500


@app.route("/commitments/voice/parse", methods=["POST"])
@login_required
def voice_parse_commitment():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "No text to parse"}), 400

    parsed = parse_commitment_from_speech(text)
    if not parsed:
        return jsonify({"error": "Couldn't make out a commitment in that"}), 422

    return jsonify({
        "title": parsed["title"],
        "category": parsed["category"],
        "due_at": parsed["due_at"].strftime("%Y-%m-%dT%H:%M") if parsed["due_at"] else "",
        "movable": parsed["movable"],
    })


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


# Cumulative-session thresholds for the Sunlit Breathing growth badge. Never
# regresses -- a missed day just means no new growth, not a wilted tree.
MEDITATION_GROWTH_STAGES = [
    (0, "seed", "Just a seed"),
    (1, "sprout", "Sprout"),
    (3, "sapling", "Sapling"),
    (6, "young-tree", "Young tree"),
    (11, "blossom", "Full bloom"),
]


def meditation_growth_stage(count):
    key, label = MEDITATION_GROWTH_STAGES[0][1], MEDITATION_GROWTH_STAGES[0][2]
    for threshold, stage_key, stage_label in MEDITATION_GROWTH_STAGES:
        if count >= threshold:
            key, label = stage_key, stage_label
    return key, label


@app.route("/game")
@login_required
def game():
    stage_key, stage_label = meditation_growth_stage(current_user.meditation_sessions_completed)
    return render_template(
        "games.html",
        meditation_stage=stage_key,
        meditation_stage_label=stage_label,
        meditation_count=current_user.meditation_sessions_completed,
    )


@app.route("/game/pressure-valve")
@login_required
def play_pressure_valve():
    return render_template("pressure_valve.html")


@app.route("/game/grow")
@login_required
def play_grow():
    return render_template("grow.html")


@app.route("/game/keep-the-light")
@login_required
def play_keep_the_light():
    return render_template("keep_the_light.html")


@app.route("/game/clear-desk")
@login_required
def play_clear_desk():
    return render_template("clear_desk.html")


@app.route("/game/target-range")
@login_required
def play_target_range():
    return render_template("target_range.html")


@app.route("/meditate")
@login_required
def meditate():
    return render_template("meditate.html")


@app.route("/meditate/complete", methods=["POST"])
@login_required
def meditate_complete():
    current_user.meditation_sessions_completed += 1
    db.session.commit()
    return jsonify({"ok": True, "count": current_user.meditation_sessions_completed})


@app.route("/games/<slug>")
@login_required
def play_game(slug):
    if slug == "targets":
        return render_template("target_range.html")
    titles = {"crush": "Crush a Word", "break": "Break the Pile"}
    if slug not in titles:
        abort(404)
    return render_template("play_game.html", slug=slug, title=titles[slug])


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


# --- Shared Groq prompt (assistant chat is gone; the capacity-insight
#     suggestion in /app/summary still reuses this system prompt) ---

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


# --- Bedtime reminder push notifications ---
#
# ponytail: one thread per process polling every 60s, no job queue. Fine at
# hackathon scale; with multiple gunicorn workers each worker runs its own
# copy, so a user could in theory get a duplicate push in the same minute
# before bedtime_reminder_sent_date commits. Move to a real scheduler
# (Celery beat, APScheduler+Redis lock) if this needs to survive that.
def send_bedtime_push(user):
    payload = json.dumps({
        "title": "Carry",
        "body": "It's your bedtime -- time to start winding down.",
    })
    for sub in list(user.push_subscriptions):
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=VAPID_KEY_PATH,
                vapid_claims={"sub": "mailto:carry-app@example.com"},
            )
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                # Browser dropped the subscription (uninstalled, expired) --
                # stop trying to reach it.
                db.session.delete(sub)
            else:
                print("Bedtime push error:", e)
    db.session.commit()


def _bedtime_reminder_loop():
    while True:
        time_module.sleep(60)
        try:
            with app.app_context():
                now = datetime.now(timezone.utc)
                hhmm = now.strftime("%H:%M")
                today = now.date()
                due = User.query.filter(
                    User.bedtime_reminder == hhmm,
                    or_(User.bedtime_reminder_sent_date.is_(None), User.bedtime_reminder_sent_date != today),
                ).all()
                for user in due:
                    send_bedtime_push(user)
                    user.bedtime_reminder_sent_date = today
                if due:
                    db.session.commit()
        except Exception as e:
            print("Bedtime reminder loop error:", e)


threading.Thread(target=_bedtime_reminder_loop, daemon=True).start()


with app.app_context():
    db.create_all()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)

