# Facial Assymetry SAAS (Web App)

A full React + TypeScript SaaS-style web project built from original prototype direction.

## Core modules

- Landing page (modern/futuristic style)
- About page
- Features page
- Secure login and log off
- Protected dashboard route
- Facial asymmetry analysis engine (image-based)
- Regional 0-1000 score output (Eyes, Eyebrows, Lips, Nose, Jawline)
- Severity classification and asymmetry index
- Recommendation generation
- Radar chart analytics view
- CSV report export
- Local analysis history tracking

## Admin credentials

- Username: `admin`
- Password: `12345`

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Notes

- The app stores session and history in browser local storage.
- Analysis is deterministic for each uploaded image and designed to preserve the prototype scoring style while fitting a modern web SaaS UX.
