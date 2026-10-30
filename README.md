# NovaGPT Render deployment

This is the complete NovaGPT project. Render must deploy the folder containing `index.js`, `package.json`, `index.html`, `adminsecret.html`, and `system-prompt.txt`.

## Required project root

```text
index.js
package.json
package-lock.json
index.html
adminsecret.html
system-prompt.txt
render.yaml
```

If these files are inside a subfolder in GitHub, set Render's **Root Directory** to that subfolder. Do not deploy only `index.js` and `package.json`; the website pages must be in the same deployed root.

## Render settings

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node
- `NODE_ENV=production`
- `SESSION_SECRET=<long random secret>`
- `ADMIN_TOKEN=<long random admin token>`
- `CORS_ORIGIN=https://novagpt.xo.je`
- `GEMINI_API_KEY=<Gemini API key>`
- `GEMINI_MODEL=gemini-2.0-flash`

The server now returns a clear message instead of throwing `ENOENT` if `index.html` is missing, but the correct fix is to deploy the complete project root.

## Authentication

Users create accounts and log in using only a name and password. Passwords are stored as salted scrypt hashes. Google/Gmail OAuth is not used.

## Main changes in this version

`index.js` contains the Express server, name/password signup and login, sessions, multiple-chat APIs, server-side chat memory, Gemini AI integration, admin authentication, admin replies, admin-message unsend, static file serving, and the missing-frontend fallback.

The Gemini request now sends the prompt using the API's `systemInstruction` field and maps previous NovaGPT responses to the `model` role. This prevents the system prompt from being silently ignored.

`index.html` contains the user login/signup forms, chat list, new-chat control, AI conversation UI, and copy buttons for AI replies.

`adminsecret.html` contains the admin inbox, user/chat memory details, manual replies, and Unsend buttons for both AI responses and admin-written messages. User messages cannot be deleted by the admin.

`package.json` contains the Node start command and dependencies for Express, sessions, CORS, dotenv, and the AI HTTP client.

`system-prompt.txt` contains the supplied NovaGPT system prompt used by the AI backend.
