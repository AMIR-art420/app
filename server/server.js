// سرور پیام‌رسان: اتاق‌های رمزدار + چت لحظه‌ای + جستجوی فارسی/انگلیسی
const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const KEEP_DAYS = +process.env.KEEP_DAYS || 30; // پیام‌های قدیمی‌تر پاک می‌شوند
const MAX_OWN = +process.env.MAX_ROOMS_PER_USER || 5; // سقف اتاق‌هایی که هر نفر می‌تواند بسازد
const MAX_SUBS = 50; // سقف اتاق‌های عضو در یک اتصال
const db = new Database(process.env.DB || path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT, norm TEXT, compact TEXT UNIQUE, salt TEXT, hash TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, room INTEGER, nick TEXT, text TEXT, ts INTEGER, user_id INTEGER, user_profile TEXT);
CREATE INDEX IF NOT EXISTS m_room ON msgs(room, id);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT, profile TEXT, created INTEGER);`);
// مهاجرت: ستون سازنده‌ی اتاق (هش شناسه‌ی دستگاه)
if (!db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'owner')) db.exec('ALTER TABLE rooms ADD COLUMN owner TEXT');
db.exec('CREATE INDEX IF NOT EXISTS r_owner ON rooms(owner)');
if (!db.prepare('PRAGMA table_info(msgs)').all().some(c => c.name === 'user_id')) db.exec('ALTER TABLE msgs ADD COLUMN user_id INTEGER');
if (!db.prepare('PRAGMA table_info(msgs)').all().some(c => c.name === 'user_profile')) db.exec('ALTER TABLE msgs ADD COLUMN user_profile TEXT');

// توکن عضویت: بعد از ورود با رمز، سرور یک توکن امضاشده می‌دهد تا برای اتصال‌های بعدی نیازی به ارسال رمز نباشد
let secret = (db.prepare("SELECT v FROM meta WHERE k='secret'").get() || {}).v;
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT INTO meta(k,v) VALUES('secret',?)").run(secret); }
const tokenFor = room => crypto.createHmac('sha256', secret).update(`m:${room.id}:${room.hash}`).digest('hex');
const tokenOk = (t, room) => { const a = Buffer.from(String(t || '')), b = Buffer.from(tokenFor(room)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const ownerOf = req => { const c = String(req.headers['x-client-id'] || ''); return /^[A-Za-z0-9_-]{16,64}$/.test(c) ? crypto.createHash('sha256').update(c).digest('hex') : null; };
const cleanNick = s => String(s || '').trim().slice(0, 24) || 'ناشناس';

// یکسان‌سازی متن برای جستجو: ی/ک عربی، اعراب، نیم‌فاصله، ارقام فارسی/عربی، حروف بزرگ
const norm = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀە]/g, 'ه').replace(/[أإآٱ]/g, 'ا')
  .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660)
  .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

const compact = s => norm(s).replace(/ /g, '');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPw = (pw, salt, hash) => {
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cleanUser = s => String(s || '').trim().slice(0, 24);
const validUser = s => /^[A-Za-z0-9_\u0600-\u06FF\u200c\u200d.-]{3,24}$/.test(String(s || ''));
const authToken = u => crypto.createHmac('sha256', secret).update(`u:${u.id}:${u.hash}`).digest('hex');
const userFromToken = t => {
  const token = String(t || '');
  const rows = db.prepare('SELECT * FROM users').all();
  for (const u of rows) {
    const a = Buffer.from(token), b = Buffer.from(authToken(u));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return u;
  }
  return null;
};
const profileData = u => ({ id: u.id, username: u.username, profile: u.profile || '' });


// محدودیت تلاش (جلوگیری از حدس زدن رمز)
const fails = new Map();
const blocked = (k, max, win) => (fails.get(k) || []).filter(t => Date.now() - t < win).length >= max;
const record = k => fails.set(k, [...(fails.get(k) || []).filter(t => Date.now() - t < 3600e3), Date.now()]);
setInterval(() => fails.clear(), 6 * 3600e3);
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

const live = new Map(); // roomId -> Set<ws>  (الان داخل صفحه‌ی چت آن اتاق‌اند)
const subs = new Map(); // roomId -> Set<ws>  (عضو اتاق‌اند و پیام/اعلان همان اتاق را می‌گیرند)
const addTo = (m, id, ws) => { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(ws); };
const delFrom = (m, id, ws) => { const s = m.get(id); if (s) { s.delete(ws); if (!s.size) m.delete(id); } };
const online = id => (live.get(id) || new Set()).size;
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const broadcast = (map, id, o) => (map.get(id) || []).forEach(c => send(c, o));

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'payamresan', time: Date.now() }));


// حساب کاربری: ثبت‌نام/ورود/به‌روزرسانی پروفایل
app.post('/api/auth/register', (req, res) => {
  const username = cleanUser(req.body.username), pw = String(req.body.password || ''), profile = String(req.body.profile || '');
  if (!validUser(username)) return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۲۴ حرف/عدد باشد.' });
  if (pw.length < 6 || pw.length > 72) return res.status(400).json({ error: 'رمز عبور باید بین ۶ تا ۷۲ کاراکتر باشد.' });
  if (profile && (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(profile) || profile.length > 700000))
    return res.status(400).json({ error: 'عکس پروفایل نامعتبر یا بیش از حد بزرگ است.' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = db.prepare('INSERT INTO users(username,salt,hash,profile,created) VALUES(?,?,?,?,?)')
      .run(username, salt, hashPw(pw, salt), profile, Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({ token: authToken(u), user: profileData(u) });
  } catch { res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' }); }
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanUser(req.body.username), pw = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !checkPw(pw, u.salt, u.hash)) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
  res.json({ token: authToken(u), user: profileData(u) });
});

app.get('/api/auth/me', (req, res) => {
  const u = userFromToken(req.headers.authorization?.replace(/^Bearer\\s+/i, ''));
  if (!u) return res.status(401).json({ error: 'نشست منقضی شده است.' });
  res.json({ user: profileData(u) });
});

app.put('/api/auth/profile', (req, res) => {
  const u = userFromToken(req.headers.authorization?.replace(/^Bearer\\s+/i, ''));
  if (!u) return res.status(401).json({ error: 'نشست منقضی شده است.' });
  const profile = String(req.body.profile || '');
  if (profile && (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(profile) || profile.length > 700000))
    return res.status(400).json({ error: 'عکس پروفایل نامعتبر یا بیش از حد بزرگ است.' });
  db.prepare('UPDATE users SET profile=? WHERE id=?').run(profile, u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  res.json({ token: authToken(fresh), user: profileData(fresh) });
});

// جستجوی اتاق: همه‌ی کلمات باید در نام اتاق باشند
app.get('/api/rooms', (req, res) => {
  const q = norm(req.query.q), toks = q.split(' ').filter(Boolean).slice(0, 5);
  const esc = t => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  // یا کل عبارت (بدون فاصله) در نام باشد، یا همه‌ی کلمه‌ها جدا جدا
  const where = q ? `(compact LIKE ? ESCAPE '\\' OR (${toks.map(() => `norm LIKE ? ESCAPE '\\'`).join(' AND ')}))` : '1';
  const args = q ? [esc(q.replace(/ /g, '')), ...toks.map(esc)] : [];
  const rows = db.prepare(`SELECT id, name FROM rooms WHERE ${where} ORDER BY id DESC LIMIT 60`).all(...args)
    .map(r => ({ ...r, online: online(r.id) }))
    .sort((a, b) => b.online - a.online).slice(0, 40);
  res.json(rows);
});

// اتاق‌هایی که این دستگاه ساخته
app.get('/api/mine', (req, res) => {
  const owner = ownerOf(req);
  const rooms = owner ? db.prepare('SELECT id, name FROM rooms WHERE owner=? ORDER BY id').all(owner) : [];
  res.json({ rooms, max: MAX_OWN });
});

app.post('/api/rooms', (req, res) => {
  const ip = ipOf(req), owner = ownerOf(req), name = String(req.body.name || '').trim().replace(/\s+/g, ' '), pw = String(req.body.password || '');
  if (!owner) return res.status(400).json({ error: 'شناسه‌ی دستگاه نامعتبر است. صفحه را دوباره باز کنید.' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'نام اتاق باید بین ۲ تا ۴۰ حرف باشد.' });
  if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: 'رمز اتاق باید حداقل ۶ حرف باشد.' });
  if (db.prepare('SELECT COUNT(*) c FROM rooms WHERE owner=?').get(owner).c >= MAX_OWN)
    return res.status(403).json({ error: `هر نفر حداکثر ${MAX_OWN.toLocaleString('fa-IR')} اتاق می‌تواند بسازد. برای ساخت اتاق جدید، یکی از اتاق‌های خودتان را حذف کنید.` });
  if (blocked('c' + ip, 5, 3600e3)) return res.status(429).json({ error: 'تعداد اتاق‌های ساخته‌شده زیاد است. بعداً تلاش کنید.' });
  const n = norm(name), salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = db.prepare('INSERT INTO rooms(name,norm,compact,salt,hash,created,owner) VALUES(?,?,?,?,?,?,?)').run(name, n, n.replace(/ /g, ''), salt, hashPw(pw, salt), Date.now(), owner);
    record('c' + ip);
    res.json({ id: r.lastInsertRowid, name });
  } catch { res.status(409).json({ error: 'اتاقی با این نام وجود دارد.' }); }
});

// حذف اتاق (فقط سازنده)
app.delete('/api/rooms/:id', (req, res) => {
  const owner = ownerOf(req), id = +req.params.id;
  const room = owner && db.prepare('SELECT id, owner FROM rooms WHERE id=?').get(id);
  if (!room || room.owner !== owner) return res.status(404).json({ error: 'اتاق پیدا نشد یا مال شما نیست.' });
  db.transaction(() => { db.prepare('DELETE FROM msgs WHERE room=?').run(id); db.prepare('DELETE FROM rooms WHERE id=?').run(id); })();
  broadcast(subs, id, { t: 'gone', room: id });
  (subs.get(id) || []).forEach(c => { c.subs.delete(id); if (c.room === id) c.room = null; });
  subs.delete(id); live.delete(id);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });

// خارج شدن از صفحه‌ی چت (عضویت و دریافت اعلان می‌ماند)
function unpresent(ws) {
  if (!ws.room) return;
  const id = ws.room; delFrom(live, id, ws); ws.room = null;
  broadcast(live, id, { t: 'online', room: id, n: online(id) });
}
const subscribe = (ws, id) => { ws.subs.add(id); addTo(subs, id, ws); };
const unsubscribe = (ws, id) => { if (ws.room === id) unpresent(ws); ws.subs.delete(id); delFrom(subs, id, ws); };

// بررسی عضویت: با توکن (بی‌هزینه) یا رمز اتاق (محدودیت تلاش دارد)
function authorize(ws, it) {
  const id = +it.id, room = db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
  if (!room) return { gone: true };
  if (it.token && tokenOk(it.token, room)) return { room };
  if (it.password) {
    const kIp = 'j' + ws.ip, kRoom = 'r' + id;
    if (blocked(kIp, 10, 60e3) || blocked(kRoom, 30, 600e3)) return { limited: true };
    if (checkPw(String(it.password), room.salt, room.hash)) return { room };
    record(kIp); record(kRoom);
  }
  return { auth: true };
}

wss.on('connection', (ws, req) => {
  ws.ip = ipOf(req); ws.alive = true; ws.room = null; ws.subs = new Set(); ws.nick = 'ناشناس'; ws.user = null; ws.stamps = [];
  ws.on('pong', () => (ws.alive = true));
  ws.on('close', () => { unpresent(ws); [...ws.subs].forEach(id => delFrom(subs, id, ws)); });
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'auth') {
      const u = userFromToken(d.token);
      if (!u) return send(ws, { t: 'autherr', m: 'حساب کاربری معتبر نیست. دوباره وارد شوید.' });
      ws.user = u; ws.nick = cleanNick(u.username);
      return send(ws, { t: 'authed', user: profileData(u) });
    }
    if (d.t === 'sub') {
      if (!ws.user) return send(ws, { t: 'autherr', m: 'ابتدا وارد حساب شوید.' });
      // عضویت پس‌زمینه: فقط اتاق‌هایی که فرد واقعاً عضوشان است (توکن یا رمز درست) پیام و اعلان می‌گیرند
      if (d.nick) ws.nick = cleanNick(d.nick);
      const ok = [], bad = [];
      for (const it of (Array.isArray(d.items) ? d.items : []).slice(0, MAX_SUBS)) {
        const r = authorize(ws, it || {});
        if (r.room) { subscribe(ws, r.room.id); ok.push({ id: r.room.id, name: r.room.name, token: tokenFor(r.room) }); }
        else bad.push({ id: +(it || {}).id, why: r.gone ? 'gone' : r.auth ? 'auth' : 'limit' });
      }
      send(ws, { t: 'subbed', ok, bad });
    } else if (d.t === 'join') {
      if (!ws.user) return send(ws, { t: 'autherr', m: 'ابتدا وارد حساب شوید.' });
      const r = authorize(ws, d);
      if (r.limited) return send(ws, { t: 'err', m: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
      if (r.gone) return send(ws, { t: 'err', m: 'این اتاق دیگر وجود ندارد.' });
      if (r.auth) return send(ws, { t: 'err', m: 'رمز اتاق اشتباه است.' });
      const id = r.room.id;
      unpresent(ws); subscribe(ws, id);
      ws.room = id; ws.nick = cleanNick(ws.user.username); addTo(live, id, ws);
      const history = db.prepare('SELECT nick,text,ts,user_id,user_profile FROM msgs WHERE room=? ORDER BY id DESC LIMIT 100').all(id).reverse();
      send(ws, { t: 'joined', id, name: r.room.name, token: tokenFor(r.room), history });
      broadcast(live, id, { t: 'online', room: id, n: online(id) });
    } else if (d.t === 'leave') {
      unpresent(ws);
    } else if (d.t === 'unsub') {
      unsubscribe(ws, +d.id);
    } else if (d.t === 'msg' && ws.room) {
      const text = String(d.text || '').trim().slice(0, 1000);
      const now = Date.now(); ws.stamps = ws.stamps.filter(t => now - t < 3000);
      if (!text || ws.stamps.length >= 5) return;
      ws.stamps.push(now);
      db.prepare('INSERT INTO msgs(room,nick,text,ts,user_id,user_profile) VALUES(?,?,?,?,?,?)').run(ws.room, ws.nick, text, now, ws.user?.id || null, ws.user?.profile || '');
      broadcast(subs, ws.room, { t: 'msg', room: ws.room, nick: ws.nick, text, ts: now, user_id: ws.user?.id || null, profile: ws.user?.profile || '' });
    }
  });
});

// قطع اتصال‌های مرده + پاکسازی پیام‌های قدیمی
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30e3);
const prune = () => db.prepare('DELETE FROM msgs WHERE ts < ?').run(Date.now() - KEEP_DAYS * 864e5);
prune(); setInterval(prune, 6 * 3600e3);

server.listen(PORT, () => console.log('listening on', PORT));
