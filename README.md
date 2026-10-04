# together — YouTube Watch Party

A real-time watch party with synchronized YouTube playback, room roles, approval requests, and chat. The frontend and backend are intentionally separated into their own folders.

## Stack

- **Frontend:** React, TypeScript, Vite, YouTube IFrame Player API, Socket.IO client
- **Backend:** Node.js, Express, TypeScript, Socket.IO
- **Room storage:** In-memory for this MVP; active rooms are removed when their last participant leaves or the server restarts.

## Run locally

Use Node.js 20 or newer. In separate terminals:

```sh
cd backend
npm install
npm run dev
```

```sh
cd frontend
npm install
npm run dev
```

Open the Vite URL printed in the frontend terminal (normally `http://localhost:5173`). The backend listens on `http://localhost:3001`; its health endpoint is `/health`.

For deployment, use the root `render.yaml` Blueprint to create a Render web service for the Socket.IO backend and a static site for the frontend. The frontend reads the backend hostname from the Blueprint at build time. Both services must support persistent WebSocket connections.

## How it works

The browser connects to the Socket.IO server and creates or joins a room using an 8-character code. The backend owns each room's participants, roles, playback state, and pending requests, and broadcasts room updates to its members. A private per-browser session token allows a participant to reconnect without exposing that token in room data. A host or moderator can control playback; participant controls are rejected by the backend and are sent as approval requests instead. The YouTube IFrame Player API applies the server's video, playlist selection, play/pause, and seek state in each browser. Paste a YouTube playlist URL to load its items, then use previous/next to move together; individual YouTube videos and live stream links are also supported. If browser autoplay restrictions block playback for a joiner, the player offers a click-to-sync action. Videos whose owners disable embedding cannot play in the room. The host can promote moderators, remove participants, and transfer ownership. Room chat, animated GIF uploads (up to 512 KB), and heart/like/laugh/fire reactions are broadcast live over the same Socket.IO connection. Messages and reactions are temporary and are not stored after leaving the room or restarting the server.

Rooms are ephemeral and live in one server process. Add persistent storage and a Socket.IO adapter such as Redis before using multiple backend instances or requiring rooms to survive restarts.

## Deployment

The Render Blueprint builds the frontend with `VITE_API_URL` pointing at the backend service. Deploy both services from the repository's `render.yaml`; the frontend and backend must use the same Socket.IO server.

| Service | URL |
| --- | --- |
| Frontend | https://together-watch-party-31rm.onrender.com |
| Backend health | https://together-watch-party-api.onrender.com/health |

The Blueprint allows cross-origin requests to the public API so the frontend can connect without extra configuration. Anyone with a room link can join; rooms are in-memory and are lost when the free web service sleeps or restarts. GIFs are sent directly to current room members and are not uploaded to persistent storage. Use persistent storage and a paid always-on service for a production deployment.
