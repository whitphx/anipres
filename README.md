# Anipres

Whiteboard-style animation and presentation tool.

- [anipres.app](https://anipres.app): Anipres web application.
- [`slidev-addon-anipres`](https://www.npmjs.com/package/slidev-addon-anipres): Slidev addon to embed Anipres in your Slidev presentation.

## Phase 1 Sync Smoke Test

To verify the current Phase 1 Cloudflare Worker sync path locally:

1. Build the shared library package:
   `pnpm --filter anipres build`
2. Start the worker:
   `pnpm --filter worker dev`
3. Start the app with sync enabled and the worker URL configured:

   ```bash
   VITE_TLDRAW_SYNC_ENABLED=true \
   VITE_TLDRAW_SYNC_WORKER_URL=http://127.0.0.1:8787 \
   pnpm --filter app dev
   ```

4. Open the app in two browser tabs and edit the same document.
5. Confirm both tabs stay in `Sync online` and changes appear in the other tab in real time.
