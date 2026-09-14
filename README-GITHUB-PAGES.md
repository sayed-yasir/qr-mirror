# QR Mirror V1 — GitHub Pages

This is the simple online V1 of QR Mirror (دریچه).

## What this version uses

- GitHub Pages for the frontend
- PeerJS Cloud for signaling
- WebRTC for peer-to-peer chat/file/voice/screen-share
- No Node/Express backend is required to publish this V1
- No private API keys are placed in the frontend

## Publish

1. Create a GitHub repository, for example `qr-mirror`.
2. Upload all files from this folder to the repository root.
3. Push to the `main` branch.
4. Open GitHub → Settings → Pages.
5. Under Build and deployment, choose **GitHub Actions**.
6. Wait for the `Deploy QR Mirror to GitHub Pages` workflow to finish.
7. Open the generated Pages URL.

The Vite build uses relative asset paths, so it works from a repository URL such as:
`https://YOUR-USERNAME.github.io/qr-mirror/`

## Important V1 limitation

This GitHub-only version does not provide the private backend room validation, persistent room storage, self-hosted PeerServer, or TURN credentials from the full project.

WebRTC can work directly through PeerJS/WebRTC when the network allows it. Some restrictive networks require a TURN relay; GitHub Pages cannot run a TURN server.

Do not put secrets such as TURN_SECRET or server JWT secrets in the frontend.
