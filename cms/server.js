// ============================================================
//  Update Diário — CMS Server
//  Node.js + Express + SQLite (better-sqlite3)
// ============================================================

require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const multer     = require('multer');
const session    = require('express-session');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  DATABASE
// ============================================================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'cms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    color      TEXT DEFAULT '#E43265',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    excerpt      TEXT,
    content      TEXT,
    cover_image  TEXT,
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    author       TEXT DEFAULT 'Redação',
    status       TEXT DEFAULT 'draft' CHECK(status IN ('draft','published')),
    featured     INTEGER DEFAULT 0,
    read_time    INTEGER DEFAULT 3,
    published_at DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS newsletter (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT,
    active        INTEGER DEFAULT 1,
    subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed categorias padrão
if (db.prepare('SELECT COUNT(*) as c FROM categories').get().c === 0) {
  const ins = db.prepare('INSERT INTO categories (name, slug, color) VALUES (?,?,?)');
  [
    ['Tecnologia', 'tecnologia',  '#E43265'],
    ['Negócios',   'negocios',    '#0A0A0A'],
    ['Startups',   'startups',    '#E43265'],
    ['Mercados',   'mercados',    '#0A0A0A'],
    ['Opinião',    'opiniao',     '#E43265'],
  ].forEach(r => ins.run(...r));
}

// ============================================================
//  HELPERS
// ============================================================
function toSlug(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function uniqueSlug(base) {
  let slug = base, i = 1;
  while (db.prepare('SELECT id FROM articles WHERE slug=?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

// ============================================================
//  MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'updatediario-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Arquivos estáticos
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// Auth guard
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'updatediario123';

function auth(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

// ============================================================
//  FILE UPLOAD
// ============================================================
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Apenas imagens JPEG, PNG, WebP ou GIF'));
  }
});

// ============================================================
//  ROTAS — AUTH
// ============================================================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Usuário ou senha incorretos' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ admin: !!req.session?.admin });
});

// ============================================================
//  ROTAS — STATS (admin)
// ============================================================
app.get('/api/stats', auth, (req, res) => {
  res.json({
    total:      db.prepare('SELECT COUNT(*) as c FROM articles').get().c,
    published:  db.prepare('SELECT COUNT(*) as c FROM articles WHERE status="published"').get().c,
    drafts:     db.prepare('SELECT COUNT(*) as c FROM articles WHERE status="draft"').get().c,
    categories: db.prepare('SELECT COUNT(*) as c FROM categories').get().c,
    newsletter: db.prepare('SELECT COUNT(*) as c FROM newsletter WHERE active=1').get().c,
    recent:     db.prepare(`
      SELECT a.id, a.title, a.status, a.created_at, c.name as category_name
      FROM articles a LEFT JOIN categories c ON c.id = a.category_id
      ORDER BY a.created_at DESC LIMIT 6
    `).all(),
  });
});

// ============================================================
//  ROTAS — CATEGORIAS (admin)
// ============================================================
app.get('/api/categories', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, COUNT(a.id) as article_count
    FROM categories c
    LEFT JOIN articles a ON a.category_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all());
});

