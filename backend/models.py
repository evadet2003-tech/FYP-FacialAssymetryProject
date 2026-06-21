from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import json

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.String, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    role = db.Column(db.String(20), default='analyst')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    sessions = db.relationship('Session', backref='user', lazy=True)

class Session(db.Model):
    __tablename__ = 'sessions'
    
    id = db.Column(db.String, primary_key=True)
    user_id = db.Column(db.String, db.ForeignKey('users.id'), nullable=False)
    image_data_url = db.Column(db.Text, nullable=False)
    result = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def result_as_dict(self):
        return json.loads(self.result)