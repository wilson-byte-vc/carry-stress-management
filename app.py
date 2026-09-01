from flask import Flask, render_template, request, redirect, url_for, flash, session
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate


import os

app = Flask(__name__)

# --- Public Pages ---

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/home")
def home():
    return render_template("home.html")

@app.route("/checkin")
def checkin():
    return render_template("checkin.html")

@app.route("/insights")
def insights():
    return render_template("insights.html")

if __name__ == "__main__":
    app.run(debug=False, port=5000)
