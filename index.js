require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SYSTEM_PROMPT = fs.existsSync(path.join(__dirname, 'system-prompt.txt'))
  ? fs.readFileSync(path.join(__dirname, 'system-prompt.txt'), 'utf8')
  : 'You are NovaGPT, a helpful professional assistant. Answer in clear English.';
function emptyStore() { return { users: {}, chats: {}, messages: {} }; }
function loadStore() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { return emptyStore(); } }
let store = loadStore();
for (const key of ['users', 'chats', 'messages']) store[key] ||= {};
function persist() { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function clean(value, max = 4000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function publicUser(user) { return user ? { id: user.id, name: user.name, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt } : null; }
function getUser(req) { return req.session.userId ? store.users[req.session.userId] : null; }
function requireUser(req, res, next) { const user = getUser(req); if (!user) return res.status(401).json({ error: 'Please log in with your name and password.' }); req.user = user; next(); }
function isAdmin(req) { return Boolean(ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN); }
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Admin authentication required.' }); next(); }
function ownedChat(userId, chatId) { const chat = store.chats[chatId]; return chat && chat.userId === userId ? chat : null; }
function chatView(chat) { return { id: chat.id, userId: chat.userId, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt }; }
function messageView(message) { return { ...message, canDelete: message.from === 'admin' || message.from === 'ai' }; }
function chatMessages(chatId) { return Object.values(store.messages).filter(m => m.chatId === chatId).sort((a, b) => a.ts - b.ts); }
function createChat(userId, title = 'New chat') { const now = Date.now(); const chat = { id: id('chat'), userId, title: clean(title, 100) || 'New chat', createdAt: now, updatedAt: now }; store.chats[chat.id] = chat; persist(); return chat; }
function addMessage(chat, from, text, extra = {}) { const message = { id: id('msg'), chatId: chat.id, from, text: clean(text), ts: Date.now(), ...extra }; store.messages[message.id] = message; chat.updatedAt = message.ts; persist(); return message; }
function normalizeName(value) { return clean(value, 80).replace(/\s+/g, ' '); }
function nameKey(value) { return normalizeName(value).toLowerCase(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }; }
function passwordMatches(password, user) { const actual = crypto.scryptSync(password, user.passwordSalt, 64); const expected = Buffer.from(user.passwordHash, 'hex'); return actual.length === expected.length && crypto.timingSafeEqual(actual, expected); }

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '64kb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'change-this-session-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 } }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'novagpt-api', aiProvider: process.env.GEMINI_API_KEY ? 'gemini-api' : 'pasted-gemini-adapter', time: new Date().toISOString() }));
app.get('/api/me', (req, res) => res.json({ user: publicUser(getUser(req)) }));
app.post('/api/signup', (req, res) => {
  const name = normalizeName(req.body?.name); const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (Object.values(store.users).some(u => nameKey(u.name) === nameKey(name))) return res.status(409).json({ error: 'That name is already registered. Please choose another.' });
  const credentials = hashPassword(password); const user = { id: id('user'), name, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: Date.now(), lastLoginAt: Date.now() };
  store.users[user.id] = user; req.session.userId = user.id; persist(); res.status(201).json({ user: publicUser(user) });
});
app.post('/api/login', (req, res) => {
  const name = normalizeName(req.body?.name); const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = Object.values(store.users).find(u => nameKey(u.name) === nameKey(name));
  if (!user || !user.passwordHash || !passwordMatches(password, user)) return res.status(401).json({ error: 'Incorrect name or password.' });
  user.lastLoginAt = Date.now(); req.session.userId = user.id; persist(); res.json({ user: publicUser(user) });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/chats', requireUser, (req, res) => res.json({ chats: Object.values(store.chats).filter(c => c.userId === req.user.id).sort((a, b) => b.updatedAt - a.updatedAt).map(chatView) }));
app.post('/api/chats', requireUser, (req, res) => res.status(201).json({ chat: chatView(createChat(req.user.id, req.body?.title)) }));
app.patch('/api/chats/:chatId', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); chat.title = clean(req.body?.title, 100) || chat.title; chat.updatedAt = Date.now(); persist(); res.json({ chat: chatView(chat) }); });
app.delete('/api/chats/:chatId', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); for (const message of chatMessages(chat.id)) delete store.messages[message.id]; delete store.chats[chat.id]; persist(); res.status(204).end(); });
app.get('/api/chats/:chatId/messages', requireUser, (req, res) => { const chat = ownedChat(req.user.id, req.params.chatId); if (!chat) return res.status(404).json({ error: 'Chat not found.' }); res.json({ chat: chatView(chat), messages: chatMessages(chat.id).map(messageView) }); });

