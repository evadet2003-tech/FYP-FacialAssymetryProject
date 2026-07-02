# Facial Asymmetry Analysis Prototype
**Student:** Sasi Grada | **ID:** W1947920 | 

## Live Application
Visit the deployed app here — no setup required:
- **Frontend:** https://fyp-facialassymetryproject-production.up.railway.app
- **Demo Login:** username: `admin` | password: `12345`

## Architecture
This is a full 3-tier web application deployed on Railway:
- **Tier 1 - Frontend:** React + TypeScript (Railway)
- **Tier 2 - Backend:** Flask REST API with JWT authentication (Railway)
- **Tier 3 - Database:** PostgreSQL - stores users and analysis sessions (Railway)

## Features
- User registration and login with JWT authentication
- 468-point facial landmark detection using MediaPipe
- 8-step guided analysis wizard
- 3D mesh visualization with Plotly
- Regional harmony analysis with radar charts
- Save and delete analysis sessions to PostgreSQL database
- Download CSV export of results
- Session history and side-by-side comparison

## Running Locally
The backend and database are fully hosted on Railway — no local backend setup is needed.

To run the frontend locally:
```bash
npm install
npm run dev
```
Then visit http://localhost:5173 — it will automatically connect to the live Railway backend and database.

## Tech Stack
- React, TypeScript, Vite
- MediaPipe (facial landmark detection)
- Plotly (3D mesh visualization)
- Recharts (charts and radar)
- Flask, Flask-JWT-Extended, Flask-SQLAlchemy (backend)
- PostgreSQL (database)
- Railway (deployment)