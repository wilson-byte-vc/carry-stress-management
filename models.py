from datetime import datetime, timezone

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()


def utcnow():
    return datetime.now(timezone.utc)


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    display_name = db.Column(db.String(80), nullable=False)
    # Only ever the hash -- the raw password is never stored or logged.
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    theme = db.Column(db.String(10), default="light", nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    checkins = db.relationship(
        "CheckIn",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="CheckIn.created_at.desc()",
    )

    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)

    @property
    def latest_checkin(self):
        return self.checkins[0] if self.checkins else None

    def __repr__(self):
        return f"<User {self.email}>"


class CheckIn(db.Model):
    __tablename__ = "checkins"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)

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
