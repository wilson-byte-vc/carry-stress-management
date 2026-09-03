from datetime import datetime, timezone

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def utcnow():
    return datetime.now(timezone.utc)


class Profile(UserMixin, db.Model):
    """Application-side data for a Supabase auth user.

    Supabase owns credentials -- there is deliberately no password column here.
    `id` is the UUID from auth.users, so this table joins straight to it.
    """

    __tablename__ = "profiles"

    id = db.Column(db.String(36), primary_key=True)  # Supabase auth user UUID
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    display_name = db.Column(db.String(80), nullable=False)
    # Authorisation lives here, server-side -- never in the JWT, or a user
    # could edit their own token claims and promote themselves.
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    theme = db.Column(db.String(10), default="light", nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    checkins = db.relationship(
        "CheckIn",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="CheckIn.created_at.desc()",
    )

    def get_id(self):
        # Flask-Login stores this in the session cookie; ours is a UUID string.
        return self.id

    @property
    def latest_checkin(self):
        return self.checkins[0] if self.checkins else None

    def __repr__(self):
        return f"<Profile {self.email}>"


class CheckIn(db.Model):
    __tablename__ = "checkins"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.String(36), db.ForeignKey("profiles.id"), nullable=False, index=True
    )

    time = db.Column(db.Integer, nullable=False)
    social = db.Column(db.Integer, nullable=False)
    physical = db.Column(db.Integer, nullable=False)
    mental = db.Column(db.Integer, nullable=False)
    note = db.Column(db.Text, default="", nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    user = db.relationship("Profile", back_populates="checkins")

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
