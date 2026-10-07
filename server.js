'use strict';
/*
 * Panel de cuentas Emby (v2: usuarios por niveles y creditos)
 * Servidor sin dependencias (Node.js 18 o superior).
 * - Datos en data/db.json
 * - La API key de Emby nunca se envia al navegador
 * - Revisa caducidades y demos al arrancar y cada minuto
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (typeof fetch !== 'function') {
  console.error('Necesitas Node.js 18 o superior. Descarga la version LTS en https://nodejs.org');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'copias');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CHECK_EVERY_MS = 60 * 1000;

/* Alertas: los dos modulos vienen apagados; los enciende un administrador */
const DEFAULT_ALERTS = {
  transcode: { on: false, stop: true, onlyVideo: true, retention: 30, message: 'Tu dispositivo está convirtiendo el vídeo (transcodificando). Elige calidad original o usa la app oficial de Emby.' },
  sessions: { on: false, stop: false, retention: 30, grace: 5, policy: 'newest', message: 'Has superado el número de pantallas de tu cuenta. Se ha detenido esta reproducción.' },
};
/* Avisos de vencimiento al cliente. Vienen apagados; los enciende el superadministrador */
const DEFAULT_NOTICES = {
  screen: { on: false, days: 5, message: 'Tu cuenta caduca {cuando}. Habla con tu vendedor para renovarla y no quedarte sin servicio.' },
  chat: { days: 2 }, // dias de antelacion para Telegram y para la lista de avisos por WhatsApp
  telegram: { on: false, token: '', bot: '', offset: 0 },
};
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const MONTHS = [1, 3, 6, 12];
const SCREENS = [1, 2, 4];
const QUALITIES = { basico: 'Básico', k4: '4K' };
const ROLE_NAME = { super: 'Superadministrador', admin: 'Administrador', reseller: 'Reseller', sub: 'Subreseller' };

/* ---------- Fechas (texto AAAA-MM-DD, sin husos horarios) ---------- */
const pad = (n) => String(n).padStart(2, '0');
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return localDate(new Date()); }
function parts(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
function utc(s) { const { y, m, d } = parts(s); return Date.UTC(y, m - 1, d); }
function fromUtc(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function diffDays(a, b) { return Math.round((utc(a) - utc(b)) / 86400000); }
function addDays(s, n) { return fromUtc(utc(s) + n * 86400000); }
/** Suma meses sin saltarse el mes: 31 ene + 1 mes = 28/29 feb */
function addMonths(s, n) {
  const { y, m, d } = parts(s);
  const t = (m - 1) + n;
  const ny = y + Math.floor(t / 12);
  const nm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(utc(s)) === s; }

/* ---------- Base de datos ---------- */
const DEFAULT_PRICES = {
  1: { 1: 1, 2: 1, 4: 2 },
  3: { 1: 3, 2: 3, 4: 4 },
  6: { 1: 6, 2: 6, 4: 12 },
  12: { 1: 12, 2: 12, 4: 24 },
};
/* Mensajes para enviar al cliente final. Variables: {nombre} {usuario} {contraseña} {servidor} {direccion} {pantallas} {contenido} {vence} */
const DEFAULT_TEMPLATES = {
  created: 'Hola {nombre} 👋\n\nTu cuenta Emby ya está activa:\n\nUsuario: {usuario}\nContraseña: {contraseña}\nServidor: {servidor}\nDirección: {direccion}\nPantallas: {pantallas}\nContenido: {contenido}\nVence: {vence}\n\n¡Disfruta del contenido!',
  demo: 'Hola {nombre} 👋\n\nTu demo de Emby está lista:\n\nUsuario: {usuario}\nContraseña: {contraseña}\nServidor: {servidor}\nDirección: {direccion}\nTermina: {vence}\n\nSi te gusta, avísame antes de que termine y te la dejo como cuenta fija.',
  renewed: 'Hola {nombre} 👋\n\nTu cuenta Emby ({usuario}) está renovada.\nNuevo vencimiento: {vence}\n\n¡Gracias!',
  expiring: 'Hola {nombre} 👋\n\nTu cuenta Emby ({usuario}) vence el {vence}.\nAvísame si quieres renovarla para no quedarte sin servicio.',
  vendor: 'Hola {nombre} 👋\n\nYa tienes acceso al panel {panel}:\n\nDirección: {direccion}\nUsuario: {usuario}\nContraseña: {contraseña}\nTipo de cuenta: {tipo}\nCréditos: {creditos}\n\nCambia la contraseña al entrar, en Panel, Mi contraseña.',
};
const DEFAULT_SETTINGS = { graceDays: 5, purgeDays: 30, demoPurgeDays: 1, warnDays: 7, demoMax: 3, demoHours: [2, 4, 12], monitorSec: 30, liveSec: 15, currency: 'EUR', creditPrice: 0,
  support: { text: '', whatsapp: '', telegram: '', email: '' }, retention: { logDays: 0, ledgerDays: 0, backups: 14 }, prices: DEFAULT_PRICES, templates: DEFAULT_TEMPLATES, brand: { name: 'Concha', color: '', logo: '' },
  creditPacks: [{ name: 'Pack 10', credits: 10 }, { name: 'Pack 25', credits: 25 }, { name: 'Pack 50', credits: 50 }, { name: 'Pack 100', credits: 100 }] };
let db;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const base = { settings: {}, users: [], servers: [], clients: [], log: [], ledger: [], nextId: 1, lastRun: null };
  if (fs.existsSync(DB_FILE)) {
    db = { ...base, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    backupDb();
  } else db = base;
  db.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...db.settings };
  const al = db.settings.alerts || {};
  db.settings.templates = { ...DEFAULT_TEMPLATES, ...(db.settings.templates || {}) };
  db.settings.brand = { name: 'Concha', color: '', logo: '', url: '', tiles: 'solid', ...(db.settings.brand || {}) };
  db.settings.support = { ...DEFAULT_SETTINGS.support, ...(db.settings.support || {}) };
  db.settings.retention = { ...DEFAULT_SETTINGS.retention, ...(db.settings.retention || {}) };
  const nt = db.settings.notices || {};
  db.settings.notices = { screen: { ...DEFAULT_NOTICES.screen, ...(nt.screen || {}) }, chat: { ...DEFAULT_NOTICES.chat, ...(nt.chat || {}) }, telegram: { ...DEFAULT_NOTICES.telegram, ...(nt.telegram || {}) } };
  if (!db.secret) db.secret = crypto.randomBytes(24).toString('hex');
  db.settings.alerts = { transcode: { ...DEFAULT_ALERTS.transcode, ...(al.transcode || {}) }, sessions: { ...DEFAULT_ALERTS.sessions, ...(al.sessions || {}) } };
  if (!Array.isArray(db.alerts)) db.alerts = [];
  // Migracion desde la version anterior (una sola contrasena de panel)
  if (db.auth && !db.users.length) {
    db.users.push({ id: db.nextId++, username: 'admin', name: 'Superadministrador', role: 'super', parentId: null, credits: 0, salt: db.auth.salt, hash: db.auth.hash, disabled: false, createdAt: today() });
  }
  delete db.auth;
  const boss = db.users.find((u) => u.role === 'super');
  for (const c of db.clients) {
    if (c.ownerId == null && boss) c.ownerId = boss.id;
    if (c.screens == null) c.screens = 0;
    if (c.quality === undefined) c.quality = null;
  }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function backupDb() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, `db-${today()}.json`);
    if (!fs.existsSync(target) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, target);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const keep = (db && db.settings && db.settings.retention && db.settings.retention.backups) || 14;
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { console.error('No se pudo hacer la copia de seguridad:', e.message); }
}
/** Borra del registro lo que supera los dias de retencion elegidos en Ajustes (0 = no borrar por antiguedad) */
function pruneRecords() {
  const r = db.settings.retention, now = Date.now();
  const cut = (list, days) => (days > 0 ? list.filter((l) => now - Date.parse(l.ts) < days * 86400000) : list);
  const a = db.log.length, b = db.ledger.length;
  db.log = cut(db.log, r.logDays); db.ledger = cut(db.ledger, r.ledgerDays);
  if (a !== db.log.length || b !== db.ledger.length) saveDb();
}
function newId() { return db.nextId++; }
function addLog(type, client, text, actor) {
  const ts = new Date().toISOString();
  if (client) client.lastAction = ts; // para ordenar la lista por ultima accion
  db.log.unshift({
    ts, type,
    client: client ? client.panelName : '', emby: client ? client.embyName : '',
    clientId: client ? client.id : null, ownerId: client ? client.ownerId : null, demo: !!(client && client.demo),
    actorId: actor ? actor.id : null, actor: actor ? actor.name : '',
    text, auto: !actor,
  });
  if (db.log.length > 5000) db.log.length = 5000;
}
/** kind: credito (recarga), asignacion (traspaso a un subreseller), alta, renovacion, ajuste */
function addLedger(user, delta, text, by, kind) {
  const k = kind || (/^Renovación/.test(text) ? 'renovacion' : /^Alta/.test(text) ? 'alta' : 'ajuste');
  db.ledger.unshift({ ts: new Date().toISOString(), userId: user.id, user: user.name, delta, balance: user.credits, text, kind: k, byId: by ? by.id : null, by: by ? by.name : '' });
  if (db.ledger.length > 10000) db.ledger.length = 10000;
}

/* ---------- Emby ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function emby(server, method, p, body) {
  let res;
  try {
    res = await fetch(server.url + '/emby' + p, {
      method,
      headers: { 'X-Emby-Token': server.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'no responde' : ((e.cause && e.cause.code) || 'sin conexión');
    const err = new Error(`No se pudo conectar con "${server.name}" (${why}). Revisa que Emby esté encendido y la dirección sea correcta.`);
    err.embyStatus = 0;
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg;
    if (res.status === 401 || res.status === 403) msg = `"${server.name}" ha rechazado la API key.`;
    else if (res.status === 404) msg = `Emby no encuentra ese usuario o recurso en "${server.name}".`;
    else msg = `Emby respondió con error ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
    const err = new Error(msg);
    err.embyStatus = res.status;
    throw err;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
function serverById(id) {
  const s = db.servers.find((x) => x.id === Number(id));
  if (!s) throw new HttpError(404, 'Ese servidor ya no existe.');
  return s;
}
function serverOf(client) {
  const s = db.servers.find((x) => x.id === client.serverId);
  if (!s) throw new Error('El servidor de esta cuenta ya no está configurado.');
  return s;
}
async function embyLibraries(server) {
  let list;
  try { list = await emby(server, 'GET', '/Library/VirtualFolders'); }
  catch (e) { if (e.embyStatus !== 404) throw e; list = await emby(server, 'GET', '/Library/SelectableMediaFolders'); }
  return (list || []).map((f) => ({ id: String(f.Guid || f.ItemId || f.Id || ''), name: f.Name })).filter((f) => f.id);
}
function packageReady(server, quality) {
  const p = server.packages && server.packages[quality];
  return !!p && (p.all || (p.folders || []).length > 0);
}
/** Bibliotecas que le tocan a una cuenta: las de su paquete, o las propias si es personalizada */
function accessOf(client) {
  if (!client.quality) return client.access || { all: false, folders: [] };
  const s = serverOf(client);
  if (!packageReady(s, client.quality)) throw new HttpError(400, `Falta elegir qué bibliotecas incluye el contenido ${QUALITIES[client.quality]} en "${s.name}" (Servidores, Contenido).`);
  return s.packages[client.quality];
}
/** Las cuentas del panel son siempre usuarios normales de Emby: nunca administradores ni con permisos de gestion */
function lockDown(pol) {
  pol.IsAdministrator = false;
  pol.EnableContentDeletion = false;
  pol.EnableContentDeletionFromFolders = [];
  pol.EnableRemoteControlOfOtherUsers = false;
  pol.EnableLiveTvManagement = false;
  pol.EnableVideoPlaybackTranscoding = false; // ningun cliente puede transcodificar video: es lo que mas carga el servidor
  return pol;
}
const polHasLibs = (pol) => !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0;
const sameLibs = (a, b) => { const n = (x) => [...new Set((x || []).map((v) => String(v).toLowerCase().replace(/-/g, '')))].sort().join(','); return n(a) === n(b); };
async function readPolicy(s, embyId) { return (await emby(s, 'GET', `/Users/${embyId}`)).Policy || {}; }
/** Da acceso: activa la cuenta, le pone SIEMPRE las bibliotecas de su paquete y su limite de pantallas, y comprueba que Emby lo ha aplicado */
async function grantAccess(client) {
  const s = serverOf(client);
  const acc = accessOf(client);
  const pol = lockDown(await readPolicy(s, client.embyId));
  pol.IsDisabled = false;
  pol.EnableAllFolders = !!acc.all;
  pol.EnabledFolders = acc.all ? [] : acc.folders;
  if (client.screens > 0) pol.SimultaneousStreamLimit = client.screens;
  await emby(s, 'POST', `/Users/${client.embyId}/Policy`, pol);
  const now = await readPolicy(s, client.embyId);
  if (now.IsAdministrator) throw new Error('Emby sigue marcando la cuenta como administrador. Revísala en Emby.');
  if (now.EnableVideoPlaybackTranscoding === true) throw new Error('Emby no ha desactivado la transcodificación de vídeo de la cuenta. Revísala en Emby.');
  if ((acc.all || acc.folders.length) && !polHasLibs(now)) throw new Error('Emby no ha asignado las bibliotecas a la cuenta. Revisa en Servidores, Contenido, que las bibliotecas del paquete siguen existiendo.');
  // El paquete son bibliotecas concretas: Emby no puede dejarla con acceso a todas, ni sin ninguna de las elegidas
  if (!acc.all && now.EnableAllFolders) throw new Error('Emby ha dejado la cuenta con acceso a TODAS las bibliotecas en vez de solo las de su paquete. Entra en Servidores, Contenido, vuelve a marcar las bibliotecas y guarda; después pulsa Reparar en la cuenta.');
  const norm = (v) => String(v).toLowerCase().replace(/-/g, '');
  const got = new Set((now.EnabledFolders || []).map(norm));
  if (!acc.all && !acc.folders.some((f) => got.has(norm(f)))) throw new Error('Emby no ha guardado ninguna de las bibliotecas del paquete. Entra en Servidores, Contenido, vuelve a marcarlas y guarda.');
}
/** Quita SIEMPRE todas las bibliotecas (y opcionalmente desactiva) y comprueba que Emby lo ha aplicado */
async function removeAccess(client, disable) {
  const s = serverOf(client);
  let pol;
  try { pol = lockDown(await readPolicy(s, client.embyId)); }
  catch (e) { if (e.embyStatus === 404) return false; throw e; }
  if (polHasLibs(pol) && !client.quality) client.access = { all: !!pol.EnableAllFolders, folders: pol.EnabledFolders || [] };
  pol.EnableAllFolders = false;
  pol.EnabledFolders = [];
  if (disable) pol.IsDisabled = true;
  await emby(s, 'POST', `/Users/${client.embyId}/Policy`, pol);
  if (polHasLibs(await readPolicy(s, client.embyId))) throw new Error('Emby no ha retirado las bibliotecas de la cuenta. Se volverá a intentar en la próxima revisión.');
  return true;
}
async function deleteEmbyUser(client) {
  try { await emby(serverOf(client), 'DELETE', `/Users/${client.embyId}`); }
  catch (e) { if (e.embyStatus !== 404) throw e; }
}
async function setEmbyPassword(server, embyId, password, isNew) {
  if (!isNew) await emby(server, 'POST', `/Users/${embyId}/Password`, { Id: embyId, ResetPassword: true });
  await emby(server, 'POST', `/Users/${embyId}/Password`, { Id: embyId, CurrentPw: '', NewPw: password });
}

