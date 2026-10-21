import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { optionalAuth, originGuard } from './auth.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { startTelegramPolling } from './notify.js';

const app = express();
app.set('trust proxy', 1); // за nginx: берём реальный IP из X-Forwarded-For
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'frame-src': ['https://www.google.com'],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(originGuard);
app.use(optionalAuth);

app.get('/api/health', async (_req, res) => { await pool.query('select 1'); res.json({ ok: true }); });
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', publicRouter);
app.use('/api', (_req, res) => void res.status(404).json({ error: 'Не найдено.' }));

/* загруженные изображения */
app.use('/uploads', express.static(resolve(config.uploadDir), { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff') }));

/* если фронтенд собран (../dist) — отдаём его же, с SPA-фолбэком. На VDS это обычно делает nginx. */
const dist = resolve(process.cwd(), '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => (/\.[a-z0-9]+$/i.test(req.path) ? res.status(404).end() : res.sendFile(resolve(dist, 'index.html'))));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Слишком большой запрос.' });
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Неверный формат запроса.' });
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

await migrate();

/* начальная инициализация данных, если БД пуста */
try {
  const has = (await pool.query('select count(*)::int as n from directions')).rows[0]?.n > 0;
  if (!has) {
    const seedPath = resolve(process.cwd(), 'seed', 'seed.json');
    if (existsSync(seedPath)) {
      console.log('Инициализация начальных данных (seed)...');
      const { readFileSync } = await import('node:fs');
      const seedData = JSON.parse(readFileSync(seedPath, 'utf8'));
      const { importContent } = await import('./seed.js');
      await importContent(seedData, { withInquiries: false });
      console.log('Начальные данные успешно загружены.');
    }
  }
} catch (e) {
  console.error('Ошибка автоматического seed:', e);
}

/* создание суперадмина при наличии переменной ADMIN_PASSWORD */
if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 10) {
  try {
    const login = process.env.ADMIN_LOGIN || 'admin';
    const password = process.env.ADMIN_PASSWORD;
    const { hashPassword, uid } = await import('./crypto.js');
    const ex = await pool.query('select id from users where lower(login) = lower($1)', [login]);
    if (ex.rowCount === 0) {
      await pool.query("insert into users(id, login, name, role, password_hash) values ($1,$2,'Суперадминистратор','superadmin',$3)", [uid('u'), login, await hashPassword(password)]);
      console.log(`Суперадминистратор «${login}» создан.`);
    }
  } catch (e) {
    console.error('Ошибка создания суперадмина:', e);
  }
}

app.listen(config.port, () => console.log(`PIRANT server: порт ${config.port}`));
void startTelegramPolling();