async function officialGemini(prompt, history) {
  const contents = history.slice(-20).map(m => ({ role: m.from === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ text: `${prompt}\n\nIf you provide code, return a complete runnable answer. Do not omit sections or stop in the middle of a file.` }] });
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const request = () => axios.post(url, { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents, generationConfig: { maxOutputTokens: 8192, temperature: 0.25 } }, { timeout: 60000 });
  let response = await request();
  let candidate = response.data?.candidates?.[0];
  let text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
  let finishReason = candidate?.finishReason;
  for (let continuation = 0; continuation < 2 && finishReason === 'MAX_TOKENS'; continuation += 1) {
    contents.push({ role: 'model', parts: [{ text }] });
    contents.push({ role: 'user', parts: [{ text: 'Continue exactly from where you stopped. Return only the missing continuation, with no explanation and no repeated content.' }] });
    response = await request();
    candidate = response.data?.candidates?.[0];
    text += candidate?.content?.parts?.map(p => p.text || '').join('') || '';
    finishReason = candidate?.finishReason;
  }
  return text.trim();
}

let pastedConfig = { cookie: null, snlm0e: null, fsid: null, conversation_id: '', response_id: '', choice_id: '' };
async function pastedSync(method = 'GET', data = null) { const url = process.env.UNOFFICIAL_GEMINI_FIREBASE_URL || 'https://puru-tools-default-rtdb.firebaseio.com/sessions/google.json'; if (method === 'GET') { const r = await axios.get(url, { timeout: 15000 }); const d = r.data || {}; pastedConfig = { ...pastedConfig, cookie: d.cookie_string || d.cookie, snlm0e: d.snlm0e, fsid: d.fsid, conversation_id: d.conversation_id || '', response_id: d.response_id || '', choice_id: d.choice_id || '' }; } else await axios.patch(url, { ...data, last_updated: new Date().toISOString() }, { timeout: 15000 }); }
function parsePastedResponse(raw) { let result = { text: '', convId: '', respId: '', choiceId: '' }; for (const line of String(raw).split('\n')) { if (!line.trim().startsWith('[[')) continue; try { for (const part of JSON.parse(line.trim())) if (part[0] === 'wrb.fr') { const inner = JSON.parse(part[2]); if (inner?.[4]) for (const c of inner[4]) if (c?.[1]?.[0]) { const candidate = String(c[1][0]); if (candidate.length > result.text.length) result.text = candidate; } if (inner?.[1]) { result.convId = inner[1][0]; result.respId = inner[1][1]; } if (inner?.[4]?.[0]?.[0]) result.choiceId = inner[4][0][0]; } } catch (_) {} } return result; }
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
app.delete('/api/admin/messages/:messageId', requireAdmin, (req, res) => { const message = store.messages[req.params.messageId]; if (!message) return res.status(404).json({ error: 'Message not found.' }); if (!['admin', 'ai'].includes(message.from)) return res.status(403).json({ error: 'Admins can only unsend admin or AI messages.' }); delete store.messages[message.id]; const chat = store.chats[message.chatId]; if (chat) chat.updatedAt = Date.now(); persist(); res.status(204).end(); });

const frontendPath = path.join(__dirname, 'index.html');
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (fs.existsSync(frontendPath)) return res.sendFile(frontendPath);
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.status(404).send('NovaGPT API is running. Upload index.html and adminsecret.html to enable the website pages.');
});
app.listen(PORT, '0.0.0.0', () => console.log(`NovaGPT API listening on ${PORT}`));