/* ---------- Cola: los cambios van de uno en uno ---------- */
let chain = Promise.resolve();
function lock(fn) { const p = chain.then(() => fn()); chain = p.catch(() => {}); return p; }

/* ---------- Ciclo de vida automatico ----------
 * activa   -> caducada : el dia siguiente al vencimiento. Se le quitan las bibliotecas.
 * caducada -> papelera : pasados los dias de gracia. Se desactiva la cuenta en Emby.
 * demo     -> papelera : al cumplirse sus horas. Se desactiva la cuenta en Emby.
 * papelera -> borrada  : pasados los dias de papelera (las demos, al dia siguiente).
 */
async function lifecycle() {
  const t = today();
  const now = Date.now();
  const { graceDays, purgeDays, demoPurgeDays } = db.settings;
  for (const c of [...db.clients]) {
    try {
      if (c.demo && c.status === 'active' && now >= Date.parse(c.expiresAt)) {
        await removeAccess(c, true);
        c.status = 'trash'; c.trashedAt = t; c.trashReason = 'Demo terminada';
        addLog('papelera', c, 'Demo terminada: cuenta desactivada');
      }
      if (!c.demo && c.status === 'active' && diffDays(t, c.expires) > 0) {
        const existed = await removeAccess(c, false);
        c.status = 'expired';
        addLog('caducada', c, existed ? 'Caducada: bibliotecas retiradas' : 'Caducada (el usuario ya no existía en Emby)');
      }
      if (c.status === 'expired' && diffDays(t, c.expires) > graceDays) {
        await removeAccess(c, true);
        c.status = 'trash'; c.trashedAt = t; c.trashReason = 'Sin renovar';
        addLog('papelera', c, `A la papelera tras ${graceDays} días sin renovar: cuenta desactivada`);
      }
      if (c.status === 'trash') {
        const days = diffDays(t, c.trashedAt || t);
        if (c.demo ? days >= demoPurgeDays : (purgeDays > 0 && days >= purgeDays)) {
          await deleteEmbyUser(c);
          db.clients = db.clients.filter((x) => x.id !== c.id);
          addLog('eliminada', c, c.demo ? 'Demo eliminada de Emby' : `Eliminada definitivamente tras ${purgeDays} días en la papelera`);
          continue;
        }
      }
      delete c.lastError;
    } catch (e) {
      if (c.lastError !== e.message) addLog('error', c, 'La revisión automática falló: ' + e.message);
      c.lastError = e.message;
    }
  }
  db.lastRun = new Date().toISOString();
  saveDb();
}
function runLifecycle() { return lock(lifecycle).then(() => lock(telegramNotices)).catch((e) => console.error('Error en la revisión automática:', e.message)); }

/* ---------- Usuarios del panel y permisos ---------- */
const sessions = new Map(); // token -> { userId, exp }
const loginFails = new Map(); // usuario -> { count, until }
const isStaff = (u) => u.role === 'super' || u.role === 'admin';
/* Permisos de cada administrador. El superadministrador los tiene todos.
   Los que no se han tocado nunca conservan lo que un administrador podia hacer antes de existir los permisos. */
