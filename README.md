# UniShare

A static screen-sharing page for GitHub Pages. Start a stream, choose a window, tab, or screen in the browser picker, and send the generated code or link to a viewer. The host can pause, continue, or stop the stream.

## Publish on GitHub Pages

1. Create a GitHub repository and upload `index.html`, `styles.css`, and `app.js` to its root.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, select **Deploy from a branch**.
3. Choose the branch containing the files (usually `main`) and the `/ (root)` folder, then save. Open the Pages URL shown in the settings once deployment finishes.

No build step or backend setup is required. For local development, serve this folder over `http://localhost` (for example, `python -m http.server 8000`). Screen capture requires a secure context such as HTTPS or localhost.

## How it works

The site uses PeerJS Cloud to find peers and WebRTC to send the stream directly between browsers. Keep the generated code and link private: anyone with one can try to join while the stream is active. Each new session gets a new random code. The PeerJS library is loaded from a CDN, so an internet connection is required.

The browser decides which windows, tabs, or screens can be shared. Audio capture support depends on the browser, operating system, and selected source; enabling audio does not guarantee that an audio track is available. You may also need to enable audio in the browser's sharing picker. Some restrictive networks block direct WebRTC connections; a self-hosted signaling service and TURN relay would be needed for broader connectivity. The host sends a separate stream to each viewer, so bandwidth use grows with the number of viewers.