app.post('/api/categories', auth, (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = db.prepare('INSERT INTO categories (name,slug,color) VALUES (?,?,?)')
      .run(name.trim(), toSlug(name), color || '#E43265');
    res.json({ id: r.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Já existe uma categoria com esse nome' });
  }
});

app.put('/api/categories/:id', auth, (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  db.prepare('UPDATE categories SET name=?,slug=?,color=? WHERE id=?')
    .run(name.trim(), toSlug(name), color || '#E43265', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', auth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
//  ROTAS — ARTIGOS (admin)
// ============================================================
app.get('/api/articles', auth, (req, res) => {
  const { status, category_id, search, page = 1, limit = 20 } = req.query;
  const conds = [], params = [];

  if (status)      { conds.push('a.status=?');       params.push(status); }
  if (category_id) { conds.push('a.category_id=?');  params.push(category_id); }
  if (search)      { conds.push('(a.title LIKE ? OR a.excerpt LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const where  = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const offset = (Number(page) - 1) * Number(limit);

  const articles = db.prepare(`
    SELECT a.id, a.title, a.slug, a.status, a.featured, a.author,
           a.read_time, a.cover_image, a.created_at, a.published_at,
           c.name as category_name, c.color as category_color
    FROM articles a LEFT JOIN categories c ON c.id=a.category_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all([...params, Number(limit), offset]);

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM articles a ${where}`
  ).get(params).c;

  res.json({ articles, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
});

app.get('/api/articles/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT a.*, c.name as category_name
    FROM articles a LEFT JOIN categories c ON c.id=a.category_id
    WHERE a.id=?
  `).get(req.params.id);
  row ? res.json(row) : res.status(404).json({ error: 'Não encontrado' });
});

app.post('/api/articles', auth, (req, res) => {
  const { title, excerpt, content, cover_image, category_id,
          author, status, featured, read_time } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório' });

  const slug         = uniqueSlug(toSlug(title));
  const published_at = status === 'published' ? new Date().toISOString() : null;

  const r = db.prepare(`
    INSERT INTO articles
      (title,slug,excerpt,content,cover_image,category_id,author,status,featured,read_time,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    title.trim(), slug, excerpt || null, content || null,
    cover_image || null, category_id || null,
    author || 'Redação', status || 'draft',
    featured ? 1 : 0, read_time || 3, published_at
  );
  res.json({ id: r.lastInsertRowid, slug });
});

app.put('/api/articles/:id', auth, (req, res) => {
  const { title, excerpt, content, cover_image, category_id,
          author, status, featured, read_time } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório' });

  const cur = db.prepare('SELECT status, published_at FROM articles WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Não encontrado' });

  const published_at = status === 'published' && cur.status !== 'published'
    ? new Date().toISOString()
    : cur.published_at;

  db.prepare(`
    UPDATE articles SET
      title=?,excerpt=?,content=?,cover_image=?,category_id=?,
      author=?,status=?,featured=?,read_time=?,published_at=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    title.trim(), excerpt || null, content || null, cover_image || null,
    category_id || null, author || 'Redação', status || 'draft',
    featured ? 1 : 0, read_time || 3, published_at, req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/articles/:id', auth, (req, res) => {
  db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
//  ROTAS — UPLOADS (admin)
// ============================================================
app.post('/api/uploads', auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

app.get('/api/uploads', auth, (req, res) => {
  const exts = /\.(jpg|jpeg|png|webp|gif)$/i;
  const files = fs.readdirSync(uploadsDir)
    .filter(f => exts.test(f))
    .map(f => ({
      filename: f,
      url:      `/uploads/${f}`,
      size:     fs.statSync(path.join(uploadsDir, f)).size,
      mtime:    fs.statSync(path.join(uploadsDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.delete('/api/uploads/:filename', auth, (req, res) => {
  const file = path.join(uploadsDir, path.basename(req.params.filename));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ============================================================
//  ROTAS — NEWSLETTER (admin)
// ============================================================
app.get('/api/newsletter', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM newsletter ORDER BY subscribed_at DESC').all());
});

app.delete('/api/newsletter/:id', auth, (req, res) => {
  db.prepare('DELETE FROM newsletter WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Export CSV
app.get('/api/newsletter/export', auth, (req, res) => {
  const rows = db.prepare('SELECT email,name,subscribed_at FROM newsletter WHERE active=1 ORDER BY subscribed_at DESC').all();
  const csv  = ['email,nome,data'].concat(rows.map(r => `${r.email},"${r.name || ''}","${r.subscribed_at}"`)).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=newsletter.csv');
  res.send('﻿' + csv); // BOM para Excel
});

// ============================================================
//  API PÚBLICA — consumida pelo frontend (updatediario_template.html)
// ============================================================
app.get('/api/public/articles', (req, res) => {
  const { category, featured, page = 1, limit = 12 } = req.query;
  const conds  = ['a.status="published"'], params = [];

  if (category) { conds.push('c.slug=?');    params.push(category); }
  if (featured) { conds.push('a.featured=1'); }

  const where  = 'WHERE ' + conds.join(' AND ');
  const offset = (Number(page) - 1) * Number(limit);

  const articles = db.prepare(`
    SELECT a.id,a.title,a.slug,a.excerpt,a.cover_image,a.author,
           a.read_time,a.published_at,a.featured,
           c.name as category_name,c.slug as category_slug,c.color as category_color
    FROM articles a LEFT JOIN categories c ON c.id=a.category_id
    ${where}
    ORDER BY a.published_at DESC LIMIT ? OFFSET ?
  `).all([...params, Number(limit), offset]);

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM articles a LEFT JOIN categories c ON c.id=a.category_id ${where}`
  ).get(params).c;

  res.json({ articles, total });
});

app.get('/api/public/articles/:slug', (req, res) => {
  const row = db.prepare(`
    SELECT a.*,c.name as category_name,c.slug as category_slug,c.color as category_color
    FROM articles a LEFT JOIN categories c ON c.id=a.category_id
    WHERE a.slug=? AND a.status='published'
  `).get(req.params.slug);
  row ? res.json(row) : res.status(404).json({ error: 'Não encontrado' });
});

app.get('/api/public/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});

app.post('/api/public/newsletter', (req, res) => {
  const { email, name } = req.body;
  if (!email?.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  try {
    db.prepare('INSERT INTO newsletter (email,name) VALUES (?,?)').run(email.trim().toLowerCase(), name?.trim() || null);
    res.json({ ok: true, message: 'Inscrição realizada com sucesso!' });
  } catch {
    res.status(400).json({ error: 'Este email já está cadastrado' });
  }
});

// ============================================================
//  ADMIN PANEL
// ============================================================
app.get(['/admin', '/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin/index.html'));
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, () => {
  console.log('\n══════════════════════════════════════════');
  console.log('  ✅  Update Diário CMS');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  📋  Painel: http://localhost:${PORT}/admin`);
  console.log(`  🔑  Login: ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log('══════════════════════════════════════════\n');
});
