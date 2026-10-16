require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const cors = require('cors');
const session = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SYSTEM_PROMPT = fs.existsSync(path.join(__dirname, 'system-prompt.txt'))
  ? fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8')
  : 'You are NovaGPT, a helpful professional assistant. Answer in clear English.';
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI)
  : null;

function emptyStore() { return { users: {}, chats: {}, messages: {} }; }
function loadStore() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { return emptyStore(); } }
let store = loadStore();
for (const key of ['users', 'chats', 'messages']) store[key] ||= {};
function persist() { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function clean(value, max = 4000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function publicUser(user) { return user ? { id: user.id, googleId: user.googleId, name: user.name, email: user.email, picture: user.picture } : null; }
function getUser(req) { return req.session.userId ? store.users[req.session.userId] : null; }
function requireUser(req, res, next) { const user = getUser(req); if (!user) return res.status(401).json({ error: 'Google login required.' }); req.user = user; next(); }
function isAdmin(req) { return Boolean(ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN); }
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Admin authentication required.' }); next(); }
function ownedChat(userId, chatId) { const chat = store.chats[chatId]; return chat && chat.userId === userId ? chat : null; }
function chatView(chat) { return { id: chat.id, userId: chat.userId, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt }; }
function messageView(message) { return { ...message, canDelete: message.from === 'admin' }; }
function chatMessages(chatId) { return Object.values(store.messages).filter(m => m.chatId === chatId).sort((a, b) => a.ts - b.ts); }
function createChat(userId, title = 'New chat') { const now = Date.now(); const chat = { id: id('chat'), userId, title: clean(title, 100) || 'New chat', createdAt: now, updatedAt: now }; store.chats[chat.id] = chat; persist(); return chat; }
function addMessage(chat, from, text, extra = {}) { const message = { id: id('msg'), chatId: chat.id, from, text: clean(text), ts: Date.now(), ...extra }; store.messages[message.id] = message; chat.updatedAt = message.ts; persist(); return message; }

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '64kb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'change-this-session-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 } }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'novagpt-api', aiProvider: process.env.GEMINI_API_KEY ? 'gemini-api' : 'pasted-gemini-adapter', time: new Date().toISOString() }));
app.get('/api/me', (req, res) => res.json({ user: publicUser(getUser(req)), googleConfigured: Boolean(google) }));
app.get('/auth/google', (req, res) => {
  if (!google) return res.status(503).send('Google login is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  const state = crypto.randomBytes(20).toString('hex'); req.session.oauthState = state;
  res.redirect(google.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], prompt: 'select_account', state }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!google || !req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid Google login request.');
    const { tokens } = await google.getToken(req.query.code); const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload(); if (!p?.sub || !p.email || p.email_verified === false) return res.status(403).send('A verified Google account is required.');
    const userId = Object.values(store.users).find(u => u.googleId === p.sub)?.id || id('user');
    store.users[userId] = { id: userId, googleId: p.sub, name: clean(p.name || p.email.split('@')[0], 100), email: p.email, picture: p.picture || '', createdAt: store.users[userId]?.createdAt || Date.now(), lastLoginAt: Date.now() };
    req.session.userId = userId; delete req.session.oauthState; persist(); res.redirect('/');
  } catch (error) { console.error('Google login failed:', error.message); res.status(500).send('Google login failed. Check the OAuth redirect URL and credentials.'); }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/chats', requireUser, (req, res) => res.json({ chats: Object.values(store.chats).filter(c => c.userId === req.user.id).sort((a, b) => b.updatedAt - a.updatedAt).map(chatView) }));
app.post('/api/chats', requireUser, (req, res) => res.status(201).json({ chat: chatView(createChat(req.user.id, req.body?.title)) }));
app.patch('/api/chats/:chatId', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); chat.title = clean(req.body?.title, 100) || chat.title; chat.updatedAt = Date.now(); persist(); res.json({ chat: chatView(chat) }); });
app.delete('/api/chats/:chatId', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); for (const message of chatMessages(chat.id)) delete store.messages[message.id]; delete store.chats[chat.id]; persist(); res.status(204).end(); });
app.get('/api/chats/:chatId/messages', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); res.json({ chat: chatView(chat), messages: chatMessages(chat.id).map(messageView) }); });

