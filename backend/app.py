from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, get_jwt_identity
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, User, Session
from dotenv import load_dotenv
import os
import uuid
import json
from datetime import datetime

load_dotenv()


app = Flask(__name__)
CORS(app, origins=["http://localhost:5173", "https://fyp-facialassymetryproject-production.up.railway.app"])

app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY')
from datetime import timedelta
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=24)

db.init_app(app)
jwt = JWTManager(app)

with app.app_context():
    db.create_all()

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    if User.query.filter_by(username=data['username']).first():
        return jsonify({'message': 'Username already exists'}), 400
    hashed_password = generate_password_hash(data['password'])
    user = User(
        id=str(uuid.uuid4()),
        username=data['username'],
        password=hashed_password,
        name=data['name'],
        email=data['email']
    )
    db.session.add(user)
    db.session.commit()
    token = create_access_token(identity=user.id)
    return jsonify({'token': token, 'user': {'id': user.id, 'username': user.username, 'name': user.name, 'email': user.email, 'role': user.role}}), 201

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    user = User.query.filter_by(username=data['username']).first()
    if not user or not check_password_hash(user.password, data['password']):
        return jsonify({'message': 'Invalid credentials'}), 401
    token = create_access_token(identity=user.id)
    return jsonify({'token': token, 'user': {'id': user.id, 'username': user.username, 'name': user.name, 'email': user.email, 'role': user.role}}), 200

@app.route('/api/sessions', methods=['POST'])
@jwt_required()
def save_session():
    user_id = get_jwt_identity()
    data = request.get_json()
    session = Session(
        id=str(uuid.uuid4()),
        user_id=user_id,
        image_data_url=data['imageDataUrl'],
        result=json.dumps(data['result'])
    )
    db.session.add(session)
    db.session.commit()
    return jsonify({'message': 'Session saved', 'id': session.id}), 201

@app.route('/api/sessions', methods=['GET'])
@jwt_required()
def get_sessions():
    user_id = get_jwt_identity()
    sessions = Session.query.filter_by(user_id=user_id).order_by(Session.created_at.desc()).all()
    return jsonify([{
        'id': s.id,
        'userId': s.user_id,
        'imageDataUrl': s.image_data_url,
        'result': s.result_as_dict(),
        'createdAt': s.created_at.isoformat()
    } for s in sessions]), 200

@app.route('/api/sessions/<session_id>', methods=['DELETE'])
@jwt_required()
def delete_session(session_id):
    user_id = get_jwt_identity()
    session = Session.query.filter_by(id=session_id, user_id=user_id).first()
    if not session:
        return jsonify({'message': 'Session not found'}), 404
    db.session.delete(session)
    db.session.commit()
    return jsonify({'message': 'Session deleted'}), 200

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))