const PERMS = ['credits', 'admins', 'clients', 'viewServers', 'servers', 'resellers', 'packages', 'reports', 'system'];
const DEFAULT_PERMS = { credits: true, admins: false, clients: true, viewServers: false, servers: false, resellers: true, packages: false, reports: true, system: false };
function permsOf(u) {
  const out = {};
  for (const k of PERMS) out[k] = u.role === 'super' ? true : u.role === 'admin' ? !!(u.perms ? u.perms[k] : DEFAULT_PERMS[k]) : false;
  if (out.servers || out.packages) out.viewServers = true;
  return out;
}
const can = (u, perm) => permsOf(u)[perm];
/** Solo afecta a los administradores: el resto de niveles sigue con sus reglas de siempre */
function needPerm(me, perm) {
  if (me.role === 'admin' && !can(me, perm)) throw new HttpError(403, 'Tu usuario de administrador no tiene este permiso. Pídeselo al superadministrador.');
}
/** Permiso que necesita un administrador para cada ruta. La primera regla que coincide manda. */
const PERM_RULES = [
  ['*', /^\/api\/(clients|demos|bulk|import)(\/|$)/, 'clients'],
  ['GET', /^\/api\/(sessions|lastseen|alerts)$/, 'clients'],
  ['POST', /^\/api\/(run|alerts\/read|alerts\/clear)$/, 'clients'],
  ['PUT', /^\/api\/alerts\/config$/, 'system'],
  ['POST', /^\/api\/users\/\d+\/credits$/, 'credits'],
  ['GET', /^\/api\/(audit|logs)$/, 'reports'],
  ['GET', /^\/api\/servers\/\d+\/test$/, 'viewServers'],
  ['PUT', /^\/api\/servers\/\d+\/packages$/, 'packages'],
  ['POST', /^\/api\/servers$/, 'servers'],
  ['PUT', /^\/api\/servers\/\d+$/, 'servers'],
  ['DELETE', /^\/api\/servers\/\d+$/, 'servers'],
  ['PUT', /^\/api\/(settings|brand|tiles|templates|notices|credit-packs)$/, 'system'],
];
function permFor(method, pathname) {
  const r = PERM_RULES.find(([m, re]) => (m === '*' || m === method) && re.test(pathname));
  return r ? r[2] : null;
}
/** Quien paga creditos al crear o renovar: vendedores, y administradores con el sistema de creditos activado */
const paysCredits = (u) => !isStaff(u) || (u.role === 'admin' && !!u.useCredits);
/** Quien puede tener saldo */
const holdsCredits = (u) => u.role === 'reseller' || u.role === 'sub' || (u.role === 'admin' && !!u.useCredits);
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 32).toString('hex'); }
function setPassword(user, password) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
}
function checkPassword(user, password) {
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Detras de un proxy con HTTPS (Coolify, Caddy, Nginx) la peticion llega marcada como https */
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function startSession(res, user, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 7 * 24 * 3600;
  sessions.set(token, { userId: user.id, exp: Date.now() + maxAge * 1000 });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`); // Secure cuando se entra por HTTPS
}
function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function currentUser(req) {
  const tok = sessionToken(req);
  const s = tok && sessions.get(tok);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(tok); return null; }
  const u = db.users.find((x) => x.id === s.userId);
  if (!u || u.disabled) { sessions.delete(tok); return null; }
  return u;
}
function dropSessions(userId) { for (const [k, v] of sessions) if (v.userId === userId) sessions.delete(k); }
/** Duenos cuyas cuentas puede ver: null = todas */
function visibleOwners(me) {
  if (isStaff(me)) return null;
  const ids = new Set([me.id]);
  if (me.role === 'reseller') db.users.filter((u) => u.parentId === me.id).forEach((u) => ids.add(u.id));
  return ids;
}
function canManageUser(me, u) {
  if (u.id === me.id) return false;
  if (me.role === 'super') return true;
  if (me.role === 'admin') {
    if (u.role === 'reseller' || u.role === 'sub') return true;
    // A otro administrador solo si tiene el permiso y el otro no puede mas que el
    if (u.role !== 'admin' || !can(me, 'admins')) return false;
    const mine = permsOf(me), theirs = permsOf(u);
    return PERMS.every((k) => !theirs[k] || mine[k]);
  }
  if (me.role === 'reseller') return u.role === 'sub' && u.parentId === me.id;
  return false;
}
function userById(id) {
  const u = db.users.find((x) => x.id === Number(id));
  if (!u) throw new HttpError(404, 'Ese usuario ya no existe.');
  return u;
}
function clientFor(me, id) {
  const c = db.clients.find((x) => x.id === Number(id));
  const vis = visibleOwners(me);
  if (!c || (vis && !vis.has(c.ownerId))) throw new HttpError(404, 'Esa cuenta ya no existe en el panel.');
  return c;
}

/* ---------- Creditos ---------- */
function price(months, screens) {
  const row = db.settings.prices[months];
  const v = row && row[screens];
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'Esa combinación de meses y pantallas no tiene precio.');
  return v;
}
/** Administradores y superadministrador no gastan creditos */
function costFor(me, months, screens) { return paysCredits(me) ? price(months, screens) : 0; }
function ensureCredits(me, cost) {
  if (cost > me.credits && !me.allowNegative) throw new HttpError(400, `No tienes créditos suficientes: hacen falta ${cost} y tienes ${me.credits}. Pide una recarga a tu administrador.`);
}
function spend(me, cost, text) {
  if (cost <= 0) return;
  me.credits -= cost;
  addLedger(me, -cost, text, me);
}

/* ---------- Validacion ---------- */
function str(v, max = 200) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function cleanUrl(v) {
  const u = str(v, 300).replace(/\/+$/, '').replace(/\/emby$/i, '');
  if (!/^https?:\/\/[^\s/]+/i.test(u)) throw new HttpError(400, 'La dirección debe empezar por http:// o https:// (ejemplo: http://192.168.0.29:8096).');
  return u;
}
function readAccess(body) {
  const all = !!body && body.all === true;
  const folders = body && Array.isArray(body.folders) ? body.folders.map(String).slice(0, 500) : [];
  return { all, folders: all ? [] : folders };
}
function readPlan(body, current) {
  const months = Number(body.months);
  const screens = body.screens === undefined && current ? (current.screens || 1) : Number(body.screens);
  let quality = body.quality === undefined && current ? current.quality : body.quality;
  if (quality === '' || quality === 'custom') quality = null;
  if (!MONTHS.includes(months)) throw new HttpError(400, 'Elige una duración de 1, 3, 6 o 12 meses.');
  if (!SCREENS.includes(screens)) throw new HttpError(400, 'Elige 1, 2 o 4 pantallas.');
  if (quality !== null && !QUALITIES[quality]) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
  if (quality === null && !(current && current.quality === null)) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
  return { months, screens, quality };
}
/** Datos de contacto del cliente final (todos opcionales) */
function readContact(body, current) {
  const out = {};
  for (const k of ['email', 'telegram', 'whatsapp', 'signal']) {
    if (body[k] === undefined) { if (current) continue; out[k] = ''; continue; }
    out[k] = str(body[k], 120);
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new HttpError(400, 'El email no parece válido.');
  return out;
}
function readUsername(v) {
  const u = str(v, 30).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new HttpError(400, 'El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo.');
  return u;
}
function readNewPassword(v, min = 8) {
  const p = typeof v === 'string' ? v : '';
  if (p.length < min) throw new HttpError(400, `La contraseña debe tener al menos ${min} caracteres.`);
  return p;
}
function assertEmbyNameFree(server, embyName) {
  if (db.clients.some((c) => c.serverId === server.id && c.embyName.toLowerCase() === embyName.toLowerCase())) {
    throw new HttpError(409, 'Ya hay una cuenta con ese usuario de Emby en el panel.');
  }
}
const pubUser = (u) => ({
  id: u.id, username: u.username, name: u.name, role: u.role, parentId: u.parentId, credits: u.credits, disabled: !!u.disabled, createdAt: u.createdAt,
  creditPrice: u.creditPrice || 0, allowNegative: !!u.allowNegative, allowDemos: u.allowDemos !== false, serverIds: u.serverIds || [],
  canCreateSubs: u.canCreateSubs !== false, subCost: u.subCost || 0,
  perms: permsOf(u), useCredits: u.role === 'admin' && !!u.useCredits, tech: !!u.tech, email: u.email || '', currency: u.currency || 'EUR', xtreme: u.xtreme || null,
});
const CURRENCIES = ['EUR', 'USD', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'GBP'];
/** Datos propios de un administrador: permisos, creditos, etiqueta de tecnico, correo, moneda y enlace a otro panel */
function readAdminOptions(me, body, u) {
  if (u.role !== 'admin' || !isStaff(me)) return;
  if (body.email !== undefined) {
    const e = str(body.email, 120);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Ese correo electrónico no parece válido.');
    u.email = e;
  }
  if (body.currency !== undefined) {
    if (!CURRENCIES.includes(body.currency)) throw new HttpError(400, 'Esa moneda no está en la lista.');
    u.currency = body.currency;
  }
  if (body.tech !== undefined) u.tech = !!body.tech;
  if (body.useCredits !== undefined) u.useCredits = !!body.useCredits;
  if (body.perms !== undefined && body.perms && typeof body.perms === 'object') {
    const mine = permsOf(me), next = {};
    for (const k of PERMS) {
      next[k] = !!body.perms[k];
      if (next[k] && !mine[k]) throw new HttpError(403, 'No puedes dar un permiso que tú no tienes.');
    }
    u.perms = next;
  }
  if (body.xtreme !== undefined) {
    if (!body.xtreme) delete u.xtreme;
    else {
      const url = str(body.xtreme.url, 300);
      if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new HttpError(400, 'La dirección del panel debe empezar por http:// o https://');
      u.xtreme = { url, user: str(body.xtreme.user, 80), note: str(body.xtreme.note, 200), at: today() };
    }
  }
}
/** Servidores en los que un usuario puede crear cuentas: lista vacia = todos */
function serverAllowed(u, s) { return isStaff(u) || !u.serverIds || !u.serverIds.length || u.serverIds.includes(s.id); }
function assertServerAllowed(u, s) { if (!serverAllowed(u, s)) throw new HttpError(403, `No tienes permiso para crear cuentas en "${s.name}".`); }
/** Opciones del vendedor que solo fijan los administradores */
function readVendorOptions(me, body, u) {
  if (!isStaff(me)) return;
  if (body.creditPrice !== undefined) {
    const n = Number(body.creditPrice);
    if (!(n >= 0 && n <= 100000)) throw new HttpError(400, 'El precio por crédito no es válido.');
    u.creditPrice = Math.round(n * 100) / 100;
  }
  if (body.allowNegative !== undefined) u.allowNegative = !!body.allowNegative;
  if (body.allowDemos !== undefined) u.allowDemos = !!body.allowDemos;
  // Jerarquia: si este reseller puede crear subresellers y cuantos creditos le cuesta cada uno
  if (body.canCreateSubs !== undefined) u.canCreateSubs = !!body.canCreateSubs;
  if (body.subCost !== undefined) {
    const n = Number(body.subCost);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, 'El coste de creación debe ser un número de créditos entre 0 y 10000.');
    u.subCost = n;
  }
  if (body.serverIds !== undefined) u.serverIds = (Array.isArray(body.serverIds) ? body.serverIds.map(Number) : []).filter((id) => db.servers.some((x) => x.id === id));
}
function publicData(me) {
  const vis = visibleOwners(me);
  const users = db.users.filter((u) => !vis || vis.has(u.id)).map(pubUser);
  // Actividad de hoy y del mes: [mias, de todo lo que veo]
  const t = today(), month = t.slice(0, 7);
  const stats = { today: {}, month: {} };
  for (const k of ['alta', 'renovacion', 'demo']) { stats.today[k] = [0, 0]; stats.month[k] = [0, 0]; }
  const sales = new Map();
  // Altas y renovaciones de cada uno de los ultimos 30 dias, para la grafica del resumen
  const from = addDays(t, -29), oldest = from < month + '-01' ? from : month + '-01';
  const byDay = new Map();
  for (let k = 0; k < 30; k++) byDay.set(addDays(from, k), { d: addDays(from, k), alta: 0, renovacion: 0 });
  stats.days = [...byDay.values()];
  for (const l of db.log) {
    const d = localDate(new Date(l.ts));
    if (d < oldest) break; // el registro va de mas nuevo a mas antiguo
    if (!stats.month[l.type]) continue;
    if (vis && !((l.ownerId != null && vis.has(l.ownerId)) || l.actorId === me.id)) continue;
    if (l.type !== 'demo' && byDay.has(d)) byDay.get(d)[l.type]++;
    if (d.slice(0, 7) !== month) continue;
    const own = l.actorId === me.id;
    stats.month[l.type][1]++; if (own) stats.month[l.type][0]++;
    if (d === t) { stats.today[l.type][1]++; if (own) stats.today[l.type][0]++; }
    if (l.type !== 'demo' && l.actorId != null) sales.set(l.actorId, (sales.get(l.actorId) || 0) + 1);
  }
  const spent = new Map();
  for (const l of db.ledger) {
    if (localDate(new Date(l.ts)).slice(0, 7) < month) break;
    if (l.delta < 0 && /^(Alta|Renovación)/.test(l.text)) spent.set(l.userId, (spent.get(l.userId) || 0) - l.delta);
  }
  for (const u of users) { u.salesMonth = sales.get(u.id) || 0; u.spentMonth = spent.get(u.id) || 0; }
  // Creditos gastados en total por cada administrador que usa creditos
  const admins = new Map(users.filter((u) => u.role === 'admin').map((u) => [u.id, u]));
  if (admins.size) {
    for (const u of admins.values()) u.spentTotal = 0;
    for (const l of db.ledger) if (l.delta < 0 && admins.has(l.userId) && /^(Alta|Renovación)/.test(l.text)) admins.get(l.userId).spentTotal -= l.delta;
  }
  const P = permsOf(me), adm = me.role === 'admin';
  const seeClients = !adm || P.clients, seeServers = me.role === 'super' || (adm && P.viewServers);
  return {
    today: today(), now: new Date().toISOString(),
    me: pubUser(me),
    settings: { ...db.settings, notices: { ...db.settings.notices, telegram: { on: db.settings.notices.telegram.on, bot: db.settings.notices.telegram.bot, hasToken: !!db.settings.notices.telegram.token } } },
    servers: db.servers.map((s) => (seeServers
      ? { id: s.id, name: s.name, usable: true, publicUrl: s.publicUrl || '', url: s.url, packages: s.packages || {}, ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') } }
      : { id: s.id, name: s.name, usable: serverAllowed(me, s), publicUrl: s.publicUrl || '', ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') } })),
    users, stats: seeClients ? stats : { today: Object.fromEntries(Object.keys(stats.today).map((k) => [k, [0, 0]])), month: Object.fromEntries(Object.keys(stats.month).map((k) => [k, [0, 0]])), days: stats.days.map((x) => ({ d: x.d, alta: 0, renovacion: 0 })) },
    clients: db.clients.filter((c) => seeClients && (!vis || vis.has(c.ownerId))).map((c) => ({ ...c, tgChat: undefined, tgLinked: !!c.tgChat, tgCode: tgCode(c) })),
    log: db.log.filter((l) => l.type !== 'login' && seeClients && (!vis ? true : (l.ownerId != null && vis.has(l.ownerId)) || l.actorId === me.id)).slice(0, 500),
    ledger: db.ledger.filter((l) => (adm && !P.reports ? l.userId === me.id : !vis || vis.has(l.userId))).slice(0, 500),
    lastRun: db.lastRun,
    alertsUnread: !seeClients ? 0 : db.alerts.reduce((n, a) => n + (!a.read && (!vis || vis.has(a.ownerId)) ? 1 : 0), 0),
  };
}

/* ---------- Rutas ---------- */
const routes = [];
/** roles: null = sin sesion; '*' = cualquiera con sesion; o lista de roles */
function route(method, pattern, roles, handler) {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, handler });
}
const STAFF = ['super', 'admin'];
const SUPER = ['super'];

route('GET', '/api/state', null, ({ req }) => ({ needsSetup: !db.users.length, authed: !!currentUser(req), brand: db.settings.brand, support: db.settings.support }));
/* Marca del panel: nombre, color y logo propios */
route('PUT', '/api/brand', SUPER, ({ me, body }) => lock(async () => {
  const name = str(body.name, 30) || 'Concha';
  const color = str(body.color, 7);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'El color no es válido.');
  const logo = typeof body.logo === 'string' ? body.logo : '';
  if (logo && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new HttpError(400, 'El logo debe ser una imagen PNG, JPG, WEBP o SVG.');
  if (logo.length > 420000) throw new HttpError(400, 'El logo pesa demasiado. Usa una imagen de menos de 300 KB.');
  const url = str(body.url, 200).replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new HttpError(400, 'La dirección del panel debe empezar por http:// o https://');
  db.settings.brand = { ...db.settings.brand, name, color: color.toLowerCase(), logo, url };
  addLog('ajustes', null, 'Marca del panel cambiada', me);
  saveDb();
  return { ok: true, brand: db.settings.brand };
}));

route('POST', '/api/setup', null, ({ req, body, res }) => {
  if (db.users.length) throw new HttpError(400, 'El panel ya está configurado.');
  const u = { id: newId(), username: readUsername(body.username), name: 'Superadministrador', role: 'super', parentId: null, credits: 0, disabled: false, createdAt: today() };
  setPassword(u, readNewPassword(body.password));
  db.users.push(u);
  saveDb();
  startSession(res, u, isHttps(req));
  return { ok: true };
});

route('POST', '/api/login', null, async ({ req, body, res }) => {
  const username = str(body.username, 30).toLowerCase();
  const f = loginFails.get(username) || { count: 0, until: 0 };
  if (f.until > Date.now()) throw new HttpError(429, 'Demasiados intentos. Espera un minuto.');
  const u = db.users.find((x) => x.username === username);
  const ok = !!u && !u.disabled && checkPassword(u, typeof body.password === 'string' ? body.password : '');
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600));
    f.count++;
    if (f.count >= 5) { f.count = 0; f.until = Date.now() + 60000; }
    loginFails.set(username, f);
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  }
  loginFails.delete(username);
  startSession(res, u, isHttps(req));
  await lock(async () => { addLog('login', null, `Inicio de sesión de ${u.name} (${u.username})`, u); saveDb(); });
  return { ok: true };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const tok = sessionToken(req);
  if (tok) sessions.delete(tok);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});

route('POST', '/api/my-password', '*', ({ me, body }) => {
  if (!checkPassword(me, typeof body.current === 'string' ? body.current : '')) throw new HttpError(400, 'La contraseña actual no es correcta.');
  setPassword(me, readNewPassword(body.next));
  saveDb();
  return { ok: true };
});

route('GET', '/api/data', '*', ({ me }) => publicData(me));

/* Ajustes (solo superadministrador) */
route('PUT', '/api/settings', SUPER, ({ me, body }) => lock(async () => {
  const num = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}: escribe un número entre ${min} y ${max}.`);
    return n;
  };
  const g = db.settings;
  if (body.prices !== undefined) {
    const prices = {};
    for (const m of MONTHS) {
      prices[m] = {};
      for (const s of SCREENS) prices[m][s] = num(body.prices && body.prices[m] && body.prices[m][s], 0, 999, `Precio de ${m} meses y ${s} pantallas`);
    }
    g.prices = prices;
  }
  if (body.graceDays !== undefined) g.graceDays = num(body.graceDays, 0, 90, 'Días de gracia');
  if (body.purgeDays !== undefined) g.purgeDays = num(body.purgeDays, 0, 3650, 'Días en la papelera');
  if (body.demoPurgeDays !== undefined) g.demoPurgeDays = num(body.demoPurgeDays, 0, 30, 'Días que se guardan las demos terminadas');
  if (body.warnDays !== undefined) g.warnDays = num(body.warnDays, 1, 90, 'Aviso de vencimiento');
  if (body.demoMax !== undefined) g.demoMax = num(body.demoMax, 0, 999, 'Demos a la vez');
  if (body.demoHours !== undefined) {
    const hs = [...new Set((Array.isArray(body.demoHours) ? body.demoHours : []).map(Number))].filter((h) => Number.isInteger(h) && h >= 1 && h <= 72).sort((a, b) => a - b).slice(0, 6);
    if (!hs.length) throw new HttpError(400, 'Deja al menos una duración de demo, entre 1 y 72 horas.');
    g.demoHours = hs;
  }
  if (body.monitorSec !== undefined) g.monitorSec = num(body.monitorSec, 10, 600, 'Intervalo de vigilancia');
  if (body.liveSec !== undefined) g.liveSec = num(body.liveSec, 5, 120, 'Refresco de «En directo»');
  if (body.currency !== undefined) {
    if (!CURRENCIES.includes(body.currency)) throw new HttpError(400, 'Esa moneda no está en la lista.');
    g.currency = body.currency;
  }
  if (body.creditPrice !== undefined) {
    const n = Number(body.creditPrice);
    if (!(n >= 0 && n <= 100000)) throw new HttpError(400, 'El precio por crédito no es válido.');
    g.creditPrice = Math.round(n * 100) / 100;
  }
  if (body.support !== undefined && body.support && typeof body.support === 'object') {
    const e = str(body.support.email, 120);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'El correo de soporte no parece válido.');
    g.support = { text: str(body.support.text, 300), whatsapp: str(body.support.whatsapp, 40), telegram: str(body.support.telegram, 60), email: e };
  }
  if (body.retention !== undefined && body.retention && typeof body.retention === 'object') {
    g.retention = { logDays: num(body.retention.logDays, 0, 3650, 'Días del registro de actividad'), ledgerDays: num(body.retention.ledgerDays, 0, 3650, 'Días del historial de créditos'), backups: num(body.retention.backups, 3, 90, 'Copias de seguridad') };
    pruneRecords();
  }
  const NAMES = { prices: 'precios', graceDays: 'días de gracia', purgeDays: 'días en la papelera', demoPurgeDays: 'retención de demos', warnDays: 'aviso de vencimiento', demoMax: 'demos a la vez', demoHours: 'duración de las demos',
    monitorSec: 'intervalo de vigilancia', liveSec: 'refresco de En directo', currency: 'moneda', creditPrice: 'precio por crédito', support: 'contacto de soporte', retention: 'retención de datos' };
  addLog('ajustes', null, 'Ajustes del panel cambiados: ' + (Object.keys(body).map((k) => NAMES[k]).filter(Boolean).join(', ') || 'sin cambios'), me);
  saveDb();
  await lifecycle();
  return { ok: true };
}));
/* Estilo de las tarjetas de cifras */
route('PUT', '/api/tiles', SUPER, ({ body }) => lock(async () => {
  if (!['solid', 'glass', 'neon', 'gradient', 'minimal'].includes(body.tiles)) throw new HttpError(400, 'Ese estilo no existe.');
  db.settings.brand.tiles = body.tiles;
  saveDb();
  return { ok: true };
}));
/* Mi perfil: nombre y correo de quien ha entrado */
route('PUT', '/api/me', '*', ({ me, body }) => lock(async () => {
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Escribe tu nombre.');
  const e = str(body.email, 120);
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Ese correo electrónico no parece válido.');
  me.name = name; me.email = e;
  saveDb();
  return { ok: true };
}));
/* Registro de actividad completo, con los inicios de sesion */
route('GET', '/api/logs', STAFF, () => ({ log: db.log.slice(0, 3000), total: db.log.length }));