async function officialGemini(prompt, history) {
  const contents = history.slice(-20).map(m => ({ role: m.from === 'admin' ? 'model' : 'user', parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const response = await axios.post(url, { system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents }, { timeout: 45000 });
  return response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
}

let pastedConfig = { cookie: null, snlm0e: null, fsid: null, conversation_id: '', response_id: '', choice_id: '' };
async function pastedSync(method = 'GET', data = null) { const url = process.env.UNOFFICIAL_GEMINI_FIREBASE_URL || 'https://puru-tools-default-rtdb.firebaseio.com/sessions/google.json'; if (method === 'GET') { const r = await axios.get(url, { timeout: 15000 }); const d = r.data || {}; pastedConfig = { ...pastedConfig, cookie: d.cookie_string || d.cookie, snlm0e: d.snlm0e, fsid: d.fsid, conversation_id: d.conversation_id || '', response_id: d.response_id || '', choice_id: d.choice_id || '' }; } else await axios.patch(url, { ...data, last_updated: new Date().toISOString() }, { timeout: 15000 }); }
function parsePastedResponse(raw) { let result = { text: '', convId: '', respId: '', choiceId: '' }; for (const line of String(raw).split('\n')) { if (!line.trim().startsWith('[[')) continue; try { for (const part of JSON.parse(line.trim())) if (part[0] === 'wrb.fr') { const inner = JSON.parse(part[2]); if (inner?.[4]) for (const c of inner[4]) if (c?.[1]?.[0]) result.text = c[1][0]; if (inner?.[1]) { result.convId = inner[1][0]; result.respId = inner[1][1]; } if (inner?.[4]?.[0]?.[0]) result.choiceId = inner[4][0][0]; } } catch (_) {} } return result; }
async function pastedGemini(prompt) { await pastedSync('GET'); const englishPrompt = `${SYSTEM_PROMPT}\n\nRespond in clear professional English only.\n\nUser question: ${prompt}`; const url = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'; const params = new URLSearchParams({ bl: process.env.GEMINI_BL || 'boq_assistant-bard-web-server_20260208.13_p0', _reqid: Math.floor(Math.random() * 900000), rt: 'c', 'f.sid': pastedConfig.fsid }); const reqData = [null, JSON.stringify([[englishPrompt, 0, null, null, null, null, 0], ['id'], [pastedConfig.conversation_id, pastedConfig.response_id, pastedConfig.choice_id, null, null, null, null, null, null, ''], ''])]; const r = await axios.post(`${url}?${params}`, `f.req=${encodeURIComponent(JSON.stringify(reqData))}&at=${encodeURIComponent(pastedConfig.snlm0e)}&`, { headers: { Cookie: pastedConfig.cookie, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0', Referer: 'https://gemini.google.com/' }, timeout: 45000 }); const parsed = parsePastedResponse(r.data); if (!parsed.text) throw new Error('Empty unofficial Gemini response'); await pastedSync('PATCH', { cookie_string: r.headers['set-cookie']?.join('; ') || pastedConfig.cookie, conversation_id: parsed.convId, response_id: parsed.respId, choice_id: parsed.choiceId }); return parsed.text; }
async function askAI(prompt, history) { if (process.env.GEMINI_API_KEY) return officialGemini(prompt, history); return pastedGemini(prompt); }

app.post('/api/chats/:chatId/messages', requireUser, async (req, res) => {
  const chat = ownedChat(req.user.id, req.params.chatId); const text = clean(req.body?.text); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); if (!text) return res.status(400).json({ error: 'Message text is required.' });
  const userMessage = addMessage(chat, 'user', text, { userId: req.user.id, name: req.user.name });
  try { const answer = await askAI(text, chatMessages(chat.id).filter(m => m.id !== userMessage.id)); const aiMessage = addMessage(chat, 'ai', answer || 'I could not generate a response right now.', { userId: req.user.id, name: 'NovaGPT' }); res.status(201).json({ messages: [messageView(userMessage), messageView(aiMessage)] }); }
  catch (error) { console.error('AI error:', error.message); res.status(502).json({ error: 'The AI service is temporarily unavailable.', message: messageView(userMessage) }); }
});

app.get('/api/admin/conversations', requireAdmin, (_req, res) => { const chats = Object.values(store.chats).sort((a, b) => b.updatedAt - a.updatedAt).map(c => ({ ...chatView(c), user: publicUser(store.users[c.userId]), messages: chatMessages(c.id).map(messageView) })); res.json({ chats }); });
app.post('/api/admin/chats/:chatId/messages', requireAdmin, (req, res) => { const chat = store.chats[req.params.chatId]; const text = clean(req.body?.text); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); if (!text) return res.status(400).json({ error: 'Reply text is required.' }); res.status(201).json({ message: messageView(addMessage(chat, 'admin', text, { name: 'Admin' })) }); });
app.delete('/api/admin/messages/:messageId', requireAdmin, (req, res) => { const message = store.messages[req.params.messageId]; if (!message) return res.status(404).json({ error: 'Message not found.' }); if (message.from !== 'admin') return res.status(403).json({ error: 'Admins can only unsend their own messages.' }); delete store.messages[message.id]; const chat = store.chats[message.chatId]; if (chat) chat.updatedAt = Date.now(); persist(); res.status(204).end(); });

app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`NovaGPT API listening on ${PORT}`));
