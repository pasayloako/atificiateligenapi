const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'selovasx2024';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const conversations = new Map();

app.set('trust proxy', 1);
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(v => v.trim()), credentials: false }));
app.use(express.json({ limit: '32kb' }));

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
}

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function getConversation(id, name = 'Guest') {
  if (!conversations.has(id)) {
    conversations.set(id, { id, name: cleanText(name) || 'Guest', updatedAt: Date.now(), messages: [] });
  }
  const conversation = conversations.get(id);
  if (name && name !== 'Guest') conversation.name = cleanText(name);
  return conversation;
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return process.env.NODE_ENV !== 'production';
  return req.get('x-admin-token') === ADMIN_TOKEN || req.query.token === ADMIN_TOKEN;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin authentication required.' });
  next();
}

function publicConversation(conversation) {
  return { id: conversation.id, name: conversation.name, updatedAt: conversation.updatedAt, messages: conversation.messages };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nova-chat-api', time: new Date().toISOString(), conversations: conversations.size });
});

app.get('/api/conversations', requireAdmin, (_req, res) => {
  const result = [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(publicConversation);
  res.json({ conversations: result });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  const conversation = getConversation(req.params.id);
  res.json(publicConversation(conversation));
});

app.post('/api/conversations/:id/messages', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  const conversation = getConversation(req.params.id, req.body?.name);
  const message = { id: crypto.randomUUID(), from: 'user', text, name: conversation.name, ts: Date.now() };
  conversation.messages.push(message);
  conversation.updatedAt = message.ts;
  res.status(201).json({ message, conversation: publicConversation(conversation) });
});

app.post('/api/conversations/:id/replies', requireAdmin, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Reply text is required.' });
  const conversation = getConversation(req.params.id);
  const message = { id: crypto.randomUUID(), from: 'admin', text, name: 'Admin', ts: Date.now() };
  conversation.messages.push(message);
  conversation.updatedAt = message.ts;
  res.status(201).json({ message, conversation: publicConversation(conversation) });
});

app.delete('/api/conversations/:id', requireAdmin, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id.' });
  conversations.delete(req.params.id);
  res.status(204).end();
});

app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nova Chat API listening on port ${PORT}`);
  if (!ADMIN_TOKEN) console.warn('ADMIN_TOKEN is not set; admin routes are open outside production. Set it on Render.');
});