/* ---------- Avisos de vencimiento ---------- */
function tgCode(c) { return `c${c.id}_${crypto.createHmac('sha256', db.secret).update('tg' + c.id).digest('hex').slice(0, 10)}`; }
function leftWords(left) { return left <= 0 ? 'hoy' : left === 1 ? 'mañana' : `en ${left} días`; }
/** Rellena una plantilla con los datos de la cuenta (sin la contraseña) */
function fillText(text, c) {
  const s = db.servers.find((x) => x.id === c.serverId) || {};
  const left = diffDays(c.expires, today());
  const vars = { nombre: c.panelName, usuario: c.embyName, servidor: s.name || '', direccion: s.publicUrl || '', vence: c.expires.split('-').reverse().join('/'),
    cuando: leftWords(left), dias: String(Math.max(0, left)), pantallas: c.screens ? String(c.screens) : 'sin límite', contenido: c.quality ? QUALITIES[c.quality] : '', 'contraseña': 'la que ya tienes' };
  return String(text || '').replace(/\{([a-záéíóúñ_]+)\}/gi, (m, k) => { k = k.toLowerCase(); if (k === 'contrasena') k = 'contraseña'; if (k === 'dirección') k = 'direccion'; return vars[k] !== undefined ? vars[k] : m; });
}
const dueSoon = (c, days, t) => { if (c.demo || c.status !== 'active') return false; const left = diffDays(c.expires, t); return left >= 0 && left <= days; };
/* 1) Mensaje en la pantalla de Emby: una vez al dia, cuando el cliente esta conectado */
let noticing = false;
async function screenNotices() {
  const cfg = db.settings.notices.screen;
  if (!cfg.on || noticing) return;
  const t = today();
  const due = db.clients.filter((c) => dueSoon(c, cfg.days, t) && c.screenNotice !== t);
  if (!due.length) return;
  noticing = true;
  try {
    let sent = 0;
    for (const s of db.servers) {
      const mine = new Map(due.filter((c) => c.serverId === s.id).map((c) => [c.embyId, c]));
      if (!mine.size) continue;
      let list;
      try { list = await emby(s, 'GET', '/Sessions?ActiveWithinSeconds=180'); } catch { continue; }
      for (const x of list || []) {
        const c = mine.get(x.UserId);
        if (!c || c.screenNotice === t || x.SupportsRemoteControl === false) continue;
        try {
          await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: db.settings.brand.name || 'Aviso', Text: fillText(cfg.message, c), TimeoutMs: 12000 });
          c.screenNotice = t; sent++;
        } catch (e) { /* esa app no admite mensajes: se probara en otra sesion */ }
      }
    }
    if (sent) await lock(async () => saveDb());
  } catch (e) { console.error('Error en los avisos en pantalla:', e.message); }
  finally { noticing = false; }
}
/* 2) Telegram: un bot propio. Cada cliente se enlaza abriendo su enlace personal */
async function tg(method, body, token) {
  const tk = token || db.settings.notices.telegram.token;
  let res;
  try { res = await fetch(`${TG_API}/bot${tk}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error('No se pudo conectar con Telegram. Revisa la conexión a internet de este equipo.'); }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(res.status === 401 || res.status === 404 ? 'Telegram no reconoce ese token. Cópialo de nuevo desde BotFather.' : `Telegram respondió: ${j.description || res.status}`);
  return j.result;
}
let tgBusy = false, tgLastErr = '';
async function telegramPoll() {
  const cfg = db.settings.notices.telegram;
  if (!cfg.on || !cfg.token || tgBusy) return;
  tgBusy = true;
  try {
    const ups = await tg('getUpdates', { offset: cfg.offset || 0, timeout: 0, allowed_updates: ['message'] });
    if (!ups.length) return;
    await lock(async () => {
      for (const u of ups) {
        cfg.offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') continue;
        const chat = msg.chat.id, text = msg.text.trim();
        let reply;
        if (/^\/stop\b/i.test(text)) {
          let n = 0;
          for (const c of db.clients) if (c.tgChat === chat) { delete c.tgChat; n++; }
          reply = n ? 'Hecho. Ya no te enviaré más avisos.' : 'No tenías avisos activados.';
        } else {
          const m = /^\/start\s+(c(\d+)_[0-9a-f]{10})$/i.exec(text);
          const c = m && db.clients.find((x) => x.id === Number(m[2]));
          if (c && tgCode(c) === m[1].toLowerCase()) {
            c.tgChat = chat;
            addLog('aviso', c, 'Telegram enlazado para recibir avisos', null);
            reply = `Listo, ${c.panelName}. Te avisaré por aquí unos días antes de que caduque tu cuenta. Escribe /stop si no quieres más avisos.`;
          } else reply = 'Para activar los avisos abre el enlace personal que te dio tu vendedor.';
        }
        await tg('sendMessage', { chat_id: chat, text: reply }).catch(() => {});
      }
      saveDb();
    });
  } catch (e) { if (tgLastErr !== e.message) console.error('Telegram:', e.message); tgLastErr = e.message; }
  finally { tgBusy = false; }
}
/** Envia el aviso de vencimiento por Telegram, una vez por periodo y solo en horas de dia */
async function telegramNotices() {
  const cfg = db.settings.notices.telegram;
  const h = new Date().getHours();
  if (!cfg.on || !cfg.token || (!process.env.TG_ANYTIME && (h < 10 || h >= 21))) return;
  const t = today();
  const due = db.clients.filter((c) => c.tgChat && dueSoon(c, db.settings.notices.chat.days, t) && c.tgNoticeFor !== c.expires);
  for (const c of due.slice(0, 25)) {
    try {
      await tg('sendMessage', { chat_id: c.tgChat, text: fillText(db.settings.templates.expiring, c) });
      c.tgNoticeFor = c.expires; c.noticeFor = c.expires;
      addLog('aviso', c, 'Aviso de vencimiento enviado por Telegram', null);
    } catch (e) {
      if (/blocked|chat not found|deactivated/i.test(e.message)) { delete c.tgChat; addLog('aviso', c, 'Telegram desenlazado: el cliente bloqueó el bot', null); }
      else { console.error('Telegram:', e.message); break; }
    }
  }
  if (due.length) saveDb();
}
route('PUT', '/api/notices', SUPER, ({ me, body }) => lock(async () => {
  const cur = db.settings.notices;
  const int = (v, min, max, d) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };
  if (body.screen && typeof body.screen === 'object') {
    cur.screen.on = !!body.screen.on;
    cur.screen.days = int(body.screen.days, 1, 30, cur.screen.days);
    if (typeof body.screen.message === 'string' && body.screen.message.trim()) cur.screen.message = body.screen.message.trim().slice(0, 300);
  }
  if (body.chat && typeof body.chat === 'object') cur.chat.days = int(body.chat.days, 1, 30, cur.chat.days);
  if (body.telegram && typeof body.telegram === 'object') {
    const token = str(body.telegram.token, 100);
    if (token && token !== cur.telegram.token) {
      if (!/^\d+:[\w-]{20,}$/.test(token)) throw new HttpError(400, 'Ese no parece un token de bot de Telegram. Tiene la forma 123456:ABC-DEF…');
      let info;
      try { info = await tg('getMe', {}, token); } catch (e) { throw new HttpError(400, e.message); }
      cur.telegram.token = token; cur.telegram.bot = info.username || ''; cur.telegram.offset = 0;
    }
    if (body.telegram.remove === true) { cur.telegram.token = ''; cur.telegram.bot = ''; cur.telegram.on = false; }
    else cur.telegram.on = !!body.telegram.on && !!cur.telegram.token;
  }
  addLog('ajustes', null, 'Avisos de vencimiento cambiados', me);
  saveDb();
  return { ok: true };
}));
/* Marca un aviso como ya dado (por ejemplo, tras enviarlo a mano por WhatsApp) */
route('POST', '/api/clients/:id/noticed', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.noticeFor !== c.expires) { c.noticeFor = c.expires; addLog('aviso', c, `Aviso de vencimiento enviado${body.via ? ' por ' + str(body.via, 20) : ''}`, me); saveDb(); }
  return { ok: true };
}));
/* Desenlaza el Telegram de un cliente */
route('POST', '/api/clients/:id/tg-unlink', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.tgChat) { delete c.tgChat; addLog('aviso', c, 'Telegram desenlazado', me); saveDb(); }
  return { ok: true };
}));

route('PUT', '/api/templates', SUPER, ({ body }) => lock(async () => {
  const next = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    const v = typeof body[k] === 'string' ? body[k].replace(/\r\n/g, '\n').slice(0, 2000).trim() : '';
    next[k] = v || DEFAULT_TEMPLATES[k]; // vacio = volver al texto original
  }
  db.settings.templates = next;
  saveDb();
  return { ok: true };
}));

/* Servidores (solo superadministrador) */
route('POST', '/api/servers', SUPER, ({ me, body }) => lock(async () => {
  const s = { id: 0, name: str(body.name, 60), url: cleanUrl(body.url), publicUrl: str(body.publicUrl, 200), apiKey: str(body.apiKey, 200), packages: {} };
  if (!s.name) throw new HttpError(400, 'Ponle un nombre al servidor.');
  if (!s.apiKey) throw new HttpError(400, 'Falta la API key.');
  const info = await emby(s, 'GET', '/System/Info');
  s.id = newId();
  db.servers.push(s);
  addLog('servidor', null, `Servidor "${s.name}" conectado (Emby ${info && info.Version ? info.Version : '?'})`, me);
  saveDb();
  return { ok: true, id: s.id };
}));
route('PUT', '/api/servers/:id', SUPER, ({ params, body }) => lock(async () => {
  const s = serverById(params.id);
  const next = { ...s, name: str(body.name, 60) || s.name, url: cleanUrl(body.url), publicUrl: body.publicUrl === undefined ? (s.publicUrl || '') : str(body.publicUrl, 200), apiKey: str(body.apiKey, 200) || s.apiKey };
  await emby(next, 'GET', '/System/Info');
  Object.assign(s, next);
  saveDb();
  return { ok: true };
}));
route('DELETE', '/api/servers/:id', SUPER, ({ me, params }) => lock(async () => {
  const s = serverById(params.id);
  if (db.clients.some((c) => c.serverId === s.id)) throw new HttpError(400, 'Este servidor tiene cuentas en el panel. Elimínalas o vacía la papelera antes de quitarlo.');
  db.servers = db.servers.filter((x) => x.id !== s.id);
  addLog('servidor', null, `Servidor "${s.name}" quitado del panel`, me);
  saveDb();
  return { ok: true };
}));
route('GET', '/api/servers/:id/test', SUPER, async ({ params }) => {
  const info = await emby(serverById(params.id), 'GET', '/System/Info');
  return { ok: true, name: info.ServerName, version: info.Version };
});
route('GET', '/api/servers/:id/libraries', STAFF, async ({ params }) => ({ libraries: await embyLibraries(serverById(params.id)) }));
/* Que bibliotecas incluye cada contenido. Se aplica al momento a las cuentas activas. */
route('PUT', '/api/servers/:id/packages', SUPER, ({ me, params, body }) => lock(async () => {
  const s = serverById(params.id);
  s.packages = { basico: readAccess(body.basico), k4: readAccess(body.k4) };
  let failed = 0;
  for (const c of db.clients) {
    if (c.serverId !== s.id || c.status !== 'active' || !c.quality) continue;
    try { await grantAccess(c); } catch { failed++; }
  }
  addLog('servidor', null, `Contenido Básico y 4K actualizado en "${s.name}"`, me);
  saveDb();
  return { ok: true, failed };
}));

/* Importar usuarios que ya existen en Emby (administradores) */
route('GET', '/api/servers/:id/emby-users', STAFF, async ({ params }) => {
  const s = serverById(params.id);
  const users = await emby(s, 'GET', '/Users');
  const known = new Set(db.clients.filter((c) => c.serverId === s.id).map((c) => c.embyId));
  return { users: (users || []).filter((u) => !known.has(u.Id)).map((u) => ({ id: u.Id, name: u.Name, admin: !!(u.Policy && u.Policy.IsAdministrator), disabled: !!(u.Policy && u.Policy.IsDisabled) })) };
});
route('POST', '/api/import', STAFF, ({ me, body }) => lock(async () => {
  if (isStaff(me) && paysCredits(me)) throw new HttpError(403, 'Tienes el sistema de créditos activado: la importación desde Emby la hace el superadministrador.');
  const s = serverById(body.serverId);
  if (!isDate(body.expires)) throw new HttpError(400, 'Indica una fecha de vencimiento válida.');
  const owner = body.ownerId ? userById(body.ownerId) : me;
  const ids = Array.isArray(body.embyIds) ? body.embyIds.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Marca al menos un usuario.');
  let count = 0;
  for (const id of ids) {
    if (db.clients.some((c) => c.serverId === s.id && c.embyId === id)) continue;
    const u = await emby(s, 'GET', `/Users/${id}`);
    const pol = u.Policy || {};
    if (pol.IsAdministrator) continue; // nunca se gestionan administradores de Emby
    const c = {
      id: newId(), serverId: s.id, ownerId: owner.id, embyId: u.Id, embyName: u.Name, panelName: u.Name, note: '',
      createdAt: today(), expires: body.expires, status: 'active', demo: false,
      screens: 0, quality: null, access: { all: !!pol.EnableAllFolders, folders: pol.EnabledFolders || [] },
    };
    db.clients.push(c);
    addLog('importada', c, `Importada desde Emby, vence el ${c.expires}`, me);
    count++;
  }
  saveDb();
  await lifecycle();
  return { ok: true, count };
}));

/* Importador universal: filas ya leidas de un CSV, Excel, TXT o SQL. Enlaza con el usuario de Emby que ya existe o lo crea */
route('POST', '/api/import/rows', STAFF, ({ me, body }) => lock(async () => {
  if (isStaff(me) && paysCredits(me)) throw new HttpError(403, 'Tienes el sistema de créditos activado: la importación la hace el superadministrador.');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'No hay filas que importar.');
  if (rows.length > 100) throw new HttpError(400, 'Envía como mucho 100 filas cada vez.');
  const dry = !!body.dry, create = !!body.create;
  const defServer = body.serverId ? serverById(body.serverId) : null;
  const defOwner = body.ownerId ? userById(body.ownerId) : me;
  const norm = (v) => str(String(v == null ? '' : v), 300).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/emby$/, '');
  const embyCache = new Map();
  const embyUsers = async (s) => {
    if (!embyCache.has(s.id)) embyCache.set(s.id, new Map(((await emby(s, 'GET', '/Users')) || []).map((u) => [String(u.Name).toLowerCase(), u])));
    return embyCache.get(s.id);
  };
  const out = [];
  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const embyName = str(String(r.username == null ? '' : r.username), 60);
    const res = { i, username: embyName, status: 'error', text: '' };
    out.push(res);
    try {
      if (!embyName) throw new HttpError(400, 'Falta el nombre de usuario.');
      const want = norm(r.server);
      const named = want ? db.servers.find((x) => [x.name, x.url, x.publicUrl].some((v) => v && norm(v) === want)) : null;
      if (want && !named) throw new HttpError(400, `No conozco el servidor «${str(String(r.server), 80)}». Escribe en esa columna el nombre o la dirección de uno de tus servidores, o déjala vacía.`);
      const s = named || defServer;
      if (!s) throw new HttpError(400, 'Elige un servidor.');
      const ow = norm(r.owner);
      const namedOwner = ow ? db.users.find((u) => u.username === ow || u.name.toLowerCase() === ow) : null;
      if (ow && !namedOwner) throw new HttpError(400, `No existe el vendedor «${str(String(r.owner), 60)}». Créalo antes en Vendedores, con ese mismo usuario o nombre.`);
      const owner = namedOwner || defOwner;
      if (!isDate(r.expires)) throw new HttpError(400, 'La fecha de vencimiento no se entiende.');
      const n = Number(r.screens);
      const screens = n >= 3 ? 4 : n === 2 ? 2 : 1;
      const quality = /4k|uhd|2160/i.test(String(r.package || '')) ? 'k4' : 'basico';
      if (!packageReady(s, quality)) throw new HttpError(400, `El contenido ${QUALITIES[quality]} aún no está configurado en ${s.name}.`);
      const users = await embyUsers(s);
      const eu = users.get(embyName.toLowerCase());
      if (db.clients.some((c) => c.serverId === s.id && ((eu && c.embyId === eu.Id) || c.embyName.toLowerCase() === embyName.toLowerCase()))) { res.status = 'skip'; res.text = 'Ya está en el panel'; continue; }
      if (eu && eu.Policy && eu.Policy.IsAdministrator) { res.status = 'skip'; res.text = 'Es un administrador de Emby: no se gestiona'; continue; }
      const expired = diffDays(r.expires, today()) < 0;
      const password = typeof r.password === 'string' ? r.password : r.password == null ? '' : String(r.password);
      if (!eu && !create) throw new HttpError(400, `No existe en ${s.name}. Marca «Crear en Emby las que falten» para crearla.`);
      if (!eu && expired) { res.status = 'skip'; res.text = 'Ya caducada y no existe en Emby: no se crea'; continue; }
      if (!eu && password.length < 4) throw new HttpError(400, 'No existe en Emby y no trae contraseña (mínimo 4 caracteres) para crearla.');
      const what = `${owner.name}, ${s.name}, ${screens} ${screens === 1 ? 'pantalla' : 'pantallas'}, ${QUALITIES[quality]}, vence el ${r.expires}`;
      if (dry) { res.status = 'ok'; res.text = (eu ? 'Se enlazará con su usuario de Emby' : 'Se creará en Emby') + (expired ? ' (caducada: sin bibliotecas)' : '') + `. ${what}`; continue; }
      const contact = readContact({ email: r.email, telegram: r.telegram, whatsapp: r.whatsapp, signal: r.signal }, null);
      const c = {
        id: newId(), serverId: s.id, ownerId: owner.id, embyId: eu ? eu.Id : '', embyName: eu ? eu.Name : embyName,
        panelName: str(String(r.name || ''), 80) || embyName, note: str(String(r.notes || ''), 300),
        createdAt: isDate(r.start) ? r.start : today(), expires: r.expires, status: expired ? 'expired' : 'active', demo: false,
        screens, quality, ...contact, paid: true,
      };
      if (eu) await applyState(c); // pone sus bibliotecas, pantallas y bloqueos, o se las quita si ya caduco
      else await createInEmby(c, password);
      if (password) c.password = password;
      db.clients.push(c);
      addLog('importada', c, `Importada desde archivo${eu ? '' : ' y creada en Emby'}, vence el ${c.expires}`, me);
      res.status = 'ok'; res.text = (eu ? 'Enlazada' : 'Creada en Emby') + `. ${what}`; done++;
    } catch (e) { res.status = 'error'; res.text = e.message; }
  }
  if (!dry && done) { saveDb(); await lifecycle(); }
  return { ok: true, results: out, done };
}));

/* Cuentas */
async function createInEmby(c, password) {
  const s = serverOf(c);
  const created = await emby(s, 'POST', '/Users/New', { Name: c.embyName });
  c.embyId = created.Id;
  c.embyName = created.Name || c.embyName;
  try {
    await setEmbyPassword(s, c.embyId, password, true);
    await grantAccess(c);
  } catch (e) {
    await emby(s, 'DELETE', `/Users/${c.embyId}`).catch(() => {}); // no dejar una cuenta a medias
    throw e;
  }
}
route('POST', '/api/clients', '*', ({ me, body }) => lock(async () => {
  const s = serverById(body.serverId);
  assertServerAllowed(me, s);
  const embyName = str(body.embyName, 60);
  const password = readNewPassword(body.password, 4);
  if (!embyName) throw new HttpError(400, 'Escribe el nombre de usuario de Emby.');
  assertEmbyNameFree(s, embyName);
  const plan = readPlan(body, null);
  const owner = isStaff(me) && body.ownerId ? userById(body.ownerId) : me;
  const cost = costFor(me, plan.months, plan.screens);
  ensureCredits(me, cost);
  const c = {
    id: newId(), serverId: s.id, ownerId: owner.id, embyId: '', embyName,
    panelName: str(body.panelName, 80) || embyName, note: str(body.note, 300),
    createdAt: today(), expires: addMonths(today(), plan.months), status: 'active', demo: false,
    screens: plan.screens, quality: plan.quality,
    ...readContact(body, null), paid: body.paid !== false,
  };
  await createInEmby(c, password);
  c.password = password;
  db.clients.push(c);
  const what = `${plan.months} ${plan.months === 1 ? 'mes' : 'meses'}, ${plan.screens} ${plan.screens === 1 ? 'pantalla' : 'pantallas'}, ${QUALITIES[plan.quality]}`;
  spend(me, cost, `Alta de ${c.embyName} (${what})`);
  addLog('alta', c, `Alta: ${what}. Vence el ${c.expires}` + (cost ? `. ${cost} ${cost === 1 ? 'crédito' : 'créditos'}` : ''), me);
  saveDb();
  return { ok: true, id: c.id };
}));

/* Demos: gratis, por horas */
route('POST', '/api/demos', '*', ({ me, body }) => lock(async () => {
  const s = serverById(body.serverId);
  assertServerAllowed(me, s);
  if (!isStaff(me) && me.allowDemos === false) throw new HttpError(403, 'Tu usuario no tiene permiso para crear demos.');
  const embyName = str(body.embyName, 60);
  const password = readNewPassword(body.password, 4);
  const hours = Number(body.hours);
  if (!embyName) throw new HttpError(400, 'Escribe el nombre de usuario de Emby.');
  if (!db.settings.demoHours.includes(hours)) throw new HttpError(400, 'Elige una duración de demo válida.');
  if (!QUALITIES[body.quality]) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
  assertEmbyNameFree(s, embyName);
  const max = db.settings.demoMax;
  if (!isStaff(me) && max > 0 && db.clients.filter((c) => c.demo && c.status === 'active' && c.ownerId === me.id).length >= max) {
    throw new HttpError(400, `Ya tienes ${max} demos en curso, que es el máximo. Espera a que termine alguna.`);
  }
  const end = new Date(Date.now() + hours * 3600000);
  const c = {
    id: newId(), serverId: s.id, ownerId: me.id, embyId: '', embyName,
    panelName: str(body.panelName, 80) || embyName, note: str(body.note, 300),
    createdAt: today(), expires: localDate(end), expiresAt: end.toISOString(), status: 'active', demo: true,
    screens: 1, quality: body.quality,
    ...readContact(body, null), paid: true,
  };
  await createInEmby(c, password);
  c.password = password;
  db.clients.push(c);
  addLog('demo', c, `Demo de ${hours} horas, ${QUALITIES[c.quality]}`, me);
  saveDb();
  return { ok: true, id: c.id };
}));

route('PUT', '/api/clients/:id', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.status === 'trash') throw new HttpError(400, 'Está en la papelera: renuévala o restáurala antes de editarla.');
  const s = serverOf(c);
  const changes = [];
  const newPassword = typeof body.password === 'string' && body.password ? readNewPassword(body.password, 4) : '';
  readContact(body, c); // valida antes de tocar nada
  if (isStaff(me)) {
    // Solo administradores: fecha, pantallas, contenido y dueno
    const free = !paysCredits(me); // con creditos activados, fecha y pantallas solo cambian renovando
    if (!free && ((!c.demo && body.expires !== undefined && body.expires !== c.expires) || (body.screens !== undefined && Number(body.screens) !== c.screens))) {
      throw new HttpError(403, 'Tienes el sistema de créditos activado: la fecha y las pantallas se cambian renovando la cuenta.');
    }
    if (!c.demo && body.expires !== undefined && body.expires !== c.expires) {
      if (!isDate(body.expires)) throw new HttpError(400, 'La fecha de vencimiento no es válida.');
      changes.push(`vencimiento ${c.expires} → ${body.expires}`);
      c.expires = body.expires;
    }
    if (body.screens !== undefined && Number(body.screens) !== c.screens) {
      const n = Number(body.screens);
      if (!SCREENS.includes(n)) throw new HttpError(400, 'Elige 1, 2 o 4 pantallas.');
      c.screens = n; changes.push(`${n} ${n === 1 ? 'pantalla' : 'pantallas'}`);
    }
    if (body.quality !== undefined) {
      const q = body.quality === 'custom' || body.quality === '' ? null : body.quality;
      if (q !== null && !QUALITIES[q]) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
      if (q === null && c.quality !== null) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
      if (q !== c.quality) { c.quality = q; changes.push('contenido ' + QUALITIES[q]); }
    }
    if (body.ownerId !== undefined && Number(body.ownerId) !== c.ownerId) {
      const o = userById(body.ownerId);
      c.ownerId = o.id; changes.push('pasa a ' + o.name);
    }
  }
  let contentChanged = false, prevQuality = null;
  if (!isStaff(me) && body.quality !== undefined && body.quality !== c.quality && body.quality !== 'custom' && body.quality !== '') {
    if (!QUALITIES[body.quality]) throw new HttpError(400, 'Elige el contenido: Básico o 4K.');
    if (!packageReady(s, body.quality)) throw new HttpError(400, `El contenido ${QUALITIES[body.quality]} aún no está configurado en este servidor.`);
    prevQuality = c.quality; c.quality = body.quality; contentChanged = true; changes.push('contenido ' + QUALITIES[c.quality]);
  }
  const stillValid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
  if (stillValid && isStaff(me)) { await grantAccess(c); c.status = 'active'; }
  else if (contentChanged && c.status === 'active') { try { await grantAccess(c); } catch (e) { c.quality = prevQuality; throw e; } }
  if (newPassword) { await setEmbyPassword(s, c.embyId, newPassword, false); c.password = newPassword; changes.push('contraseña'); }
  const panelName = str(body.panelName, 80);
  if (panelName && panelName !== c.panelName) { c.panelName = panelName; changes.push('nombre'); }
  const contact = readContact(body, c);
  if (Object.keys(contact).some((k) => contact[k] !== (c[k] || ''))) { Object.assign(c, contact); changes.push('contacto'); }
  if (body.paid !== undefined && !!body.paid !== (c.paid !== false)) { c.paid = !!body.paid; changes.push(c.paid ? 'cobrado' : 'cobro pendiente'); }
  if (body.note !== undefined) c.note = str(body.note, 300);
  if (changes.length) addLog('edicion', c, 'Editada: ' + changes.join(', '), me);
  saveDb();
  await lifecycle();
  return { ok: true };
}));

route('POST', '/api/clients/:id/renew', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  const plan = readPlan(body, c);
  const cost = costFor(me, plan.months, plan.screens);
  ensureCredits(me, cost);
  const t = today();
  // Si aun no ha vencido se suma a su fecha; si ya vencio o era una demo, cuenta desde hoy
  const base = !c.demo && diffDays(c.expires, t) >= 0 ? c.expires : t;
  const before = { expires: c.expires, status: c.status, screens: c.screens, quality: c.quality, demo: c.demo, expiresAt: c.expiresAt };
  c.expires = addMonths(base, plan.months);
  c.screens = plan.screens; c.quality = plan.quality; c.demo = false; delete c.expiresAt;
  try { await grantAccess(c); }
  catch (e) { Object.assign(c, before); if (before.expiresAt === undefined) delete c.expiresAt; throw e; }
  c.status = 'active';
  c.paid = body.paid !== false;
  delete c.trashedAt; delete c.trashReason; delete c.lastError;
  const what = `${plan.months} ${plan.months === 1 ? 'mes' : 'meses'}, ${plan.screens} ${plan.screens === 1 ? 'pantalla' : 'pantallas'}${plan.quality ? ', ' + QUALITIES[plan.quality] : ''}`;
  spend(me, cost, `${before.demo ? 'Alta desde demo' : 'Renovación'} de ${c.embyName} (${what})`);
  addLog('renovacion', c, `${before.demo ? 'Demo convertida en cuenta' : 'Renovada'}: ${what}. Vence el ${c.expires}` + (cost ? `. ${cost} ${cost === 1 ? 'crédito' : 'créditos'}` : ''), me);
  saveDb();
  return { ok: true, expires: c.expires };
}));

route('POST', '/api/clients/:id/trash', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.status === 'trash') return { ok: true };
  await trashClient(me, c);
  saveDb();
  return { ok: true };
}));

route('POST', '/api/clients/:id/restore', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.status !== 'trash') return { ok: true };
  if (c.demo) throw new HttpError(400, 'Las demos no se restauran. Renuévala para convertirla en cuenta.');
  if (diffDays(c.expires, today()) < 0) throw new HttpError(400, 'Su suscripción ya venció. Renuévala para sacarla de la papelera.');
  await grantAccess(c);
  c.status = 'active';
  delete c.trashedAt; delete c.trashReason;
  addLog('restaurada', c, 'Restaurada desde la papelera', me);
  saveDb();
  return { ok: true };
}));

route('DELETE', '/api/clients/:id', STAFF, ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  await deleteEmbyUser(c);
  db.clients = db.clients.filter((x) => x.id !== c.id);
  addLog('eliminada', c, 'Eliminada definitivamente de Emby y del panel', me);
  saveDb();
  return { ok: true };
}));

/* Historial de una cuenta */
route('GET', '/api/clients/:id/history', '*', ({ me, params }) => {
  const c = clientFor(me, params.id);
  const rows = db.log.filter((l) => (l.clientId != null ? l.clientId === c.id : (l.emby === c.embyName && l.ownerId === c.ownerId)));
  return { history: rows.slice(0, 200) };
});

/** Deja la cuenta en Emby tal como dice el panel */
async function applyState(c) {
  const valid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
  if (c.status === 'active' && valid) await grantAccess(c);
  else await removeAccess(c, c.status === 'trash');
}

/* Reparar: vuelve a aplicar en Emby el estado del panel; si el usuario fue borrado en Emby, lo crea de nuevo */
/** Reparar: revisa el servidor, el usuario y sus bibliotecas en Emby, y lo deja todo como dice el panel. Devuelve un informe */
async function repairClient(me, c) {
  const s = serverOf(c);
  const report = [];
  const say = (ok, text) => report.push({ ok, text });
  const info = await emby(s, 'GET', '/System/Info');
  say(true, `El servidor "${s.name}" responde (Emby ${(info && info.Version) || '?'}).`);
  const libs = await embyLibraries(s);
  const libName = new Map(libs.map((l) => [l.id, l.name]));
  const valid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
  const shouldHave = c.status === 'active' && valid;
  let wanted = null;
  if (shouldHave) {
    wanted = accessOf(c); // avisa si el paquete no esta configurado
    const missing = wanted.all ? [] : wanted.folders.filter((f) => !libName.has(f));
    if (missing.length) report.push({ ok: false, warn: true, text: `${missing.length} ${missing.length === 1 ? 'biblioteca del paquete ya no existe' : 'bibliotecas del paquete ya no existen'} en el servidor. Vuelve a elegirlas en Servidores, Contenido.` });
  }
  let before = null, recreated = false;
  try { before = await readPolicy(s, c.embyId); }
  catch (e) {
    if (e.embyStatus !== 404) throw e;
    if (!c.password) throw new HttpError(400, 'El usuario ya no existe en Emby y el panel no tiene su contraseña para crearlo de nuevo. Dale de baja y crea la cuenta otra vez.');
    if (!c.quality) throw new HttpError(400, 'El usuario ya no existe en Emby. Asígnale contenido Básico o 4K antes de repararlo.');
    const created = await emby(s, 'POST', '/Users/New', { Name: c.embyName });
    c.embyId = created.Id;
    await setEmbyPassword(s, c.embyId, c.password, true);
    recreated = true;
    say(false, 'El usuario no existía en Emby: se ha creado de nuevo con su contraseña.');
  }
  if (before && before.IsAdministrator) say(false, 'Era administrador en Emby: se le han quitado esos permisos.');
  if (before) say(before.EnableVideoPlaybackTranscoding === false, before.EnableVideoPlaybackTranscoding === false ? 'La transcodificación de vídeo ya estaba desactivada.' : 'Tenía permitida la transcodificación de vídeo: se ha desactivado.');
  await applyState(c);
  const after = await readPolicy(s, c.embyId);
  if (shouldHave) {
    const names = after.EnableAllFolders ? 'todas' : (after.EnabledFolders || []).map((f) => libName.get(f) || 'biblioteca desconocida').join(', ');
    const wasRight = before && !before.IsDisabled && !!before.EnableAllFolders === !!wanted.all && (wanted.all || sameLibs(before.EnabledFolders, wanted.folders));
    say(wasRight, `${wasRight ? 'Las bibliotecas ya eran las correctas' : 'Bibliotecas corregidas'}${c.quality ? ` (paquete ${QUALITIES[c.quality]})` : ''}: ${names || 'ninguna'}.`);
    if (before && before.IsDisabled) say(false, 'Estaba desactivada en Emby: se ha vuelto a activar.');
    if (c.screens > 0) say(!before || before.SimultaneousStreamLimit === c.screens, `Pantallas a la vez: ${c.screens}${before && before.SimultaneousStreamLimit !== c.screens ? ' (corregido)' : ''}.`);
  } else {
    const had = before && polHasLibs(before);
    say(!had, `${c.status === 'trash' ? 'Está en la papelera' : c.demo ? 'La demo ha terminado' : 'Está caducada'}: ${had ? 'tenía bibliotecas y se le han retirado' : 'no tiene bibliotecas, como debe ser'}.`);
  }
  delete c.lastError;
  const fixed = report.filter((r) => !r.ok && !r.warn).length;
  addLog('reparada', c, recreated ? 'Reparada: usuario creado de nuevo en Emby' : fixed ? `Reparada: ${fixed} ${fixed === 1 ? 'cosa corregida' : 'cosas corregidas'} en Emby` : 'Reparada: todo estaba correcto en Emby', me);
  return { recreated, report };
}
route('POST', '/api/clients/:id/repair', '*', ({ me, params }) => lock(async () => {
  const r = await repairClient(me, clientFor(me, params.id));
  saveDb();
  return { ok: true, ...r };
}));

/* Transferir a otro servidor: crea el usuario en el nuevo y lo borra del antiguo (el historial de reproduccion no viaja) */
async function moveClient(me, c, to, passwordIn) {
  const from = serverOf(c);
  if (to.id === from.id) throw new HttpError(400, 'La cuenta ya está en ese servidor.');
  if (!c.quality) throw new HttpError(400, 'Usa bibliotecas propias del servidor actual. Asígnale contenido Básico o 4K antes de transferirla.');
  if (!packageReady(to, c.quality)) throw new HttpError(400, `El contenido ${QUALITIES[c.quality]} aún no está configurado en "${to.name}".`);
  const password = passwordIn ? readNewPassword(passwordIn, 4) : c.password;
  if (!password) throw new HttpError(400, 'El panel no tiene guardada su contraseña. Cámbiala primero o transfiérela sola escribiendo una nueva.');
  if (db.clients.some((x) => x.id !== c.id && x.serverId === to.id && x.embyName.toLowerCase() === c.embyName.toLowerCase())) throw new HttpError(409, 'En ese servidor ya hay una cuenta con el mismo usuario de Emby.');
  const old = { serverId: c.serverId, embyId: c.embyId };
  const created = await emby(to, 'POST', '/Users/New', { Name: c.embyName });
  c.serverId = to.id; c.embyId = created.Id;
  try {
    await setEmbyPassword(to, c.embyId, password, true);
    await applyState(c);
  } catch (e) {
    await emby(to, 'DELETE', `/Users/${created.Id}`).catch(() => {});
    Object.assign(c, old);
    throw e;
  }
  c.password = password;
  let leftover = '';
  try { await emby(from, 'DELETE', `/Users/${old.embyId}`); }
  catch (e) { if (e.embyStatus !== 404) leftover = ` No se pudo borrar del servidor antiguo: ${e.message}`; }
  addLog('transferida', c, `Transferida de "${from.name}" a "${to.name}".${leftover}`, me);
  return leftover.trim();
}
route('POST', '/api/clients/:id/move', STAFF, ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  const warning = await moveClient(me, c, serverById(body.serverId), typeof body.password === 'string' ? body.password : '');
  saveDb();
  return { ok: true, warning };
}));

async function trashClient(me, c) {
  await removeAccess(c, true);
  c.status = 'trash'; c.trashedAt = today(); c.trashReason = c.demo ? 'Demo cancelada' : 'Baja manual';
  addLog('baja', c, 'Baja: cuenta desactivada y enviada a la papelera', me);
}
/* Varias cuentas a la vez */
function bulkClients(me, body) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))] : [];
  if (!ids.length) throw new HttpError(400, 'No has seleccionado ninguna cuenta.');
  if (ids.length > 500) throw new HttpError(400, 'Selecciona como mucho 500 cuentas cada vez.');
  return ids.map((id) => clientFor(me, id));
}
/** Aplica fn a cada cuenta; cada una se guarda aunque el proceso se corte. fn devuelve false para saltarla */
async function bulkEach(list, fn) {
  let moved = 0, skipped = 0;
  const failed = [];
  for (const c of list) {
    try { if (await fn(c) === false) skipped++; else moved++; }
    catch (e) { failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
    saveDb();
  }
  return { ok: true, moved, skipped, failed };
}
route('POST', '/api/bulk/repair', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => repairClient(me, c).then(() => true))));
route('POST', '/api/bulk/trash', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => (c.status === 'trash' ? false : trashClient(me, c).then(() => true)))));
/* Ajustar fechas: suma o resta dias al vencimiento. No toca demos ni cuentas en la papelera */
route('POST', '/api/bulk/dates', STAFF, ({ me, body }) => lock(async () => {
  if (isStaff(me) && paysCredits(me)) throw new HttpError(403, 'Tienes el sistema de créditos activado: las fechas se cambian renovando.');
  const list = bulkClients(me, body);
  const days = Number(body.days);
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 3650) throw new HttpError(400, 'Escribe un número de días distinto de cero (negativo para restar).');
  const t = today();
  const r = await bulkEach(list, async (c) => {
    if (c.demo || c.status === 'trash') return false;
    const before = c.expires;
    c.expires = addDays(before, days);
    try { if (diffDays(c.expires, t) >= 0) { await grantAccess(c); c.status = 'active'; } }
    catch (e) { c.expires = before; throw e; }
    addLog('edicion', c, `Editada: vencimiento ${before} → ${c.expires} (ajuste de ${days > 0 ? '+' : ''}${days} días)`, me);
    return true;
  });
  await lifecycle(); // las que queden vencidas pierden las bibliotecas
  return r;
}));
route('POST', '/api/bulk/owner', STAFF, ({ me, body }) => lock(async () => {
  const list = bulkClients(me, body);
  const owner = userById(body.ownerId);
  let moved = 0;
  for (const c of list) {
    if (c.ownerId === owner.id) continue;
    c.ownerId = owner.id; moved++;
    addLog('edicion', c, 'Editada: pasa a ' + owner.name, me);
  }
  saveDb();
  return { ok: true, moved, skipped: list.length - moved, failed: [] };
}));
route('POST', '/api/bulk/move', STAFF, ({ me, body }) => lock(async () => {
  const list = bulkClients(me, body);
  const to = serverById(body.serverId);
  let moved = 0, skipped = 0;
  const failed = [];
  for (const c of list) {
    if (c.serverId === to.id) { skipped++; continue; }
    try { await moveClient(me, c, to, ''); moved++; }
    catch (e) { failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
    saveDb(); // cada cuenta queda guardada aunque el proceso se corte
  }
  return { ok: true, moved, skipped, failed };
}));

/* Cobros: marca que el cliente final ya ha pagado */
route('POST', '/api/clients/:id/paid', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.paid === false) { c.paid = true; addLog('cobro', c, 'Cobro recibido', me); saveDb(); }
  return { ok: true };
}));

/* Auditoria: compara lo que dice el panel con lo que hay de verdad en Emby */
route('GET', '/api/audit', STAFF, async () => {
  const names = new Map(db.users.map((u) => [u.id, u.name]));
  const out = { notInPanel: [], notInEmby: [], mismatch: [], errors: [], checked: 0 };
  for (const s of db.servers) {
    let users;
    try { users = await emby(s, 'GET', '/Users'); }
    catch (e) { out.errors.push(e.message); continue; }
    const byId = new Map((users || []).map((u) => [u.Id, u]));
    const mine = db.clients.filter((c) => c.serverId === s.id);
    const known = new Set(mine.map((c) => c.embyId));
    for (const u of users || []) {
      const pol = u.Policy || {};
      if (!known.has(u.Id) && !pol.IsAdministrator) out.notInPanel.push({ server: s.name, name: u.Name, disabled: !!pol.IsDisabled });
    }
    for (const c of mine) {
      out.checked++;
      const row = { id: c.id, server: s.name, panelName: c.panelName, embyName: c.embyName, owner: names.get(c.ownerId) || '' };
      const u = byId.get(c.embyId);
      if (!u) { out.notInEmby.push(row); continue; }
      const pol = u.Policy || {};
      const hasLibs = !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0;
      const problems = [];
      if (c.status === 'active') {
        if (pol.IsDisabled) problems.push('en el panel está activa, pero en Emby está desactivada');
        else if (!hasLibs) problems.push('en el panel está activa, pero en Emby no tiene bibliotecas');
        if (c.screens > 0 && pol.SimultaneousStreamLimit !== c.screens) problems.push(`tiene ${c.screens} ${c.screens === 1 ? 'pantalla' : 'pantallas'} en el panel y ${pol.SimultaneousStreamLimit || 'sin límite'} en Emby`);
      } else if (c.status === 'expired') {
        if (hasLibs) problems.push('está caducada, pero en Emby conserva bibliotecas');
      } else if (c.status === 'trash') {
        if (!pol.IsDisabled) problems.push('está en la papelera, pero en Emby sigue activada');
      }
      if (u.Name !== c.embyName) problems.push(`en Emby ahora se llama "${u.Name}"`);
      if (pol.IsAdministrator) problems.push('es administrador en Emby y no debería');
      if (pol.EnableVideoPlaybackTranscoding !== false) problems.push('tiene permitida la transcodificación de vídeo');
      if (c.status === 'active' && !pol.IsDisabled && hasLibs && c.quality && packageReady(s, c.quality)) {
        const pk = s.packages[c.quality];
        if (!!pk.all !== !!pol.EnableAllFolders || (!pk.all && !sameLibs(pk.folders, pol.EnabledFolders))) problems.push(`sus bibliotecas en Emby no son las del paquete ${QUALITIES[c.quality]}`);
      }
      if (problems.length) out.mismatch.push({ ...row, problems });
    }
  }
  return out;
});

route('POST', '/api/run', STAFF, async () => { await lock(lifecycle); await lock(telegramNotices); return { ok: true }; });

/* Usuarios del panel */
route('POST', '/api/users', ['super', 'admin', 'reseller'], ({ me, body }) => lock(async () => {
  const role = me.role === 'reseller' ? 'sub' : body.role;
  const allowed = me.role === 'super' ? ['admin', 'reseller', 'sub']
    : me.role === 'admin' ? [...(can(me, 'resellers') ? ['reseller', 'sub'] : []), ...(can(me, 'admins') ? ['admin'] : [])] : ['sub'];
  if (!allowed.includes(role)) throw new HttpError(403, 'No puedes crear usuarios de ese nivel.');
  const username = readUsername(body.username);
  if (db.users.some((u) => u.username === username)) throw new HttpError(409, 'Ese nombre de usuario ya está en uso.');
  const subCost = me.role === 'reseller' ? (me.subCost || 0) : 0;
  if (me.role === 'reseller') {
    if (me.canCreateSubs === false) throw new HttpError(403, 'Tu cuenta no tiene permiso para crear subresellers. Pídeselo a tu administrador.');
    ensureCredits(me, subCost);
  }
  let parentId = null;
  if (role === 'sub') {
    const parent = me.role === 'reseller' ? me : userById(body.parentId);
    if (parent.role !== 'reseller') throw new HttpError(400, 'Elige el reseller del que depende este subreseller.');
    parentId = parent.id;
  }
  const u = { id: newId(), username, name: str(body.name, 60) || username, role, parentId, credits: 0, disabled: false, createdAt: today() };
  setPassword(u, readNewPassword(body.password));
  readVendorOptions(me, body, u);
  if (role === 'admin') {
    // Un administrador nuevo no puede nacer con mas permisos que quien lo crea
    const mine = permsOf(me);
    u.perms = Object.fromEntries(PERMS.map((k) => [k, DEFAULT_PERMS[k] && mine[k]]));
    readAdminOptions(me, body, u);
  }
  db.users.push(u);
  if (subCost > 0) { me.credits -= subCost; addLedger(me, -subCost, `Creación del subreseller ${u.name}`, me, 'ajuste'); }
  addLog('usuario', null, `Nuevo ${ROLE_NAME[role].toLowerCase()}: ${u.name} (${u.username})` + (subCost ? `. ${subCost} ${subCost === 1 ? 'crédito' : 'créditos'}` : ''), me);
  saveDb();
  return { ok: true };
}));
route('PUT', '/api/users/:id', ['super', 'admin', 'reseller'], ({ me, params, body }) => lock(async () => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes editar a este usuario.');
  needPerm(me, u.role === 'admin' ? 'admins' : 'resellers');
  const name = str(body.name, 60);
  if (name) u.name = name;
  if (typeof body.password === 'string' && body.password) { setPassword(u, readNewPassword(body.password)); dropSessions(u.id); }
  if (body.disabled !== undefined) { u.disabled = !!body.disabled; if (u.disabled) dropSessions(u.id); }
  if (isStaff(me) && u.role === 'sub' && body.parentId !== undefined && Number(body.parentId) !== u.parentId) {
    const parent = userById(body.parentId);
    if (parent.role !== 'reseller') throw new HttpError(400, 'Un subreseller solo puede depender de un reseller.');
    u.parentId = parent.id;
  }
  readVendorOptions(me, body, u);
  const before = u.role === 'admin' ? JSON.stringify([permsOf(u), !!u.useCredits]) : '';
  readAdminOptions(me, body, u);
  if (before && before !== JSON.stringify([permsOf(u), !!u.useCredits])) addLog('usuario', null, `Permisos de ${u.name} cambiados`, me);
  saveDb();
  return { ok: true };
}));
route('DELETE', '/api/users/:id', ['super', 'admin', 'reseller'], ({ me, params }) => lock(async () => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes eliminar a este usuario.');
  needPerm(me, u.role === 'admin' ? 'admins' : 'resellers');
  if (db.clients.some((c) => c.ownerId === u.id)) throw new HttpError(400, 'Este usuario todavía tiene cuentas (mira también la papelera). Pásalas a otro usuario o elimínalas antes.');
  if (db.users.some((x) => x.parentId === u.id)) throw new HttpError(400, 'Este reseller tiene subresellers. Elimínalos antes.');
  db.users = db.users.filter((x) => x.id !== u.id);
  dropSessions(u.id);
  addLog('usuario', null, `Usuario eliminado: ${u.name} (${u.username})` + (u.credits ? `, tenía ${u.credits} créditos` : ''), me);
  saveDb();
  return { ok: true };
}));
/* Creditos: los administradores los crean o retiran; un reseller los pasa de su saldo a sus subresellers */
route('POST', '/api/users/:id/credits', ['super', 'admin', 'reseller'], ({ me, params, body }) => lock(async () => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes dar créditos a este usuario.');
  if (!holdsCredits(u)) throw new HttpError(400, 'Este usuario no usa créditos. Actívale primero el sistema de créditos.');
  const packs = db.settings.creditPacks || [];
  const pack = body.pack !== undefined && body.pack !== null && body.pack !== '' ? packs[Number(body.pack)] : null;
  if (body.pack !== undefined && body.pack !== null && body.pack !== '' && !pack) throw new HttpError(400, 'Ese paquete de créditos ya no existe.');
  const extra = body.amount === undefined || body.amount === null || body.amount === '' ? 0 : Number(body.amount);
  if (!Number.isInteger(extra)) throw new HttpError(400, 'Escribe una cantidad de créditos sin decimales.');
  const amount = (pack ? pack.credits : 0) + extra;
  if (amount === 0 || Math.abs(amount) > 100000) throw new HttpError(400, 'Elige un paquete o escribe una cantidad de créditos.');
  const note = str(body.note, 120);
  const reason = str(body.reason, 40);
  const detail = (pack ? ` (${pack.name})` : '') + (note ? ': ' + note : '');
  if (!paysCredits(me)) {
    if (u.credits + amount < 0 && !u.allowNegative) throw new HttpError(400, `No se pueden retirar ${-amount}: solo tiene ${u.credits}.`);
    u.credits += amount;
    const label = reason || (amount > 0 ? 'Recarga' : 'Retirada');
    addLedger(u, amount, label + detail, me, amount < 0 || /ajuste|penaliz|devoluc/i.test(label) ? 'ajuste' : 'credito');
  } else {
    if (amount < 0 && me.role !== 'admin') throw new HttpError(400, 'Solo puedes pasar créditos, no retirarlos.');
    if (amount < 0) {
      // Un administrador con creditos recupera a su saldo lo que retira
      if (u.credits + amount < 0 && !u.allowNegative) throw new HttpError(400, `No se pueden retirar ${-amount}: solo tiene ${u.credits}.`);
      u.credits += amount;
      addLedger(u, amount, `Devuelto a ${me.name}` + detail, me, 'ajuste');
      me.credits -= amount;
      addLedger(me, -amount, `Devuelto por ${u.name}` + detail, me, 'credito');
      saveDb();
      return { ok: true, credits: u.credits };
    }
    ensureCredits(me, amount);
    me.credits -= amount;
    addLedger(me, -amount, `Para ${u.name}` + detail, me, 'asignacion');
    u.credits += amount;
    addLedger(u, amount, `Recibido de ${me.name}` + detail, me, 'credito');
  }
  saveDb();
  return { ok: true, credits: u.credits };
}));

/* Ultima conexion de cada cuenta, segun Emby (se guarda un minuto para no saturarlo) */
const seenCache = new Map(); // serverId -> { at, map }
route('GET', '/api/lastseen', '*', async ({ me }) => {
  const vis = visibleOwners(me);
  const seen = {};
  for (const s of db.servers) {
    let hit = seenCache.get(s.id);
    if (!hit || Date.now() - hit.at > 60000) {
      try {
        const users = await emby(s, 'GET', '/Users');
        hit = { at: Date.now(), map: new Map((users || []).map((u) => [u.Id, u.LastActivityDate || null])) };
        seenCache.set(s.id, hit);
      } catch { continue; }
    }
    for (const c of db.clients) {
      if (c.serverId === s.id && (!vis || vis.has(c.ownerId)) && hit.map.has(c.embyId)) seen[c.id] = hit.map.get(c.embyId);
    }
  }
  return { seen };
});

/* Historial de creditos de un usuario */
route('GET', '/api/users/:id/ledger', '*', ({ me, params }) => {
  const u = userById(params.id);
  const vis = visibleOwners(me);
  if (vis && !vis.has(u.id)) throw new HttpError(404, 'Ese usuario ya no existe.');
  return { credits: u.credits, ledger: db.ledger.filter((l) => l.userId === u.id).slice(0, 300) };
});
/* Paquetes de creditos que se ofrecen al recargar */
route('PUT', '/api/credit-packs', SUPER, ({ body }) => lock(async () => {
  const packs = [];
  for (const p of Array.isArray(body.packs) ? body.packs.slice(0, 12) : []) {
    const name = str(p && p.name, 40), credits = Number(p && p.credits);
    if (!name && !credits) continue;
    if (!name || !Number.isInteger(credits) || credits < 1 || credits > 100000) throw new HttpError(400, 'Cada paquete necesita un nombre y una cantidad de créditos mayor que cero.');
    packs.push({ name, credits });
  }
  db.settings.creditPacks = packs;
  saveDb();
  return { ok: true };
}));

/* ---------- Alertas: transcodificacion y sesiones excedidas ---------- */
const recent = new Map(); // clave -> momento del ultimo aviso, para no repetir el mismo
async function stopSession(s, x, text) {
  await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: 'Aviso', Text: text, TimeoutMs: 10000 }).catch(() => {});
  await emby(s, 'POST', `/Sessions/${x.Id}/Playing/Stop`, {});
}
function sessionTitle(x) {
  const it = x.NowPlayingItem || {};
  return it.SeriesName ? `${it.SeriesName} – ${it.Name || ''}` : (it.Name || '');
}
let monitoring = false;
let lastPrune = 0;
const pending = new Map(); // exceso de pantallas visto por primera vez -> cuando
async function monitor() {
  const cfg = db.settings.alerts;
  if (monitoring || (!cfg.transcode.on && !cfg.sessions.on)) return;
  monitoring = true;
  try {
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 6 * 3600000) recent.delete(k);
    const events = [];
    let recheck = false;
    for (const s of db.servers) {
      let list;
      try { list = await emby(s, 'GET', '/Sessions'); } catch { continue; }
      const byUser = new Map();
      for (const x of list || []) {
        if (!x.NowPlayingItem || !x.UserId) continue;
        if (!byUser.has(x.UserId)) byUser.set(x.UserId, []);
        byUser.get(x.UserId).push(x);
      }
      for (const [uid, sess] of byUser) {
        const c = db.clients.find((k) => k.serverId === s.id && k.embyId === uid);
        if (!c) continue; // solo se vigilan las cuentas del panel
        let live = sess;
        if (cfg.transcode.on) {
          for (const x of sess) {
            const ti = x.TranscodingInfo, method = (x.PlayState || {}).PlayMethod;
            const video = ti ? ti.IsVideoDirect === false : method === 'Transcode';
            const any = video || method === 'Transcode' || (!!ti && ti.IsAudioDirect === false);
            if (!(cfg.transcode.onlyVideo ? video : any)) continue;
            const key = `t:${s.id}:${x.Id}:${(x.NowPlayingItem || {}).Id || ''}`;
            if (recent.has(key) && now - recent.get(key) < (cfg.transcode.stop ? 20000 : 6 * 3600000)) continue;
            recent.set(key, now);
            let action = 'Solo aviso';
            if (cfg.transcode.stop) {
              try { await stopSession(s, x, cfg.transcode.message); action = 'Reproducción detenida'; live = live.filter((y) => y !== x); }
              catch (e) { action = 'No se pudo detener'; }
            }
            events.push({ type: 'transcode', c, s, action, device: x.DeviceName || '', app: x.Client || '', item: sessionTitle(x),
              reason: (ti && Array.isArray(ti.TranscodeReasons) && ti.TranscodeReasons.length ? ti.TranscodeReasons.join(', ') : (video ? 'Vídeo transcodificado' : 'Audio transcodificado')) });
          }
        }
        if (cfg.sessions.on && c.screens > 0 && live.length > c.screens) {
          const key = `s:${c.id}`, pk = `p:${c.id}`;
          // tiempo de gracia: solo se actua si el exceso sigue ahi pasados esos segundos
          if (cfg.sessions.stop && cfg.sessions.grace > 0) {
            if (!pending.has(pk)) { pending.set(pk, now); recheck = true; continue; }
            if (now - pending.get(pk) < cfg.sessions.grace * 1000) continue;
          }
          pending.delete(pk);
          if (recent.has(key) && now - recent.get(key) < (cfg.sessions.stop ? 60000 : 30 * 60000)) continue;
          recent.set(key, now);
          let action = 'Solo aviso';
          if (cfg.sessions.stop) {
            // por defecto se detienen las que llevan menos tiempo reproduciendo; tambien se puede lo contrario, o todas
            const pol = cfg.sessions.policy, dir = pol === 'oldest' ? -1 : 1;
            const extra = [...live].sort((a, b) => dir * (((a.PlayState || {}).PositionTicks || 0) - ((b.PlayState || {}).PositionTicks || 0))).slice(0, pol === 'all' ? live.length : live.length - c.screens);
            let ok = 0;
            for (const x of extra) { try { await stopSession(s, x, cfg.sessions.message); ok++; } catch (e) { /* se registra abajo */ } }
            action = ok ? `${ok} ${ok === 1 ? 'reproducción detenida' : 'reproducciones detenidas'}` : 'No se pudo detener';
          }
          events.push({ type: 'sesiones', c, s, action, device: live.map((x) => x.DeviceName || '?').join(', '), app: '', item: live.map(sessionTitle).filter(Boolean).join(' / '),
            reason: `${live.length} reproducciones a la vez con ${c.screens} ${c.screens === 1 ? 'pantalla contratada' : 'pantallas contratadas'}` });
        } else pending.delete(`p:${c.id}`);
      }
    }
    if (recheck) setTimeout(() => { monitor().catch(() => {}); }, cfg.sessions.grace * 1000 + 300);
    const prune = now - lastPrune > 3600000;
    if (events.length || prune) {
      lastPrune = now;
      await lock(async () => {
        for (const e of events) {
          const prev = db.alerts.filter((a) => a.type === e.type && a.clientId === e.c.id && now - Date.parse(a.ts) < 86400000).length;
          db.alerts.unshift({ id: newId(), ts: new Date().toISOString(), type: e.type, level: prev >= 2 ? 'critica' : 'aviso', read: false,
            clientId: e.c.id, client: e.c.panelName, emby: e.c.embyName, ownerId: e.c.ownerId, serverId: e.s.id, server: e.s.name,
            device: e.device, app: e.app, item: e.item, reason: e.reason, action: e.action });
        }
        const keep = { transcode: cfg.transcode.retention, sesiones: cfg.sessions.retention };
        const before = db.alerts.length;
        db.alerts = db.alerts.filter((a) => now - Date.parse(a.ts) < (keep[a.type] || 30) * 86400000).slice(0, 20000);
        if (events.length || db.alerts.length !== before) saveDb();
      });
    }
  } catch (e) { console.error('Error en el monitor de alertas:', e.message); }
  finally { monitoring = false; }
}
route('GET', '/api/alerts', '*', ({ me }) => {
  const vis = visibleOwners(me);
  return { alerts: db.alerts.filter((a) => !vis || vis.has(a.ownerId)).slice(0, 5000), config: db.settings.alerts };
});
route('PUT', '/api/alerts/config', STAFF, ({ me, body }) => lock(async () => {
  const cur = db.settings.alerts;
  const days = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : d; };
  for (const k of ['transcode', 'sessions']) {
    const b = body[k];
    if (!b || typeof b !== 'object') continue;
    const was = cur[k].on;
    if (b.on !== undefined) cur[k].on = !!b.on;
    if (b.stop !== undefined) cur[k].stop = !!b.stop;
    if (k === 'transcode' && b.onlyVideo !== undefined) cur[k].onlyVideo = !!b.onlyVideo;
    if (b.retention !== undefined) cur[k].retention = days(b.retention, cur[k].retention);
    if (k === 'sessions' && b.grace !== undefined) { const n = Number(b.grace); if (Number.isInteger(n) && n >= 0 && n <= 300) cur[k].grace = n; }
    if (k === 'sessions' && ['newest', 'oldest', 'all'].includes(b.policy)) cur[k].policy = b.policy;
    if (typeof b.message === 'string' && b.message.trim()) cur[k].message = b.message.trim().slice(0, 300);
    if (was !== cur[k].on) addLog('alertas', null, `${k === 'transcode' ? 'Control de transcodificación' : 'Control de sesiones excedidas'} ${cur[k].on ? 'activado' : 'desactivado'}`, me);
  }
  saveDb();
  return { ok: true };
}));
route('POST', '/api/alerts/read', '*', ({ me, body }) => lock(async () => {
  const vis = visibleOwners(me);
  const ids = Array.isArray(body.ids) ? new Set(body.ids.map(Number)) : null;
  let n = 0;
  for (const a of db.alerts) {
    if (a.read || (vis && !vis.has(a.ownerId)) || (ids && !ids.has(a.id)) || (body.type && a.type !== body.type)) continue;
    a.read = true; n++;
  }
  if (n) saveDb();
  return { ok: true, read: n };
}));
route('POST', '/api/alerts/clear', STAFF, ({ me, body }) => lock(async () => {
  const before = db.alerts.length;
  db.alerts = body.type ? db.alerts.filter((a) => a.type !== body.type) : [];
  addLog('alertas', null, `Historial de alertas vaciado (${before - db.alerts.length})`, me);
  saveDb();
  return { ok: true };
}));

/* Reproducciones en curso */
route('GET', '/api/sessions', '*', async ({ me }) => {
  const vis = visibleOwners(me);
  const out = [];
  const errors = [];
  await Promise.all(db.servers.map(async (s) => {
    try {
      const mine = vis ? new Set(db.clients.filter((c) => c.serverId === s.id && vis.has(c.ownerId)).map((c) => c.embyId)) : null;
      const list = await emby(s, 'GET', '/Sessions');
      for (const x of list || []) {
        const it = x.NowPlayingItem;
        if (!it || (mine && !mine.has(x.UserId))) continue;
        const ps = x.PlayState || {};
        let title = it.Name || '';
        if (it.SeriesName) {
          const ep = it.ParentIndexNumber != null && it.IndexNumber != null ? ` ${it.ParentIndexNumber}x${pad(it.IndexNumber)}` : '';
          title = `${it.SeriesName}${ep} – ${it.Name}`;
        }
        out.push({ server: s.name, user: x.UserName || '', device: x.DeviceName || '', app: x.Client || '', title, paused: !!ps.IsPaused, method: ps.PlayMethod || '', position: ps.PositionTicks || 0, duration: it.RunTimeTicks || 0 });
      }
    } catch (e) { if (isStaff(me)) errors.push(e.message); else errors.push('No se pudo consultar el servidor.'); }
  }));
  return { sessions: out, errors };
});

/* ---------- Servidor HTTP ---------- */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 1e6) { reject(new HttpError(413, 'Petición demasiado grande.')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const p = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(p && typeof p === 'object' ? p : {}); }
      catch { reject(new HttpError(400, 'Datos mal formados.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      });
      return res.end(fs.readFileSync(INDEX_FILE));
    }
    if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'No encontrado.' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      let me = null;
      if (r.roles) {
        me = currentUser(req);
        if (!me) return send(res, 401, { error: 'Inicia sesión.' });
        // Un administrador entra donde su permiso le deja, aunque la ruta fuera solo del superadministrador
        const need = me.role === 'admin' ? permFor(req.method, pathname) : null;
        if (need && !can(me, need)) return send(res, 403, { error: 'Tu usuario de administrador no tiene este permiso. Pídeselo al superadministrador.' });
        if (r.roles !== '*' && !r.roles.includes(me.role) && !need) return send(res, 403, { error: 'Tu nivel de usuario no permite hacer esto.' });
      }
      let body = {};
      if (req.method !== 'GET') {
        if (req.method !== 'DELETE' && !/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Formato no admitido.');
        body = await readBody(req);
      }
      return send(res, 200, await r.handler({ req, res, body, me, params: m.groups || {} }));
    }
    send(res, 404, { error: 'No encontrado.' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e.embyStatus !== undefined ? 502 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Error interno.' });
  }
});

loadDb();
if (process.argv[2] === 'clave') {
  const boss = db.users.find((u) => u.role === 'super');
  const pw = process.argv[3] || '';
  if (!boss) { console.log('Todavia no hay superadministrador: abre el panel y crealo.'); process.exit(1); }
  if (pw.length < 8) { console.log('Uso: node server.js clave NUEVACLAVE  (minimo 8 caracteres)'); process.exit(1); }
  setPassword(boss, pw);
  saveDb();
  console.log(`Clave cambiada. Usuario del superadministrador: ${boss.username}`);
  process.exit(0);
}
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Panel de cuentas Emby en marcha');
  console.log(`  Abre en el navegador:  http://localhost:${PORT}`);
  console.log('  Deja esta ventana abierta. Para parar el panel, cierrala.');
  console.log('');
  runLifecycle();
  let ticks = 0;
  setInterval(() => { if (++ticks % 60 === 0) { backupDb(); lock(async () => pruneRecords()).catch(() => {}); } runLifecycle(); }, CHECK_EVERY_MS);
  // vigilancia de transcodificacion y sesiones, cada tantos segundos como diga Ajustes, Tiempos
  const watch = () => { Promise.resolve(monitor()).catch(() => {}).finally(() => setTimeout(watch, Number(process.env.MONITOR_MS) || (db.settings.monitorSec || 30) * 1000)); };
  setTimeout(watch, 3000);
  setInterval(screenNotices, Number(process.env.NOTICE_MS) || 60000); // aviso de vencimiento en la pantalla de Emby
  setInterval(telegramPoll, Number(process.env.TG_POLL_MS) || 5000); // mensajes que llegan al bot de Telegram
});
