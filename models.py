from datetime import datetime, timezone

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.dialects.postgresql import UUID

db = SQLAlchemy()

# Real `uuid` column on Postgres so it can carry a foreign key to auth.users,
# while as_uuid=False keeps handing Python plain strings -- Flask-Login stores
# the id in a cookie and compares it as text. Degrades to a plain string column
# on SQLite so local dev without Supabase still works.
UserId = db.String(36).with_variant(UUID(as_uuid=False), "postgresql")


def utcnow():
    return datetime.now(timezone.utc)


class User(UserMixin, db.Model):
    """Application-side data for a Supabase auth user.

    Supabase owns credentials -- there is deliberately no password column here.
    `id` mirrors auth.users.id, and the SQL migration adds a real foreign key
    to auth.users so deleting the auth user cascades everything here away.
    """

    __tablename__ = "users"

    id = db.Column(UserId, primary_key=True)  # = auth.users.id
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    display_name = db.Column(db.String(80), nullable=False)
    theme = db.Column(db.String(10), default="light", nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    # "HH:MM" in UTC, null = reminder off. bedtime_reminder_sent_date guards
    # against re-sending every minute the clock matches while it's on.
    bedtime_reminder = db.Column(db.String(5), nullable=True)
    bedtime_reminder_sent_date = db.Column(db.Date, nullable=True)

    checkins = db.relationship(
        "CheckIn",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="CheckIn.created_at.desc()",
    )
    commitments = db.relationship(
        "Commitment",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="Commitment.due_at",
    )
    insights = db.relationship(
        "Insight",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="Insight.created_at.desc()",
    )
    activity_sessions = db.relationship(
        "ActivitySession",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="ActivitySession.started_at",
    )
    push_subscriptions = db.relationship(
        "PushSubscription",
        back_populates="user",
        cascade="all, delete-orphan",
    )

    def get_id(self):
        # Flask-Login stores this in the session cookie; ours is a UUID string.
        return self.id

    @property
    def latest_checkin(self):
        return self.checkins[0] if self.checkins else None

    def __repr__(self):
        return f"<User {self.email}>"


class CheckIn(db.Model):
    __tablename__ = "check_ins"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        UserId, db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    time = db.Column(db.Integer, nullable=False)
    social = db.Column(db.Integer, nullable=False)
    physical = db.Column(db.Integer, nullable=False)
    mental = db.Column(db.Integer, nullable=False)
    note = db.Column(db.Text, default="", nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="checkins")

    @property
    def capacity(self):
        levels = [self.time, self.social, self.physical, self.mental]
        return round(sum(levels) / (len(levels) * 5) * 100)

    def as_dict(self):
        return {
            "time": self.time,
            "social": self.social,
            "physical": self.physical,
            "mental": self.mental,
            "note": self.note,
        }

    def __repr__(self):
        return f"<CheckIn user={self.user_id} {self.created_at:%Y-%m-%d}>"


class Commitment(db.Model):
    """Something taking up the student's capacity.

    `movable` is the point of this table: a fixed commitment (a lecture, a
    shift) can't be rescheduled, a movable one (an essay, gym, coffee with a
    friend) can -- which is what makes it possible to suggest shifting load off
    a heavy day instead of just telling someone they're overloaded.
    """

    __tablename__ = "commitments"

    CATEGORIES = ("academic", "work", "social", "health", "personal")

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        UserId, db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    title = db.Column(db.String(160), nullable=False)
    category = db.Column(db.String(20), default="academic", nullable=False)
    movable = db.Column(db.Boolean, default=True, nullable=False)
    due_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    # How draining this is, on the same 1-5 scale as a check-in slider.
    effort = db.Column(db.Integer, default=3, nullable=False)
    completed = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="commitments")

    def __repr__(self):
        kind = "movable" if self.movable else "fixed"
        return f"<Commitment {self.title!r} {kind}>"


class Insight(db.Model):
    """A generated observation about the user's patterns.

    Written server-side (from check-in history, or by the assistant) -- users
    read and dismiss them but never author them, which the RLS policies
    enforce.
    """

    __tablename__ = "insights"

    SEVERITIES = ("low", "medium", "high")

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        UserId, db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    title = db.Column(db.String(200), nullable=False)
    body = db.Column(db.Text, default="", nullable=False)
    tag = db.Column(db.String(40), default="pattern", nullable=False)
    severity = db.Column(db.String(10), default="low", nullable=False)
    action_label = db.Column(db.String(80), nullable=True)
    acted_on = db.Column(db.Boolean, default=False, nullable=False)
    dismissed = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="insights")

    def __repr__(self):
        return f"<Insight {self.title!r} {self.severity}>"


class ActivitySession(db.Model):
    """One stretch of the app being open in a tab, used as a proxy for sleep.

    Not a per-heartbeat log -- one row per open/close cycle. `last_ping_at`
    advances every couple of minutes while the tab is visible, so a session
    that never gets a clean `ended_at` (tab killed, not just backgrounded)
    still has a recent enough timestamp to compute an overnight gap against.
    """

    __tablename__ = "activity_sessions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        UserId, db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    started_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    last_ping_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    ended_at = db.Column(db.DateTime, nullable=True)

    user = db.relationship("User", back_populates="activity_sessions")

    def __repr__(self):
        return f"<ActivitySession user={self.user_id} started={self.started_at:%Y-%m-%d %H:%M}>"


class PushSubscription(db.Model):
    """A browser's Web Push endpoint, saved when a user turns on the bedtime
    reminder. `endpoint` is unique per browser/device -- re-subscribing the
    same one (e.g. after re-enabling) replaces its keys instead of piling up
    duplicates."""

    __tablename__ = "push_subscriptions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        UserId, db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    endpoint = db.Column(db.Text, unique=True, nullable=False)
    p256dh = db.Column(db.String(255), nullable=False)
    auth = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("User", back_populates="push_subscriptions")

    def __repr__(self):
        return f"<PushSubscription user={self.user_id}>"
