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
const zlib = require('zlib');

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
  transcode: { on: false, stop: true, tip: true, tipEvery: 30, tipText: '', onlyVideo: true, retention: 30, message: 'Tu app está convirtiendo el vídeo y eso satura el servidor. Ve a Ajustes › Reproducción › Velocidad de transmisión máx. y elige la más alta (1000 Mbit/s o la máxima que tenga). Así se verá fluido.' },
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
  quality: '📺 Para ver Emby con la mejor calidad y sin cortes:\n1. Abre Emby en tu aparato y entra en Ajustes.\n2. Busca «Reproducción», «Calidad de vídeo» o «Calidad remota».\n3. Elige la calidad máxima: el valor más alto que aparezca (por ejemplo 1000 Mbps o «Máxima»).\nDespués, vuelve a reproducir el vídeo. Hazlo en cada aparato donde uses Emby.',
  followup: 'Hola {nombre} 👋\n\n¿Qué tal la prueba de Emby? Si te ha gustado, te la dejo hoy mismo como cuenta fija con todo el contenido.\n\n¿Te la activo?',
  vendor: 'Hola {nombre} 👋\n\nYa tienes acceso al panel {panel}:\n\nDirección: {direccion}\nUsuario: {usuario}\nContraseña: {contraseña}\nTipo de cuenta: {tipo}\nCréditos: {creditos}\n\nLa primera vez que entres, el panel te pedirá elegir una contraseña nueva que solo sepas tú.',
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
  openApiKeys(db.servers);
  if (!Array.isArray(db.access)) db.access = [];
  if (!Array.isArray(db.followups)) db.followups = [];
  if (!Array.isArray(db.broadcasts)) db.broadcasts = [];
  if (!Array.isArray(db.incidents)) db.incidents = [];
  if (!Array.isArray(db.vpay)) db.vpay = [];
  if (!Array.isArray(db.licenses)) db.licenses = [];
  if (typeof db.settings.licContact !== 'string') db.settings.licContact = '';
  if (!db.licState || typeof db.licState !== 'object') db.licState = {};
  if (!db.mustPwMig) { for (const u of db.users) if (u.role !== 'super' && !u.lastLogin) u.mustPw = true; db.mustPwMig = true; } // quien aún no ha entrado nunca: cambiará la contraseña al entrar
  db.settings.vpay = { limit: 0, days: 0, remind: 3, receipts: true, monthly: false, giftAlert: 50, ...(db.settings.vpay || {}) };
  db.settings.guard = { on: true, limit: 10, minutes: 10, block: false, ...(db.settings.guard || {}) };
  if (!Array.isArray(db.churn)) { // renovaciones y bajas por vendedor; la primera vez se rellena con el registro
    db.churn = [];
    for (const l of db.log) {
      if (l.type === 'renovacion' && /^Renovada/.test(l.text) && l.ownerId != null) db.churn.push({ t: l.ts, o: l.ownerId, k: 'ren' });
      if (l.type === 'papelera' && /sin renovar/i.test(l.text) && l.ownerId != null) db.churn.push({ t: l.ts, o: l.ownerId, k: 'lost' });
    }
  }
  db.quality = { servers: {}, reports: [], ...(db.quality || {}) };
  db.settings.alerts = { transcode: { ...DEFAULT_ALERTS.transcode, ...(al.transcode || {}) }, sessions: { ...DEFAULT_ALERTS.sessions, ...(al.sessions || {}) } };
  if (!Array.isArray(db.alerts)) db.alerts = [];
  db.settings.security = { idleMin: 180, ...(db.settings.security || {}) };
  db.payCfg = { stripe: { on: false, key: '', whsec: '' }, nowpay: { on: false, key: '', ipn: '' }, min: 5, ...(db.payCfg || {}) };
  if (!Array.isArray(db.orders)) db.orders = [];
  db.backupCfg = { on: false, hour: 4, salt: '', key: '', last: null, lastError: '', ...(db.backupCfg || {}) };
  db.backupCfg.gdrive = { on: false, url: '', secret: '', last: null, lastError: '', ...(db.backupCfg.gdrive || {}) };
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
/* API keys de Emby cifradas en el disco (AES-256-GCM). La clave vive en data/clave-servidores.key
   (o en la variable SERVER_KEY). En memoria se usan en claro; nunca se mandan al navegador ni a los registros. */
const KEY_FILE = path.join(DATA_DIR, 'clave-servidores.key');
let srvKeyBuf = null;
function srvKey() {
  if (srvKeyBuf) return srvKeyBuf;
  const env = String(process.env.SERVER_KEY || '');
  if (/^[0-9a-f]{64}$/i.test(env)) srvKeyBuf = Buffer.from(env, 'hex');
  else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(KEY_FILE)) srvKeyBuf = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (!srvKeyBuf || srvKeyBuf.length !== 32) { srvKeyBuf = crypto.randomBytes(32); fs.writeFileSync(KEY_FILE, srvKeyBuf.toString('hex'), { mode: 0o600 }); }
  }
  return srvKeyBuf;
}
const encMemo = new Map(); // clave en claro -> texto cifrado (para no recifrar en cada guardado)
function encApiKey(plain) {
  if (!plain) return '';
  if (encMemo.has(plain)) return encMemo.get(plain);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', srvKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const out = ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  encMemo.set(plain, out);
  return out;
}
function decApiKey(enc) {
  const [v, iv, tag, ct] = String(enc || '').split(':');
  if (v !== 'v1') throw new Error('formato desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', srvKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  encMemo.set(plain, enc);
  return plain;
}
/** Lo que se escribe en db.json: igual que en memoria, pero con las API keys cifradas */
function dbForDisk() {
  // Si una clave no se pudo descifrar (falta el archivo de la clave), se guarda tal cual estaba: si el archivo vuelve, se recupera
  return { ...db, servers: (db.servers || []).map(({ apiKey, lostEnc, keyLost, ...x }) => ({ ...x, apiKeyEnc: apiKey ? encApiKey(apiKey) : (lostEnc || '') })) };
}
/** Al cargar: descifra las API keys. Si no se puede (falta la clave), el servidor queda marcado para volver a pegar su API key */
function openApiKeys(list) {
  for (const x of list || []) {
    if (x.apiKeyEnc) {
      try { x.apiKey = decApiKey(x.apiKeyEnc); delete x.keyLost; delete x.lostEnc; } catch { x.apiKey = ''; x.keyLost = true; x.lostEnc = x.apiKeyEnc; }
      delete x.apiKeyEnc;
    }
  }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dbForDisk(), null, 2));
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
  if (actor && actor.role && actor.role !== 'super') guardTrack(actor, type, text);
}
/** kind: credito (recarga), asignacion (traspaso a un subreseller), alta, renovacion, ajuste */
function addLedger(user, delta, text, by, kind, paid) {
  const k = kind || (/^Renovación/.test(text) ? 'renovacion' : /^Alta/.test(text) ? 'alta' : 'ajuste');
  db.ledger.unshift({ ts: new Date().toISOString(), userId: user.id, user: user.name, delta, balance: user.credits, text, kind: k, byId: by ? by.id : null, by: by ? by.name : '', ...(paid ? { paid } : {}) });
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
  pol.RemoteClientBitrateLimit = 0; // sin tope de velocidad en el servidor: un tope bajo obliga a convertir el video
  return pol;
}
const polHasLibs = (pol) => !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0;
const sameLibs = (a, b) => { const n = (x) => [...new Set((x || []).map((v) => String(v).toLowerCase().replace(/-/g, '')))].sort().join(','); return n(a) === n(b); };
async function readPolicy(s, embyId) { return (await emby(s, 'GET', `/Users/${embyId}`)).Policy || {}; }
/** Da acceso: activa la cuenta, le pone SIEMPRE las bibliotecas de su paquete y su limite de pantallas, y comprueba que Emby lo ha aplicado */
async function grantAccess(client) {
  // Desactivada a mano (por ejemplo, no ha pagado): nada la vuelve a activar salvo Activar, Renovar o Restaurar
  if (client.off) { await removeAccess(client, true); return; }
  const s = serverOf(client);
  const acc = accessOf(client);
  const pol = lockDown(await readPolicy(s, client.embyId));
  pol.IsDisabled = false;
  pol.EnableAllFolders = !!acc.all;
  pol.EnabledFolders = acc.all ? [] : acc.folders;
  if (client.screens > 0) pol.SimultaneousStreamLimit = client.screens;
  // Calidad remota: si el servidor la tiene activada y este Emby trae el ajuste, se pone el objetivo
  const qc = db.quality && db.quality.servers[s.id];
  if (qc && qc.auto && 'AutoRemoteQuality' in pol && !(qc.exclude || []).includes(client.embyId)) pol.AutoRemoteQuality = Math.round((qc.mbps || 100) * 1e6);
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
  const down = new Set(); // servidores que no responden en esta pasada: se reintentan en la siguiente, sin esperar cuenta por cuenta
  for (const c of [...db.clients]) {
    if (down.has(c.serverId)) continue;
    try {
      if (c.demo && c.status === 'active' && now >= Date.parse(c.expiresAt)) {
        await removeAccess(c, true);
        c.status = 'trash'; c.trashedAt = t; c.trashReason = 'Demo terminada'; delete c.off; delete c.offBy;
        addFollowup(c);
        addLog('papelera', c, 'Demo terminada: cuenta desactivada');
      }
      if (!c.demo && c.status === 'active' && diffDays(t, c.expires) > 0) {
        const existed = await removeAccess(c, false);
        c.status = 'expired';
        addLog('caducada', c, existed ? 'Caducada: bibliotecas retiradas' : 'Caducada (el usuario ya no existía en Emby)');
      }
      if (c.status === 'expired' && diffDays(t, c.expires) > graceDays) {
        await removeAccess(c, true);
        c.status = 'trash'; c.trashedAt = t; c.trashReason = 'Sin renovar'; delete c.off; delete c.offBy;
        addChurn(c.ownerId, 'lost');
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
      if (e.embyStatus === 0) down.add(c.serverId);
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
  ['GET', /^\/api\/(sessions|lastseen|alerts|monitor)$/, 'clients'],
  ['GET', /^\/api\/poster\//, 'clients'],
  ['POST', /^\/api\/monitor\/(stop|message|broadcast)$/, 'clients'],
  ['POST', /^\/api\/(run|alerts\/read|alerts\/clear)$/, 'clients'],
  ['POST', /^\/api\/audit\//, 'clients'],
  ['PUT', /^\/api\/alerts\/config$/, 'system'],
  ['POST', /^\/api\/users\/\d+\/credits$/, 'credits'],
  ['GET', /^\/api\/(audit|logs|usage|income)$/, 'reports'],
  ['GET', /^\/api\/servers\/\d+\/test$/, 'viewServers'],
  ['GET', /^\/api\/agent\/status$/, 'viewServers'],
  ['GET', /^\/api\/servers\/\d+\/(details|reimport)$/, 'viewServers'],
  ['POST', /^\/api\/servers\/\d+\/(scan|pause|reimport)$/, 'servers'],
  ['POST', /^\/api\/servers\/\d+\/agent\/(link|remove)$/, 'servers'],
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
function startSession(res, user, secure, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 7 * 24 * 3600;
  sessions.set(token, { userId: user.id, exp: Date.now() + maxAge * 1000, sid: crypto.randomBytes(6).toString('hex'), created: Date.now(), seen: Date.now(),
    ip: req ? clientIp(req) : '', ua: req ? uaShort(req.headers['user-agent']) : '' });
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
  // Cierre por inactividad: si nadie usa la sesion durante el tiempo marcado en Seguridad
  const idle = (db.settings.security && db.settings.security.idleMin) || 0;
  if (idle > 0 && Date.now() - (s.seen || 0) > idle * 60000) { sessions.delete(tok); return null; }
  const u = db.users.find((x) => x.id === s.userId);
  if (!u || u.disabled) { sessions.delete(tok); return null; }
  s.seen = Date.now();
  if (req.headers['x-forwarded-for'] || req.socket) s.ip = clientIp(req);
  if (!u.lastSeen || Date.now() - Date.parse(u.lastSeen) > 60000) u.lastSeen = new Date().toISOString();
  return u;
}
function dropSessions(userId, keep) { for (const [k, v] of sessions) if (v.userId === userId && k !== keep) sessions.delete(k); }

/* ---------- Seguridad: IP, aparato, verificacion en dos pasos y avisos ---------- */
/** IP real del visitante. Detras de Coolify/Traefik, la ultima de X-Forwarded-For es la que pone el proxy */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ip = xf.length ? xf[xf.length - 1] : (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '').slice(0, 60);
}
function uaShort(ua) {
  ua = String(ua || '');
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Otro';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  return `${br} en ${os}`;
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(str) { let bits = 0, val = 0; const out = []; for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
/** Codigo de 6 cifras de Google Authenticator para un momento dado (RFC 6238) */
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
/** Comprueba el codigo (admite 30 s de desfase) y no deja usar dos veces el mismo */
function checkTotp(t, code, save) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !t || !t.secret) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    const a = Buffer.from(totpAt(t.secret, step)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) {
      if (t.last && step <= t.last) return false; // ya usado
      if (save !== false) t.last = step;
      return true;
    }
  }
  return false;
}
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newRecoveryCodes(u) {
  const codes = Array.from({ length: 8 }, () => { const r = b32enc(crypto.randomBytes(6)).slice(0, 8); return r.slice(0, 4) + '-' + r.slice(4); });
  u.totp.codes = codes.map(hashCode);
  return codes;
}
function useRecoveryCode(u, code) {
  const h = hashCode(code), i = (u.totp.codes || []).indexOf(h);
  if (i < 0) return false;
  u.totp.codes.splice(i, 1);
  return true;
}
/* Generador de codigos QR. QRCode for JavaScript, Copyright (c) 2009 Kazuhiko Arase (licencia MIT, http://www.opensource.org/licenses/mit-license.php),
 * adaptado por qrcode-terminal (licencia Apache 2.0). "QR Code" es marca registrada de DENSO WAVE INCORPORATED. */
const QRCodeLib = (() => {
  const M = {};
  const req = (n) => M[n.replace("./", "")];
  M["QRMode"] = (() => { const module = { exports: {} }; const require = req;
module.exports = {
    MODE_NUMBER :       1 << 0,
    MODE_ALPHA_NUM :    1 << 1,
    MODE_8BIT_BYTE :    1 << 2,
    MODE_KANJI :        1 << 3
};

  return module.exports; })();
  M["QRMath"] = (() => { const module = { exports: {} }; const require = req;
var QRMath = {
	glog : function(n) {
		if (n < 1) {
			throw new Error("glog(" + n + ")");
		}
		return QRMath.LOG_TABLE[n];
	},
	gexp : function(n) {
		while (n < 0) {
			n += 255;
		}
		while (n >= 256) {
			n -= 255;
		}
		return QRMath.EXP_TABLE[n];
	},
	EXP_TABLE : new Array(256),
	LOG_TABLE : new Array(256)
};
for (var i = 0; i < 8; i++) {
	QRMath.EXP_TABLE[i] = 1 << i;
}
for (var i = 8; i < 256; i++) {
	QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4]
		^ QRMath.EXP_TABLE[i - 5]
		^ QRMath.EXP_TABLE[i - 6]
		^ QRMath.EXP_TABLE[i - 8];
}
for (var i = 0; i < 255; i++) {
	QRMath.LOG_TABLE[QRMath.EXP_TABLE[i] ] = i;
}
module.exports = QRMath;

  return module.exports; })();
  M["QRErrorCorrectLevel"] = (() => { const module = { exports: {} }; const require = req;
module.exports = {
	L : 1,
	M : 0,
	Q : 3,
	H : 2
};

  return module.exports; })();
  M["QRMaskPattern"] = (() => { const module = { exports: {} }; const require = req;
module.exports = {
	PATTERN000 : 0,
	PATTERN001 : 1,
	PATTERN010 : 2,
	PATTERN011 : 3,
	PATTERN100 : 4,
	PATTERN101 : 5,
	PATTERN110 : 6,
	PATTERN111 : 7
};

  return module.exports; })();
  M["QR8bitByte"] = (() => { const module = { exports: {} }; const require = req;
var QRMode = require('./QRMode');
function QR8bitByte(data) {
	this.mode = QRMode.MODE_8BIT_BYTE;
	this.data = data;
}
QR8bitByte.prototype = {
	getLength : function() {
		return this.data.length;
	},
	write : function(buffer) {
		for (var i = 0; i < this.data.length; i++) {
			buffer.put(this.data.charCodeAt(i), 8);
		}
	}
};
module.exports = QR8bitByte;

  return module.exports; })();
  M["QRBitBuffer"] = (() => { const module = { exports: {} }; const require = req;
function QRBitBuffer() {
	this.buffer = [];
	this.length = 0;
}
QRBitBuffer.prototype = {
	get : function(index) {
		var bufIndex = Math.floor(index / 8);
		return ( (this.buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
	},
	put : function(num, length) {
		for (var i = 0; i < length; i++) {
			this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
		}
	},
	getLengthInBits : function() {
		return this.length;
	},
	putBit : function(bit) {
		var bufIndex = Math.floor(this.length / 8);
		if (this.buffer.length <= bufIndex) {
			this.buffer.push(0);
		}
		if (bit) {
			this.buffer[bufIndex] |= (0x80 >>> (this.length % 8) );
		}
		this.length++;
	}
};
module.exports = QRBitBuffer;

  return module.exports; })();
  M["QRPolynomial"] = (() => { const module = { exports: {} }; const require = req;
var QRMath = require('./QRMath');
function QRPolynomial(num, shift) {
	if (num.length === undefined) {
		throw new Error(num.length + "/" + shift);
	}
	var offset = 0;
	while (offset < num.length && num[offset] === 0) {
		offset++;
	}
	this.num = new Array(num.length - offset + shift);
	for (var i = 0; i < num.length - offset; i++) {
		this.num[i] = num[i + offset];
	}
}
QRPolynomial.prototype = {
	get : function(index) {
		return this.num[index];
	},
	getLength : function() {
		return this.num.length;
	},
	multiply : function(e) {
		var num = new Array(this.getLength() + e.getLength() - 1);
		for (var i = 0; i < this.getLength(); i++) {
			for (var j = 0; j < e.getLength(); j++) {
				num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i) ) + QRMath.glog(e.get(j) ) );
			}
		}
		return new QRPolynomial(num, 0);
	},
	mod : function(e) {
		if (this.getLength() - e.getLength() < 0) {
			return this;
		}
		var ratio = QRMath.glog(this.get(0) ) - QRMath.glog(e.get(0) );
		var num = new Array(this.getLength() );
		for (var i = 0; i < this.getLength(); i++) {
			num[i] = this.get(i);
		}
		for (var x = 0; x < e.getLength(); x++) {
			num[x] ^= QRMath.gexp(QRMath.glog(e.get(x) ) + ratio);
		}
		return new QRPolynomial(num, 0).mod(e);
	}
};
module.exports = QRPolynomial;

  return module.exports; })();
  M["QRRSBlock"] = (() => { const module = { exports: {} }; const require = req;
var QRErrorCorrectLevel = require('./QRErrorCorrectLevel');
function QRRSBlock(totalCount, dataCount) {
	this.totalCount = totalCount;
	this.dataCount  = dataCount;
}
QRRSBlock.RS_BLOCK_TABLE = [
	[1, 26, 19],
	[1, 26, 16],
	[1, 26, 13],
	[1, 26, 9],
	[1, 44, 34],
	[1, 44, 28],
	[1, 44, 22],
	[1, 44, 16],
	[1, 70, 55],
	[1, 70, 44],
	[2, 35, 17],
	[2, 35, 13],
	[1, 100, 80],
	[2, 50, 32],
	[2, 50, 24],
	[4, 25, 9],
	[1, 134, 108],
	[2, 67, 43],
	[2, 33, 15, 2, 34, 16],
	[2, 33, 11, 2, 34, 12],
	[2, 86, 68],
	[4, 43, 27],
	[4, 43, 19],
	[4, 43, 15],
	[2, 98, 78],
	[4, 49, 31],
	[2, 32, 14, 4, 33, 15],
	[4, 39, 13, 1, 40, 14],
	[2, 121, 97],
	[2, 60, 38, 2, 61, 39],
	[4, 40, 18, 2, 41, 19],
	[4, 40, 14, 2, 41, 15],
	[2, 146, 116],
	[3, 58, 36, 2, 59, 37],
	[4, 36, 16, 4, 37, 17],
	[4, 36, 12, 4, 37, 13],
	[2, 86, 68, 2, 87, 69],
	[4, 69, 43, 1, 70, 44],
	[6, 43, 19, 2, 44, 20],
	[6, 43, 15, 2, 44, 16],
	[4, 101, 81],
	[1, 80, 50, 4, 81, 51],
	[4, 50, 22, 4, 51, 23],
	[3, 36, 12, 8, 37, 13],
	[2, 116, 92, 2, 117, 93],
	[6, 58, 36, 2, 59, 37],
	[4, 46, 20, 6, 47, 21],
	[7, 42, 14, 4, 43, 15],
	[4, 133, 107],
	[8, 59, 37, 1, 60, 38],
	[8, 44, 20, 4, 45, 21],
	[12, 33, 11, 4, 34, 12],
	[3, 145, 115, 1, 146, 116],
	[4, 64, 40, 5, 65, 41],
	[11, 36, 16, 5, 37, 17],
	[11, 36, 12, 5, 37, 13],
	[5, 109, 87, 1, 110, 88],
	[5, 65, 41, 5, 66, 42],
	[5, 54, 24, 7, 55, 25],
	[11, 36, 12],
	[5, 122, 98, 1, 123, 99],
	[7, 73, 45, 3, 74, 46],
	[15, 43, 19, 2, 44, 20],
	[3, 45, 15, 13, 46, 16],
	[1, 135, 107, 5, 136, 108],
	[10, 74, 46, 1, 75, 47],
	[1, 50, 22, 15, 51, 23],
	[2, 42, 14, 17, 43, 15],
	[5, 150, 120, 1, 151, 121],
	[9, 69, 43, 4, 70, 44],
	[17, 50, 22, 1, 51, 23],
	[2, 42, 14, 19, 43, 15],
	[3, 141, 113, 4, 142, 114],
	[3, 70, 44, 11, 71, 45],
	[17, 47, 21, 4, 48, 22],
	[9, 39, 13, 16, 40, 14],
	[3, 135, 107, 5, 136, 108],
	[3, 67, 41, 13, 68, 42],
	[15, 54, 24, 5, 55, 25],
	[15, 43, 15, 10, 44, 16],
	[4, 144, 116, 4, 145, 117],
	[17, 68, 42],
	[17, 50, 22, 6, 51, 23],
	[19, 46, 16, 6, 47, 17],
	[2, 139, 111, 7, 140, 112],
	[17, 74, 46],
	[7, 54, 24, 16, 55, 25],
	[34, 37, 13],
	[4, 151, 121, 5, 152, 122],
	[4, 75, 47, 14, 76, 48],
	[11, 54, 24, 14, 55, 25],
	[16, 45, 15, 14, 46, 16],
	[6, 147, 117, 4, 148, 118],
	[6, 73, 45, 14, 74, 46],
	[11, 54, 24, 16, 55, 25],
	[30, 46, 16, 2, 47, 17],
	[8, 132, 106, 4, 133, 107],
	[8, 75, 47, 13, 76, 48],
	[7, 54, 24, 22, 55, 25],
	[22, 45, 15, 13, 46, 16],
	[10, 142, 114, 2, 143, 115],
	[19, 74, 46, 4, 75, 47],
	[28, 50, 22, 6, 51, 23],
	[33, 46, 16, 4, 47, 17],
	[8, 152, 122, 4, 153, 123],
	[22, 73, 45, 3, 74, 46],
	[8, 53, 23, 26, 54, 24],
	[12, 45, 15, 28, 46, 16],
	[3, 147, 117, 10, 148, 118],
	[3, 73, 45, 23, 74, 46],
	[4, 54, 24, 31, 55, 25],
	[11, 45, 15, 31, 46, 16],
	[7, 146, 116, 7, 147, 117],
	[21, 73, 45, 7, 74, 46],
	[1, 53, 23, 37, 54, 24],
	[19, 45, 15, 26, 46, 16],
	[5, 145, 115, 10, 146, 116],
	[19, 75, 47, 10, 76, 48],
	[15, 54, 24, 25, 55, 25],
	[23, 45, 15, 25, 46, 16],
	[13, 145, 115, 3, 146, 116],
	[2, 74, 46, 29, 75, 47],
	[42, 54, 24, 1, 55, 25],
	[23, 45, 15, 28, 46, 16],
	[17, 145, 115],
	[10, 74, 46, 23, 75, 47],
	[10, 54, 24, 35, 55, 25],
	[19, 45, 15, 35, 46, 16],
	[17, 145, 115, 1, 146, 116],
	[14, 74, 46, 21, 75, 47],
	[29, 54, 24, 19, 55, 25],
	[11, 45, 15, 46, 46, 16],
	[13, 145, 115, 6, 146, 116],
	[14, 74, 46, 23, 75, 47],
	[44, 54, 24, 7, 55, 25],
	[59, 46, 16, 1, 47, 17],
	[12, 151, 121, 7, 152, 122],
	[12, 75, 47, 26, 76, 48],
	[39, 54, 24, 14, 55, 25],
	[22, 45, 15, 41, 46, 16],
	[6, 151, 121, 14, 152, 122],
	[6, 75, 47, 34, 76, 48],
	[46, 54, 24, 10, 55, 25],
	[2, 45, 15, 64, 46, 16],
	[17, 152, 122, 4, 153, 123],
	[29, 74, 46, 14, 75, 47],
	[49, 54, 24, 10, 55, 25],
	[24, 45, 15, 46, 46, 16],
	[4, 152, 122, 18, 153, 123],
	[13, 74, 46, 32, 75, 47],
	[48, 54, 24, 14, 55, 25],
	[42, 45, 15, 32, 46, 16],
	[20, 147, 117, 4, 148, 118],
	[40, 75, 47, 7, 76, 48],
	[43, 54, 24, 22, 55, 25],
	[10, 45, 15, 67, 46, 16],
	[19, 148, 118, 6, 149, 119],
	[18, 75, 47, 31, 76, 48],
	[34, 54, 24, 34, 55, 25],
	[20, 45, 15, 61, 46, 16]
];
QRRSBlock.getRSBlocks = function(typeNumber, errorCorrectLevel) {
	var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectLevel);
	if (rsBlock === undefined) {
		throw new Error("bad rs block @ typeNumber:" + typeNumber + "/errorCorrectLevel:" + errorCorrectLevel);
	}
	var length = rsBlock.length / 3;
	var list = [];
	for (var i = 0; i < length; i++) {
		var count = rsBlock[i * 3 + 0];
		var totalCount = rsBlock[i * 3 + 1];
		var dataCount  = rsBlock[i * 3 + 2];
		for (var j = 0; j < count; j++) {
			list.push(new QRRSBlock(totalCount, dataCount) );	
		}
	}
	return list;
};
QRRSBlock.getRsBlockTable = function(typeNumber, errorCorrectLevel) {
	switch(errorCorrectLevel) {
	case QRErrorCorrectLevel.L :
		return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
	case QRErrorCorrectLevel.M :
		return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
	case QRErrorCorrectLevel.Q :
		return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
	case QRErrorCorrectLevel.H :
		return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
	default :
		return undefined;
	}
};
module.exports = QRRSBlock;

  return module.exports; })();
  M["QRUtil"] = (() => { const module = { exports: {} }; const require = req;
var QRMode = require('./QRMode');
var QRPolynomial = require('./QRPolynomial');
var QRMath = require('./QRMath');
var QRMaskPattern = require('./QRMaskPattern');
var QRUtil = {
    PATTERN_POSITION_TABLE : [
        [],
        [6, 18],
        [6, 22],
        [6, 26],
        [6, 30],
        [6, 34],
        [6, 22, 38],
        [6, 24, 42],
        [6, 26, 46],
        [6, 28, 50],
        [6, 30, 54],        
        [6, 32, 58],
        [6, 34, 62],
        [6, 26, 46, 66],
        [6, 26, 48, 70],
        [6, 26, 50, 74],
        [6, 30, 54, 78],
        [6, 30, 56, 82],
        [6, 30, 58, 86],
        [6, 34, 62, 90],
        [6, 28, 50, 72, 94],
        [6, 26, 50, 74, 98],
        [6, 30, 54, 78, 102],
        [6, 28, 54, 80, 106],
        [6, 32, 58, 84, 110],
        [6, 30, 58, 86, 114],
        [6, 34, 62, 90, 118],
        [6, 26, 50, 74, 98, 122],
        [6, 30, 54, 78, 102, 126],
        [6, 26, 52, 78, 104, 130],
        [6, 30, 56, 82, 108, 134],
        [6, 34, 60, 86, 112, 138],
        [6, 30, 58, 86, 114, 142],
        [6, 34, 62, 90, 118, 146],
        [6, 30, 54, 78, 102, 126, 150],
        [6, 24, 50, 76, 102, 128, 154],
        [6, 28, 54, 80, 106, 132, 158],
        [6, 32, 58, 84, 110, 136, 162],
        [6, 26, 54, 82, 110, 138, 166],
        [6, 30, 58, 86, 114, 142, 170]
    ],
    G15 : (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
    G18 : (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
    G15_MASK : (1 << 14) | (1 << 12) | (1 << 10)    | (1 << 4) | (1 << 1),
    getBCHTypeInfo : function(data) {
        var d = data << 10;
        while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
            d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) ) );    
        }
        return ( (data << 10) | d) ^ QRUtil.G15_MASK;
    },
    getBCHTypeNumber : function(data) {
        var d = data << 12;
        while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
            d ^= (QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) ) );    
        }
        return (data << 12) | d;
    },
    getBCHDigit : function(data) {
        var digit = 0;
        while (data !== 0) {
            digit++;
            data >>>= 1;
        }
        return digit;
    },
    getPatternPosition : function(typeNumber) {
        return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1];
    },
    getMask : function(maskPattern, i, j) {
        switch (maskPattern) {
        case QRMaskPattern.PATTERN000 : return (i + j) % 2 === 0;
        case QRMaskPattern.PATTERN001 : return i % 2 === 0;
        case QRMaskPattern.PATTERN010 : return j % 3 === 0;
        case QRMaskPattern.PATTERN011 : return (i + j) % 3 === 0;
        case QRMaskPattern.PATTERN100 : return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 === 0;
        case QRMaskPattern.PATTERN101 : return (i * j) % 2 + (i * j) % 3 === 0;
        case QRMaskPattern.PATTERN110 : return ( (i * j) % 2 + (i * j) % 3) % 2 === 0;
        case QRMaskPattern.PATTERN111 : return ( (i * j) % 3 + (i + j) % 2) % 2 === 0;
        default :
            throw new Error("bad maskPattern:" + maskPattern);
        }
    },
    getErrorCorrectPolynomial : function(errorCorrectLength) {
        var a = new QRPolynomial([1], 0);
        for (var i = 0; i < errorCorrectLength; i++) {
            a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0) );
        }
        return a;
    },
    getLengthInBits : function(mode, type) {
        if (1 <= type && type < 10) {
            switch(mode) {
            case QRMode.MODE_NUMBER     : return 10;
            case QRMode.MODE_ALPHA_NUM  : return 9;
            case QRMode.MODE_8BIT_BYTE  : return 8;
            case QRMode.MODE_KANJI      : return 8;
            default :
                throw new Error("mode:" + mode);
            }
        } else if (type < 27) {
            switch(mode) {
            case QRMode.MODE_NUMBER     : return 12;
            case QRMode.MODE_ALPHA_NUM  : return 11;
            case QRMode.MODE_8BIT_BYTE  : return 16;
            case QRMode.MODE_KANJI      : return 10;
            default :
                throw new Error("mode:" + mode);
            }
        } else if (type < 41) {
            switch(mode) {
            case QRMode.MODE_NUMBER     : return 14;
            case QRMode.MODE_ALPHA_NUM  : return 13;
            case QRMode.MODE_8BIT_BYTE  : return 16;
            case QRMode.MODE_KANJI      : return 12;
            default :
                throw new Error("mode:" + mode);
            }
        } else {
            throw new Error("type:" + type);
        }
    },
    getLostPoint : function(qrCode) {
        var moduleCount = qrCode.getModuleCount();
        var lostPoint = 0;
        var row = 0; 
        var col = 0;
        for (row = 0; row < moduleCount; row++) {
            for (col = 0; col < moduleCount; col++) {
                var sameCount = 0;
                var dark = qrCode.isDark(row, col);
                for (var r = -1; r <= 1; r++) {
                    if (row + r < 0 || moduleCount <= row + r) {
                        continue;
                    }
                    for (var c = -1; c <= 1; c++) {
                        if (col + c < 0 || moduleCount <= col + c) {
                            continue;
                        }
                        if (r === 0 && c === 0) {
                            continue;
                        }
                        if (dark === qrCode.isDark(row + r, col + c) ) {
                            sameCount++;
                        }
                    }
                }
                if (sameCount > 5) {
                    lostPoint += (3 + sameCount - 5);
                }
            }
        }
        for (row = 0; row < moduleCount - 1; row++) {
            for (col = 0; col < moduleCount - 1; col++) {
                var count = 0;
                if (qrCode.isDark(row,     col    ) ) count++;
                if (qrCode.isDark(row + 1, col    ) ) count++;
                if (qrCode.isDark(row,     col + 1) ) count++;
                if (qrCode.isDark(row + 1, col + 1) ) count++;
                if (count === 0 || count === 4) {
                    lostPoint += 3;
                }
            }
        }
        for (row = 0; row < moduleCount; row++) {
            for (col = 0; col < moduleCount - 6; col++) {
                if (qrCode.isDark(row, col) && 
                        !qrCode.isDark(row, col + 1) && 
                         qrCode.isDark(row, col + 2) && 
                         qrCode.isDark(row, col + 3) && 
                         qrCode.isDark(row, col + 4) && 
                        !qrCode.isDark(row, col + 5) && 
                         qrCode.isDark(row, col + 6) ) {
                    lostPoint += 40;
                }
            }
        }
        for (col = 0; col < moduleCount; col++) {
            for (row = 0; row < moduleCount - 6; row++) {
                if (qrCode.isDark(row, col) &&
                        !qrCode.isDark(row + 1, col) &&
                         qrCode.isDark(row + 2, col) &&
                         qrCode.isDark(row + 3, col) &&
                         qrCode.isDark(row + 4, col) &&
                        !qrCode.isDark(row + 5, col) &&
                         qrCode.isDark(row + 6, col) ) {
                    lostPoint += 40;
                }
            }
        }
        var darkCount = 0;
        for (col = 0; col < moduleCount; col++) {
            for (row = 0; row < moduleCount; row++) {
                if (qrCode.isDark(row, col) ) {
                    darkCount++;
                }
            }
        }
        var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
        lostPoint += ratio * 10;
        return lostPoint;       
    }
};
module.exports = QRUtil;

  return module.exports; })();
  M["index"] = (() => { const module = { exports: {} }; const require = req;

var QR8bitByte = require('./QR8bitByte');
var QRUtil = require('./QRUtil');
var QRPolynomial = require('./QRPolynomial');
var QRRSBlock = require('./QRRSBlock');
var QRBitBuffer = require('./QRBitBuffer');
function QRCode(typeNumber, errorCorrectLevel) {
	this.typeNumber = typeNumber;
	this.errorCorrectLevel = errorCorrectLevel;
	this.modules = null;
	this.moduleCount = 0;
	this.dataCache = null;
	this.dataList = [];
}
QRCode.prototype = {
	addData : function(data) {
		var newData = new QR8bitByte(data);
		this.dataList.push(newData);
		this.dataCache = null;
	},
	isDark : function(row, col) {
		if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
			throw new Error(row + "," + col);
		}
		return this.modules[row][col];
	},
	getModuleCount : function() {
		return this.moduleCount;
	},
	make : function() {
		if (this.typeNumber < 1 ){
			var typeNumber = 1;
			for (typeNumber = 1; typeNumber < 40; typeNumber++) {
				var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, this.errorCorrectLevel);
				var buffer = new QRBitBuffer();
				var totalDataCount = 0;
				for (var i = 0; i < rsBlocks.length; i++) {
					totalDataCount += rsBlocks[i].dataCount;
				}
				for (var x = 0; x < this.dataList.length; x++) {
					var data = this.dataList[x];
					buffer.put(data.mode, 4);
					buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber) );
					data.write(buffer);
				}
				if (buffer.getLengthInBits() <= totalDataCount * 8)
					break;
			}
			this.typeNumber = typeNumber;
		}
		this.makeImpl(false, this.getBestMaskPattern() );
	},
	makeImpl : function(test, maskPattern) {
		this.moduleCount = this.typeNumber * 4 + 17;
		this.modules = new Array(this.moduleCount);
		for (var row = 0; row < this.moduleCount; row++) {
			this.modules[row] = new Array(this.moduleCount);
			for (var col = 0; col < this.moduleCount; col++) {
				this.modules[row][col] = null;
			}
		}
		this.setupPositionProbePattern(0, 0);
		this.setupPositionProbePattern(this.moduleCount - 7, 0);
		this.setupPositionProbePattern(0, this.moduleCount - 7);
		this.setupPositionAdjustPattern();
		this.setupTimingPattern();
		this.setupTypeInfo(test, maskPattern);
		if (this.typeNumber >= 7) {
			this.setupTypeNumber(test);
		}
		if (this.dataCache === null) {
			this.dataCache = QRCode.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
		}
		this.mapData(this.dataCache, maskPattern);
	},
	setupPositionProbePattern : function(row, col)  {
		for (var r = -1; r <= 7; r++) {
			if (row + r <= -1 || this.moduleCount <= row + r) continue;
			for (var c = -1; c <= 7; c++) {
				if (col + c <= -1 || this.moduleCount <= col + c) continue;
				if ( (0 <= r && r <= 6 && (c === 0 || c === 6) ) || 
                     (0 <= c && c <= 6 && (r === 0 || r === 6) ) || 
                     (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
					this.modules[row + r][col + c] = true;
				} else {
					this.modules[row + r][col + c] = false;
				}
			}		
		}		
	},
	getBestMaskPattern : function() {
		var minLostPoint = 0;
		var pattern = 0;
		for (var i = 0; i < 8; i++) {
			this.makeImpl(true, i);
			var lostPoint = QRUtil.getLostPoint(this);
			if (i === 0 || minLostPoint >  lostPoint) {
				minLostPoint = lostPoint;
				pattern = i;
			}
		}
		return pattern;
	},
	createMovieClip : function(target_mc, instance_name, depth) {
		var qr_mc = target_mc.createEmptyMovieClip(instance_name, depth);
		var cs = 1;
		this.make();
		for (var row = 0; row < this.modules.length; row++) {
			var y = row * cs;
			for (var col = 0; col < this.modules[row].length; col++) {
				var x = col * cs;
				var dark = this.modules[row][col];
				if (dark) {
					qr_mc.beginFill(0, 100);
					qr_mc.moveTo(x, y);
					qr_mc.lineTo(x + cs, y);
					qr_mc.lineTo(x + cs, y + cs);
					qr_mc.lineTo(x, y + cs);
					qr_mc.endFill();
				}
			}
		}
		return qr_mc;
	},
	setupTimingPattern : function() {
		for (var r = 8; r < this.moduleCount - 8; r++) {
			if (this.modules[r][6] !== null) {
				continue;
			}
			this.modules[r][6] = (r % 2 === 0);
		}
		for (var c = 8; c < this.moduleCount - 8; c++) {
			if (this.modules[6][c] !== null) {
				continue;
			}
			this.modules[6][c] = (c % 2 === 0);
		}
	},
	setupPositionAdjustPattern : function() {
		var pos = QRUtil.getPatternPosition(this.typeNumber);
		for (var i = 0; i < pos.length; i++) {
			for (var j = 0; j < pos.length; j++) {
				var row = pos[i];
				var col = pos[j];
				if (this.modules[row][col] !== null) {
					continue;
				}
				for (var r = -2; r <= 2; r++) {
					for (var c = -2; c <= 2; c++) {
						if (Math.abs(r) === 2 || 
                            Math.abs(c) === 2 ||
                            (r === 0 && c === 0) ) {
							this.modules[row + r][col + c] = true;
						} else {
							this.modules[row + r][col + c] = false;
						}
					}
				}
			}
		}
	},
	setupTypeNumber : function(test) {
		var bits = QRUtil.getBCHTypeNumber(this.typeNumber);
        var mod;
		for (var i = 0; i < 18; i++) {
			mod = (!test && ( (bits >> i) & 1) === 1);
			this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
		}
		for (var x = 0; x < 18; x++) {
			mod = (!test && ( (bits >> x) & 1) === 1);
			this.modules[x % 3 + this.moduleCount - 8 - 3][Math.floor(x / 3)] = mod;
		}
	},
	setupTypeInfo : function(test, maskPattern) {
		var data = (this.errorCorrectLevel << 3) | maskPattern;
		var bits = QRUtil.getBCHTypeInfo(data);
        var mod;
		for (var v = 0; v < 15; v++) {
			mod = (!test && ( (bits >> v) & 1) === 1);
			if (v < 6) {
				this.modules[v][8] = mod;
			} else if (v < 8) {
				this.modules[v + 1][8] = mod;
			} else {
				this.modules[this.moduleCount - 15 + v][8] = mod;
			}
		}
		for (var h = 0; h < 15; h++) {
			mod = (!test && ( (bits >> h) & 1) === 1);
			if (h < 8) {
				this.modules[8][this.moduleCount - h - 1] = mod;
			} else if (h < 9) {
				this.modules[8][15 - h - 1 + 1] = mod;
			} else {
				this.modules[8][15 - h - 1] = mod;
			}
		}
		this.modules[this.moduleCount - 8][8] = (!test);
	},
	mapData : function(data, maskPattern) {
		var inc = -1;
		var row = this.moduleCount - 1;
		var bitIndex = 7;
		var byteIndex = 0;
		for (var col = this.moduleCount - 1; col > 0; col -= 2) {
			if (col === 6) col--;
			while (true) {
				for (var c = 0; c < 2; c++) {
					if (this.modules[row][col - c] === null) {
						var dark = false;
						if (byteIndex < data.length) {
							dark = ( ( (data[byteIndex] >>> bitIndex) & 1) === 1);
						}
						var mask = QRUtil.getMask(maskPattern, row, col - c);
						if (mask) {
							dark = !dark;
						}
						this.modules[row][col - c] = dark;
						bitIndex--;
						if (bitIndex === -1) {
							byteIndex++;
							bitIndex = 7;
						}
					}
				}
				row += inc;
				if (row < 0 || this.moduleCount <= row) {
					row -= inc;
					inc = -inc;
					break;
				}
			}
		}
	}
};
QRCode.PAD0 = 0xEC;
QRCode.PAD1 = 0x11;
QRCode.createData = function(typeNumber, errorCorrectLevel, dataList) {
	var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel);
	var buffer = new QRBitBuffer();
	for (var i = 0; i < dataList.length; i++) {
		var data = dataList[i];
		buffer.put(data.mode, 4);
		buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber) );
		data.write(buffer);
	}
	var totalDataCount = 0;
	for (var x = 0; x < rsBlocks.length; x++) {
		totalDataCount += rsBlocks[x].dataCount;
	}
	if (buffer.getLengthInBits() > totalDataCount * 8) {
		throw new Error("code length overflow. (" + 
            buffer.getLengthInBits() + 
            ">" +  
            totalDataCount * 8 + 
            ")");
	}
	if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
		buffer.put(0, 4);
	}
	while (buffer.getLengthInBits() % 8 !== 0) {
		buffer.putBit(false);
	}
	while (true) {
		if (buffer.getLengthInBits() >= totalDataCount * 8) {
			break;
		}
		buffer.put(QRCode.PAD0, 8);
		if (buffer.getLengthInBits() >= totalDataCount * 8) {
			break;
		}
		buffer.put(QRCode.PAD1, 8);
	}
	return QRCode.createBytes(buffer, rsBlocks);
};
QRCode.createBytes = function(buffer, rsBlocks) {
	var offset = 0;
	var maxDcCount = 0;
	var maxEcCount = 0;
	var dcdata = new Array(rsBlocks.length);
	var ecdata = new Array(rsBlocks.length);
	for (var r = 0; r < rsBlocks.length; r++) {
		var dcCount = rsBlocks[r].dataCount;
		var ecCount = rsBlocks[r].totalCount - dcCount;
		maxDcCount = Math.max(maxDcCount, dcCount);
		maxEcCount = Math.max(maxEcCount, ecCount);
		dcdata[r] = new Array(dcCount);
		for (var i = 0; i < dcdata[r].length; i++) {
			dcdata[r][i] = 0xff & buffer.buffer[i + offset];
		}
		offset += dcCount;
		var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
		var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
		var modPoly = rawPoly.mod(rsPoly);
		ecdata[r] = new Array(rsPoly.getLength() - 1);
		for (var x = 0; x < ecdata[r].length; x++) {
            var modIndex = x + modPoly.getLength() - ecdata[r].length;
			ecdata[r][x] = (modIndex >= 0)? modPoly.get(modIndex) : 0;
		}
	}
	var totalCodeCount = 0;
	for (var y = 0; y < rsBlocks.length; y++) {
		totalCodeCount += rsBlocks[y].totalCount;
	}
	var data = new Array(totalCodeCount);
	var index = 0;
	for (var z = 0; z < maxDcCount; z++) {
		for (var s = 0; s < rsBlocks.length; s++) {
			if (z < dcdata[s].length) {
				data[index++] = dcdata[s][z];
			}
		}
	}
	for (var xx = 0; xx < maxEcCount; xx++) {
		for (var t = 0; t < rsBlocks.length; t++) {
			if (xx < ecdata[t].length) {
				data[index++] = ecdata[t][xx];
			}
		}
	}
	return data;
};
module.exports = QRCode;

  return module.exports; })();
  return M.index;
})();

/** QR en SVG (para escanear con el movil) */
function qrSvg(text) {
  const q = new QRCodeLib(-1, 0); // nivel M
  q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
/** Aviso privado por Telegram a un usuario del panel (si lo tiene enlazado) */
function notifyUser(u, text) {
  const cfg = db.settings.notices.telegram;
  if (!u || !u.tgChat || !cfg.token) return Promise.resolve(false);
  return tg('sendMessage', { chat_id: u.tgChat, text, disable_web_page_preview: true }).then(() => true).catch((e) => { console.error('Telegram (aviso privado):', e.message); return false; });
}
/** Aviso al superadministrador (y a los administradores que lo pidan) */
function notifyStaff(kind, text) {
  for (const u of db.users) {
    if (u.disabled || !u.tgChat) continue;
    const pref = (u.secAlerts || {})[kind];
    if (u.role === 'super' ? pref !== false : (u.role === 'admin' && pref === true && (kind !== 'servers' || can(u, 'viewServers')) && (kind !== 'quality' || can(u, 'servers')) && (kind !== 'sabotage' || can(u, 'resellers')))) notifyUser(u, text);
  }
}
const whenTxt = () => new Date().toLocaleString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function userTgCode(u) { return `u${u.id}_${crypto.createHmac('sha256', db.secret).update('tgu' + u.id).digest('hex').slice(0, 10)}`; }
/* Intentos fallidos por IP: 10 en 15 minutos bloquean esa IP 15 minutos */
const ipFails = new Map(); // ip -> { n, first, until }
function ipBlocked(ip) { const f = ipFails.get(ip); return !!f && f.until > Date.now(); }
function ipFail(ip) {
  const now = Date.now();
  let f = ipFails.get(ip);
  if (!f || now - f.first > 15 * 60000) f = { n: 0, first: now, until: 0 };
  f.n++;
  if (f.n >= 10) { f.until = now + 15 * 60000; f.n = 0; f.first = now; }
  ipFails.set(ip, f);
  if (ipFails.size > 5000) ipFails.delete(ipFails.keys().next().value);
  return f.until > now;
}
/* Paso 2 del login: billete de 5 minutos entre la contraseña y el codigo */
const tickets = new Map(); // ticket -> { userId, exp, tries, ip }

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
  if (cost > 0) debtGate(me);
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
  id: u.id, username: u.username, name: u.name, role: u.role, mustPw: !!u.mustPw, parentId: u.parentId, credits: u.credits, disabled: !!u.disabled, offBy: u.offBy || null, offAt: u.offAt || null, createdAt: u.createdAt,
  lastLogin: u.lastLogin || null, lastSeen: u.lastSeen || null, renew: u.role === 'reseller' || u.role === 'sub' ? renewRate([u.id]) : null, debt: u.role === 'reseller' || u.role === 'sub' ? debtOf(u).amount : 0,
  creditPrice: u.creditPrice || 0, allowNegative: !!u.allowNegative, allowDemos: u.allowDemos !== false, serverIds: u.serverIds || [],
  canCreateSubs: u.canCreateSubs !== false, subCost: u.subCost || 0,
  twoFa: !!(u.totp && u.totp.on), tgLinked: !!u.tgChat,
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
function assertServerAllowed(u, s) { if (s.off) throw new HttpError(400, `El servidor "${s.name}" está pausado: no admite cuentas nuevas ahora mismo.`); if (!serverAllowed(u, s)) throw new HttpError(403, `No tienes permiso para crear cuentas en "${s.name}".`); }
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
    licMaster: me.role === 'super' && !LIC_CLIENT,
    licDue: me.role === 'super' && !LIC_CLIENT ? (db.licenses || []).filter((l) => !l.blocked && diffDays(l.until, today()) <= 7).length : 0,
    license: me.role === 'super' ? licStatus() : null,
    settings: { ...db.settings, notices: { ...db.settings.notices, telegram: { on: db.settings.notices.telegram.on, bot: db.settings.notices.telegram.bot, hasToken: !!db.settings.notices.telegram.token } } },
    servers: db.servers.map((s) => (seeServers
      ? { id: s.id, name: s.name, usable: !s.off, off: !!s.off, publicUrl: s.publicUrl || '', url: s.url, packages: s.packages || {}, keyLost: !!s.keyLost, ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') } }
      : { id: s.id, name: s.name, usable: serverAllowed(me, s) && !s.off, publicUrl: s.publicUrl || '', ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') } })),
    users, stats: seeClients ? stats : { today: Object.fromEntries(Object.keys(stats.today).map((k) => [k, [0, 0]])), month: Object.fromEntries(Object.keys(stats.month).map((k) => [k, [0, 0]])), days: stats.days.map((x) => ({ d: x.d, alta: 0, renovacion: 0 })) },
    clients: db.clients.filter((c) => seeClients && (!vis || vis.has(c.ownerId))).map((c) => ({ ...c, tgChat: undefined, tgLinked: !!c.tgChat, tgCode: tgCode(c) })),
    log: db.log.filter((l) => l.type !== 'login' && seeClients && (!vis ? true : (l.ownerId != null && vis.has(l.ownerId)) || l.actorId === me.id)).slice(0, 500),
    ledger: db.ledger.filter((l) => (adm && !P.reports ? l.userId === me.id : !vis || vis.has(l.userId))).slice(0, 500),
    lastRun: db.lastRun,
    alertsUnread: !seeClients ? 0 : db.alerts.reduce((n, a) => n + (!a.read && (!vis || vis.has(a.ownerId)) ? 1 : 0), 0),
    followPending: !seeClients ? 0 : db.followups.filter((f) => f.status === 'pending' && (!vis || vis.has(f.ownerId))).length,
    sharedCount: !seeClients ? 0 : sharedCount(vis),
    sharedIds: !seeClients ? [] : ((shareCache.get(vis ? [...vis].sort().join(',') : 'all') || {}).ids || []),
    renewals: !seeClients ? {} : (() => { const m = {}; for (const l of db.log) if (l.type === 'renovacion' && l.clientId != null && /^Renovada/.test(l.text)) m[l.clientId] = (m[l.clientId] || 0) + 1; return m; })(),
    teamCount: teamCount(me),
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

route('GET', '/api/state', null, ({ req }) => ({ needsSetup: !db.users.length, authed: !!currentUser(req), brand: db.settings.brand, support: db.settings.support, license: licStatus() }));
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

/* Pregunta de sumas y restas para entrar: un solo uso y caduca a los 10 minutos */
const captchas = new Map(); // id -> { answer, exp }
function newCaptcha() {
  const now = Date.now();
  for (const [k, v] of captchas) if (v.exp < now) captchas.delete(k);
  while (captchas.size > 20000) captchas.delete(captchas.keys().next().value);
  const r = (a, b) => a + crypto.randomInt(b - a + 1);
  const kind = crypto.randomInt(3);
  let q, answer;
  if (kind === 0) { const a = r(2, 20), b = r(2, 20); q = `${a} + ${b}`; answer = a + b; }
  else if (kind === 1) { const a = r(6, 25), b = r(1, a - 1); q = `${a} - ${b}`; answer = a - b; }
  else { const a = r(2, 9), b = r(2, 9); q = `${a} × ${b}`; answer = a * b; }
  const id = crypto.randomBytes(12).toString('hex');
  captchas.set(id, { answer, exp: now + 10 * 60000 });
  return { id, q };
}
function checkCaptcha(body) {
  const id = String(body.captchaId || '');
  const c = captchas.get(id);
  captchas.delete(id); // cada pregunta sirve para un solo intento
  if (!c || c.exp < Date.now()) throw new HttpError(400, 'La pregunta de seguridad ha caducado. Responde la nueva.');
  if (String(body.captchaAnswer == null ? '' : body.captchaAnswer).trim() !== String(c.answer)) throw new HttpError(400, 'La respuesta de la operación no es correcta. Prueba con la nueva pregunta.');
}
route('GET', '/api/captcha', null, () => newCaptcha());

route('POST', '/api/setup', null, ({ req, body, res }) => {
  if (db.users.length) throw new HttpError(400, 'El panel ya está configurado.');
  checkCaptcha(body);
  const u = { id: newId(), username: readUsername(body.username), name: 'Superadministrador', role: 'super', parentId: null, credits: 0, disabled: false, createdAt: today() };
  setPassword(u, readNewPassword(body.password));
  db.users.push(u);
  saveDb();
  startSession(res, u, isHttps(req), req);
  return { ok: true };
});

route('POST', '/api/login', null, async ({ req, body, res }) => {
  const username = str(body.username, 30).toLowerCase(), ip = clientIp(req);
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos desde tu conexión. Espera 15 minutos.');
  const f = loginFails.get(username) || { count: 0, until: 0, total: 0 };
  if (f.until > Date.now()) throw new HttpError(429, 'Demasiados intentos. Espera un minuto.');
  checkCaptcha(body);
  const u = db.users.find((x) => x.username === username);
  const pwOk = !!u && checkPassword(u, typeof body.password === 'string' ? body.password : '');
  // Contraseña buena pero acceso desactivado: se le dice claro (solo quien sabe la contraseña lo ve)
  if (pwOk && u.disabled) { addAccess(u, 'bloqueado', req); throw new HttpError(403, 'Tu acceso al panel está desactivado. Habla con quien te dio de alta.'); }
  const ok = pwOk;
  if (!ok) {
    addAccess(u || null, 'fallido', req, { typed: username });
    await new Promise((r) => setTimeout(r, 600));
    f.count++; f.total = (f.total || 0) + 1;
    if (f.count >= 5) { f.count = 0; f.until = Date.now() + 60000; }
    loginFails.set(username, f);
    const blocked = ipFail(ip);
    if (u && (f.total === 3 || f.total % 10 === 0)) {
      notifyUser(u, `⚠️ ${f.total} intentos fallidos de entrar en tu cuenta «${u.username}» del panel ${db.settings.brand.name || 'Concha'}.\nIP: ${ip}\nAparato: ${uaShort(req.headers['user-agent'])}\n${whenTxt()}\n\nSi no has sido tú, no hace falta que hagas nada: la contraseña sigue protegida. Si te preocupa, cámbiala.`);
      lock(async () => { addLog('seguridad', null, `${f.total} intentos fallidos para ${u.username} (IP ${ip})`, null); saveDb(); }).catch(() => {});
    }
    if (blocked) throw new HttpError(429, 'Demasiados intentos desde tu conexión. Espera 15 minutos.');
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  }
  loginFails.delete(username);
  // Con verificacion en dos pasos: primero la contraseña, luego el codigo del movil
  if (u.totp && u.totp.on) {
    for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('hex');
    tickets.set(ticket, { userId: u.id, exp: Date.now() + 5 * 60000, tries: 0, ip });
    return { need2fa: true, ticket };
  }
  finishLogin(req, res, u, false);
  return { ok: true };
});
/* Historial de accesos: aparte del registro de actividad, para que no se pierda entre otros apuntes.
   Se guardan hasta 20.000 accesos o 400 días. Va dentro de las copias de seguridad. */
const ACCESS_KIND = { entrada: 'Entrada', fallido: 'Contraseña incorrecta', fallido2fa: 'Código de verificación incorrecto', bloqueado: 'Intento con el acceso desactivado', salida: 'Salida' };
function addAccess(u, kind, req, extra) {
  const e = { ts: new Date().toISOString(), kind, userId: u ? u.id : null, user: u ? u.username : String((extra && extra.typed) || '').slice(0, 40), name: u ? u.name : '', role: u ? u.role : '',
    ip: clientIp(req), dev: uaShort(req.headers['user-agent']), ...(extra && extra.via2fa ? { via2fa: true } : {}) };
  lock(async () => {
    db.access.unshift(e);
    const limit = Date.now() - 400 * 86400000;
    if (db.access.length > 20000) db.access.length = 20000;
    while (db.access.length && Date.parse(db.access[db.access.length - 1].ts) < limit) db.access.pop();
    saveDb();
  }).catch(() => {});
}
/** Entrada correcta: abre la sesion, la apunta y avisa por Telegram */
function finishLogin(req, res, u, via2fa) {
  u.lastLogin = { at: new Date().toISOString(), ip: clientIp(req), dev: uaShort(req.headers['user-agent']), via2fa: !!via2fa };
  u.lastSeen = u.lastLogin.at;
  addAccess(u, 'entrada', req, { via2fa });
  startSession(res, u, isHttps(req), req);
  const ip = clientIp(req), dev = uaShort(req.headers['user-agent']);
  // No se espera a la cola de guardado: si una revisión con Emby está en marcha, entrar no debe quedarse esperando
  lock(async () => { addLog('login', null, `Inicio de sesión de ${u.name} (${u.username})${via2fa ? ' con verificación en dos pasos' : ''} · ${dev} · IP ${ip}`, u); saveDb(); }).catch(() => {});
  const al = u.secAlerts || {};
  if (al.login !== false) notifyUser(u, `🔐 Nuevo inicio de sesión en tu cuenta «${u.username}» del panel ${db.settings.brand.name || 'Concha'}.\n${dev}\nIP: ${ip}\n${whenTxt()}\n\nSi no has sido tú, entra en Ajustes › Seguridad, pulsa «Cerrar las demás sesiones» y cambia la contraseña.`);
  if (u.role === 'admin') notifyStaff('staffLogins', `👤 El administrador ${u.name} (${u.username}) ha entrado en el panel.\n${dev} · IP ${ip}\n${whenTxt()}`);
}
route('POST', '/api/login/2fa', null, async ({ req, body, res }) => {
  const ip = clientIp(req);
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos desde tu conexión. Espera 15 minutos.');
  const t = tickets.get(String(body.ticket || ''));
  if (!t || t.exp < Date.now()) throw new HttpError(400, 'Ha pasado demasiado tiempo. Vuelve a escribir la contraseña.');
  const u = db.users.find((x) => x.id === t.userId);
  if (!u || u.disabled || !u.totp || !u.totp.on) { tickets.delete(body.ticket); throw new HttpError(400, 'Vuelve a escribir la contraseña.'); }
  const code = String(body.code || '').trim();
  let ok = false, rescue = false;
  await lock(async () => {
    ok = checkTotp(u.totp, code);
    if (!ok && /[A-Za-z]/.test(code) && useRecoveryCode(u, code)) { ok = true; rescue = true; }
    if (ok) saveDb();
  });
  if (!ok) {
    t.tries++; ipFail(ip);
    addAccess(u, 'fallido2fa', req);
    if (t.tries >= 5) { tickets.delete(body.ticket); notifyUser(u, `⚠️ Alguien ha escrito bien tu contraseña pero ha fallado 5 veces el código de verificación.\nIP: ${ip}\n${whenTxt()}\n\nCambia tu contraseña cuanto antes.`); throw new HttpError(400, 'Demasiados códigos incorrectos. Vuelve a empezar.'); }
    throw new HttpError(400, 'El código no es correcto. Mira el que sale ahora en tu app de verificación.');
  }
  tickets.delete(body.ticket);
  finishLogin(req, res, u, true);
  if (rescue) {
    lock(async () => { addLog('seguridad', null, `${u.username} entró con un código de rescate (le quedan ${u.totp.codes.length})`, u); saveDb(); }).catch(() => {});
    notifyUser(u, `🛟 Has entrado con un código de rescate. Te quedan ${u.totp.codes.length}. Si has perdido el móvil, vuelve a configurar la verificación en dos pasos.`);
  }
  return { ok: true, rescue, left: rescue ? u.totp.codes.length : undefined };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const tok = sessionToken(req);
  const sv = tok && sessions.get(tok), su = sv && db.users.find((x) => x.id === sv.userId);
  if (su) addAccess(su, 'salida', req);
  if (tok) sessions.delete(tok);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});

route('POST', '/api/my-password', '*', ({ me, body, req }) => {
  if (!checkPassword(me, typeof body.current === 'string' ? body.current : '')) throw new HttpError(400, 'La contraseña actual no es correcta.');
  if (typeof body.next === 'string' && body.next === body.current) throw new HttpError(400, 'La contraseña nueva tiene que ser distinta de la que te dieron.');
  setPassword(me, readNewPassword(body.next));
  delete me.mustPw;
  dropSessions(me.id, sessionToken(req)); // con la contraseña nueva se cierran las demás sesiones
  addLog('seguridad', null, `${me.username} cambió su contraseña (se cerraron sus otras sesiones)`, me);
  saveDb();
  notifyUser(me, `🔑 Se ha cambiado la contraseña de tu cuenta «${me.username}».
${whenTxt()}
Si no has sido tú, avisa al superadministrador.`);
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
/* Historial de accesos. El superadministrador lo ve todo (también los intentos con usuarios que no existen).
   Un administrador ve los de resellers y subresellers y los suyos; un reseller, los suyos y los de sus subresellers. */
route('GET', '/api/access', ['super', 'admin', 'reseller'], ({ me }) => {
  let ok;
  if (me.role === 'super') ok = () => true;
  else if (me.role === 'admin') ok = (e) => e.userId === me.id || e.role === 'reseller' || e.role === 'sub';
  else { const mine = new Set([me.id, ...db.users.filter((u) => u.parentId === me.id).map((u) => u.id)]); ok = (e) => mine.has(e.userId); }
  return { access: db.access.filter(ok).slice(0, 5000), total: db.access.length };
});

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
  // Tambien con los avisos a clientes apagados: el bot sirve para los avisos de seguridad del equipo
  if (!cfg.token || tgBusy) return;
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
        const um = /^(?:\/start\s+)?(u(\d+)_[0-9a-f]{10})$/i.exec(text); // con /start o pegando solo el codigo
        if (/^\/stop\b/i.test(text)) {
          let n = 0;
          for (const c of db.clients) if (c.tgChat === chat) { delete c.tgChat; n++; }
          for (const x of db.users) if (x.tgChat === chat) { delete x.tgChat; n++; }
          reply = n ? 'Hecho. Ya no te enviaré más avisos.' : 'No tenías avisos activados.';
        } else if (um) {
          const pu = db.users.find((x) => x.id === Number(um[2]));
          if (pu && !pu.disabled && userTgCode(pu) === um[1].toLowerCase()) {
            pu.tgChat = chat;
            addLog('seguridad', null, `${pu.username} enlazó su Telegram para los avisos de seguridad`, pu);
            reply = `Listo, ${pu.name}. Aquí te avisaré de cada entrada en tu cuenta del panel${pu.role === 'super' ? ', de los servidores que se caigan y de las copias de seguridad' : ''}. Escribe /stop para dejar de recibirlos.`;
          } else reply = 'Ese enlace no es válido. Cógelo de nuevo en el panel, en Ajustes › Seguridad.';
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
route('POST', '/api/clients/:id/guide', '*', async ({ me, params, body }) => {
  const c = clientFor(me, params.id), cfg = db.settings.notices.telegram;
  if (!c.tgChat) throw new HttpError(400, 'Este cliente no tiene Telegram enlazado. Mándasela por WhatsApp o cópiala.');
  if (!cfg.token) throw new HttpError(400, 'El bot de Telegram no está configurado.');
  const custom = typeof body.text === 'string' ? body.text.trim().slice(0, 1500) : '';
  await tg('sendMessage', { chat_id: c.tgChat, text: custom || fillText(db.settings.templates.quality || DEFAULT_TEMPLATES.quality, c) });
  await lock(async () => { addLog('aviso', c, custom ? `Mensaje enviado por Telegram: ${custom.slice(0, 80)}` : 'Guía de calidad enviada por Telegram', me); saveDb(); });
  return { ok: true };
});
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
  if (info && info.Id) s.embyServerId = String(info.Id).slice(0, 64);
  s.id = newId();
  db.servers.push(s);
  addLog('servidor', null, `Servidor "${s.name}" conectado (Emby ${info && info.Version ? info.Version : '?'})`, me);
  saveDb();
  return { ok: true, id: s.id };
}));
route('PUT', '/api/servers/:id', SUPER, ({ params, body }) => lock(async () => {
  const s = serverById(params.id);
  const next = { ...s, name: str(body.name, 60) || s.name, url: cleanUrl(body.url), publicUrl: body.publicUrl === undefined ? (s.publicUrl || '') : str(body.publicUrl, 200), apiKey: str(body.apiKey, 200) || s.apiKey };
  const info = await emby(next, 'GET', '/System/Info');
  const newId_ = info && info.Id ? String(info.Id).slice(0, 64) : '';
  // Si la nueva direccion es OTRO servidor Emby, se avisa: las cuentas del panel no existirian alli
  if (s.embyServerId && newId_ && newId_ !== s.embyServerId && !body.confirmOther) throw new HttpError(409, `Esa dirección lleva a otro servidor Emby («${info.ServerName || '?'}»), no al que tenías. Si es correcto, confírmalo.`);
  if (newId_) next.embyServerId = newId_;
  delete next.keyLost; delete next.lostEnc;
  Object.assign(s, next);
  if (s.apiKey) { delete s.keyLost; delete s.lostEnc; }
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
  const s = serverById(params.id);
  const info = await emby(s, 'GET', '/System/Info');
  const same = !s.embyServerId || !info.Id || String(info.Id) === s.embyServerId;
  if (!s.embyServerId && info.Id) await lock(async () => { s.embyServerId = String(info.Id).slice(0, 64); saveDb(); });
  return { ok: true, name: info.ServerName, version: info.Version, same };
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

/* Ficha de un servidor: datos de Emby, bibliotecas con cuántos títulos tienen, escaneo y cuentas */
route('GET', '/api/servers/:id/details', STAFF, async ({ params }) => {
  const s = serverById(params.id), t0 = Date.now();
  const out = { id: s.id, name: s.name, off: !!s.off, online: false, ms: 0, info: null, libraries: [], scan: null, emby: null, error: '' };
  try {
    const info = await emby(s, 'GET', '/System/Info');
    out.online = true; out.ms = Date.now() - t0;
    out.info = { name: info.ServerName || '', version: info.Version || '', os: info.OperatingSystemDisplayName || info.OperatingSystem || '', update: !!info.HasUpdateAvailable, pendingRestart: !!info.HasPendingRestart };
  } catch (e) { out.error = e.message; return out; }
  const pk = s.packages || {}, inPk = (k, id) => !!pk[k] && (pk[k].all || (pk[k].folders || []).includes(id));
  const [vf, tasks, users] = await Promise.all([
    emby(s, 'GET', '/Library/VirtualFolders').catch(() => null),
    emby(s, 'GET', '/ScheduledTasks?IsHidden=false').catch(() => null),
    emby(s, 'GET', '/Users').catch(() => null),
  ]);
  const libs = Array.isArray(vf) ? vf.map((f) => ({ id: String(f.Guid || f.ItemId || f.Id || ''), item: String(f.ItemId || f.Id || ''), name: f.Name, type: f.CollectionType || '', paths: (f.Locations || []).length, refreshing: f.RefreshStatus === 'Active', progress: f.RefreshProgress != null ? Math.round(f.RefreshProgress) : null }))
    : (await embyLibraries(s).catch(() => [])).map((l) => ({ ...l, item: l.id, type: '', paths: 0 }));
  await Promise.all(libs.map(async (l) => {
    l.basico = inPk('basico', l.id); l.k4 = inPk('k4', l.id);
    if (!l.item) return;
    try { const r = await emby(s, 'GET', `/Items?ParentId=${encodeURIComponent(l.item)}&Recursive=true&IncludeItemTypes=Movie,Series,MusicAlbum,Audio,Video&Limit=0`); l.count = r && typeof r.TotalRecordCount === 'number' ? r.TotalRecordCount : null; } catch { l.count = null; }
  }));
  out.libraries = libs;
  const task = Array.isArray(tasks) ? tasks.find((x) => x.Key === 'RefreshLibrary') || tasks.find((x) => /scan media library|escanear/i.test(x.Name || '')) : null;
  if (task) {
    const last = task.LastExecutionResult || {};
    out.scan = { running: task.State === 'Running', progress: task.CurrentProgressPercentage != null ? Math.round(task.CurrentProgressPercentage) : null, last: last.EndTimeUtc || null, status: last.Status || '' };
  }
  if (Array.isArray(users)) {
    const known = new Set(db.clients.filter((c) => c.serverId === s.id).map((c) => c.embyId));
    const normal = users.filter((u) => !(u.Policy && u.Policy.IsAdministrator));
    out.emby = { users: normal.length, admins: users.length - normal.length, notInPanel: normal.filter((u) => !known.has(u.Id)).length };
  }
  return out;
});
/* Escanear bibliotecas: todas, o solo una */
route('POST', '/api/servers/:id/scan', STAFF, async ({ me, params, body }) => {
  const s = serverById(params.id), lib = str(body.item, 80);
  if (lib) {
    if (!/^[\w-]+$/.test(lib)) throw new HttpError(400, 'Biblioteca no válida.');
    await emby(s, 'POST', `/Items/${lib}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false`);
  } else await emby(s, 'POST', '/Library/Refresh');
  await lock(async () => { addLog('servidor', null, `Escaneo de ${lib ? 'la biblioteca «' + str(body.name, 60) + '»' : 'todas las bibliotecas'} en "${s.name}"`, me); saveDb(); });
  return { ok: true };
});
/* Pausar un servidor: sigue funcionando para quien ya tiene cuenta, pero no se crean cuentas nuevas en él */
route('POST', '/api/servers/:id/pause', STAFF, ({ me, params, body }) => lock(async () => {
  const s = serverById(params.id), off = !!body.off;
  if (!!s.off === off) return { ok: true };
  if (off) s.off = new Date().toISOString(); else delete s.off;
  addLog('servidor', null, off ? `Servidor "${s.name}" pausado: no se crean cuentas nuevas en él` : `Servidor "${s.name}" activo otra vez para cuentas nuevas`, me);
  saveDb();
  return { ok: true };
}));
/* Volver a crear en Emby las cuentas del panel (tras reinstalar el servidor o cambiar la API key). Va por detrás, cuenta a cuenta */
const reimports = new Map();
route('GET', '/api/servers/:id/reimport', STAFF, ({ params }) => ({ job: reimports.get(serverById(params.id).id) || null }));
route('POST', '/api/servers/:id/reimport', STAFF, async ({ me, params, body }) => {
  const s = serverById(params.id);
  if (!checkPassword(me, String(body.password || ''))) throw new HttpError(403, 'La contraseña no es correcta.');
  const cur = reimports.get(s.id);
  if (cur && !cur.done) throw new HttpError(409, 'Ya se está haciendo. Espera a que termine.');
  await emby(s, 'GET', '/System/Info');
  const ids = db.clients.filter((c) => c.serverId === s.id && c.status !== 'trash').map((c) => c.id);
  const job = { total: ids.length, n: 0, ok: 0, recreated: 0, failed: 0, errors: [], done: false, at: new Date().toISOString(), by: me.name };
  reimports.set(s.id, job);
  (async () => {
    for (const id of ids) {
      await lock(async () => {
        const c = db.clients.find((x) => x.id === id);
        if (!c || c.serverId !== s.id || c.status === 'trash') return;
        try { const r = await repairClient(me, c); job.ok++; if (r.recreated) job.recreated++; }
        catch (e) { job.failed++; if (job.errors.length < 30) job.errors.push(`${c.embyName}: ${e.message}`); }
        saveDb();
      }).catch(() => {});
      job.n++;
    }
    job.done = true;
    await lock(async () => { addLog('servidor', null, `Re-importación en "${s.name}": ${job.ok} correctas (${job.recreated} creadas de nuevo), ${job.failed} con error`, me); saveDb(); }).catch(() => {});
    notifyStaff('servers', `🔁 Re-importación en ${s.name} terminada: ${job.ok} bien, ${job.recreated} creadas de nuevo, ${job.failed} con error.`);
  })();
  return { ok: true, total: ids.length };
});

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
  const dry = !!body.dry, create = !!body.create, fixOwner = !!body.fixOwner;
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
      const have = db.clients.find((c) => c.serverId === s.id && ((eu && c.embyId === eu.Id) || c.embyName.toLowerCase() === embyName.toLowerCase()));
      if (have) {
        if (fixOwner && namedOwner && have.ownerId !== namedOwner.id) {
          const was = (db.users.find((u) => u.id === have.ownerId) || {}).name || '?';
          if (dry) { res.status = 'ok'; res.text = `Ya está en el panel: pasará de ${was} a ${namedOwner.name}`; continue; }
          have.ownerId = namedOwner.id;
          addLog('edicion', have, `Vendedor corregido al importar: de ${was} a ${namedOwner.name}`, me);
          res.status = 'ok'; res.text = `Vendedor corregido: de ${was} a ${namedOwner.name}`; done++; continue;
        }
        res.status = 'skip'; res.text = fixOwner && namedOwner ? `Ya está en el panel y ya es de ${namedOwner.name}` : 'Ya está en el panel'; continue;
      }
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
  if (cost > 0) c.charges = [{ ts: new Date().toISOString(), userId: me.id, credits: cost, from: c.createdAt, to: c.expires, kind: 'alta' }];
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
  const before = { expires: c.expires, status: c.status, screens: c.screens, quality: c.quality, demo: c.demo, expiresAt: c.expiresAt, off: c.off };
  c.expires = addMonths(base, plan.months);
  c.screens = plan.screens; c.quality = plan.quality; c.demo = false; delete c.expiresAt; delete c.off; delete c.offBy; // renovar la vuelve a activar
  try { await grantAccess(c); }
  catch (e) { Object.assign(c, before); if (before.expiresAt === undefined) delete c.expiresAt; if (before.off === undefined) delete c.off; throw e; }
  c.status = 'active';
  c.paid = body.paid !== false;
  delete c.trashedAt; delete c.trashReason; delete c.lastError;
  const what = `${plan.months} ${plan.months === 1 ? 'mes' : 'meses'}, ${plan.screens} ${plan.screens === 1 ? 'pantalla' : 'pantallas'}${plan.quality ? ', ' + QUALITIES[plan.quality] : ''}`;
  spend(me, cost, `${before.demo ? 'Alta desde demo' : 'Renovación'} de ${c.embyName} (${what})`);
  if (before.demo) for (const f of db.followups) if (f.clientId === c.id && f.status === 'pending') { f.status = 'bought'; f.doneAt = new Date().toISOString(); }
  if (cost > 0) { c.charges = [...(c.charges || []), { ts: new Date().toISOString(), userId: me.id, credits: cost, from: base, to: c.expires, kind: before.demo ? 'alta' : 'renovacion' }].slice(-24); }
  if (!before.demo) addChurn(c.ownerId, 'ren');
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

/* Desactivar sin borrar: se queda en su lista, sin acceso en Emby, hasta que la actives o la renueves */
async function setOff(me, c, off) {
  if (c.status === 'trash') throw new HttpError(400, 'Está en la papelera. Restáurala o renuévala desde allí.');
  if (!!c.off === off) return false;
  if (off) {
    c.off = new Date().toISOString();
    try { await removeAccess(c, true); } catch (e) { delete c.off; throw e; }
    addLog('desactivada', c, 'Desactivada: sin acceso en Emby hasta que se vuelva a activar', me);
  } else {
    const was = c.off; delete c.off; delete c.offBy;
    try { await applyState(c); } catch (e) { c.off = was; throw e; }
    const valid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
    addLog('activada', c, valid ? 'Activada de nuevo: vuelve a tener acceso en Emby' : 'Activada de nuevo, pero está vencida: renuévala para que tenga acceso', me);
  }
  return true;
}
route('POST', '/api/clients/:id/off', '*', ({ me, params }) => lock(async () => { await setOff(me, clientFor(me, params.id), true); saveDb(); return { ok: true }; }));
route('POST', '/api/clients/:id/on', '*', ({ me, params }) => lock(async () => { await setOff(me, clientFor(me, params.id), false); saveDb(); return { ok: true }; }));
route('POST', '/api/clients/:id/restore', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.status !== 'trash') return { ok: true };
  if (c.demo) throw new HttpError(400, 'Las demos no se restauran. Renuévala para convertirla en cuenta.');
  if (diffDays(c.expires, today()) < 0) throw new HttpError(400, 'Su suscripción ya venció. Renuévala para sacarla de la papelera.');
  const wasOff = c.off; delete c.off; delete c.offBy;
  try { await grantAccess(c); } catch (e) { if (wasOff) c.off = wasOff; throw e; }
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

/* ---------- Eliminar una cuenta devolviendo los créditos ----------
 * Regla: lo pagado en las últimas 24 horas se devuelve entero; de lo demás, la parte del tiempo que no se ha usado.
 * Cada crédito vuelve a quien lo pagó. */
const REFUND_FULL_MS = 24 * 3600000;
/** Pagos de la cuenta. Las cuentas antiguas no los tienen apuntados: se sacan del historial de créditos */
function chargesOf(c) {
  if (Array.isArray(c.charges) && c.charges.length) return c.charges;
  const re = new RegExp(`^(Alta|Alta desde demo|Renovación) de ${c.embyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+) mes`);
  const rows = db.ledger.filter((l) => l.delta < 0 && (l.kind === 'alta' || l.kind === 'renovacion') && re.test(l.text) && (!c.createdAt || localDate(new Date(l.ts)) >= c.createdAt));
  const out = [];
  let to = c.expires;
  for (const l of rows) { // del mas nuevo al mas viejo: cada pago cubre los meses justo antes del anterior
    const months = Number(re.exec(l.text)[2]);
    const from = addMonths(to, -months);
    out.unshift({ ts: l.ts, userId: l.userId, credits: -l.delta, from, to, kind: /^Renovación/.test(l.text) ? 'renovacion' : 'alta', guessed: true });
    to = from;
  }
  return out;
}
function refundFor(c) {
  if (c.demo) return { total: 0, parts: [], lines: [] };
  const now = Date.now(), t = today(), per = new Map(), lines = [];
  for (const ch of chargesOf(c)) {
    let back = 0, why;
    if (now - Date.parse(ch.ts) < REFUND_FULL_MS) { back = ch.credits; why = 'pagado hace menos de 24 h: se devuelve entero'; }
    else {
      const total = Math.max(1, diffDays(ch.to, ch.from)), left = Math.min(total, Math.max(0, diffDays(ch.to, t > ch.from ? t : ch.from)));
      back = Math.floor((ch.credits * left) / total);
      why = left >= total ? 'periodo sin empezar: se devuelve entero' : left > 0 ? `quedaban ${left} de ${total} días` : 'periodo ya consumido';
    }
    lines.push({ kind: ch.kind, ts: ch.ts, credits: ch.credits, back, why, from: ch.from, to: ch.to, userId: ch.userId });
    if (back > 0) per.set(ch.userId, (per.get(ch.userId) || 0) + back);
  }
  const parts = [...per.entries()].map(([userId, credits]) => { const u = db.users.find((x) => x.id === userId); return { userId, credits, name: u ? u.name : 'Usuario eliminado', exists: !!u && holdsCredits(u) }; });
  return { total: parts.reduce((n, x) => n + x.credits, 0), parts, lines };
}
route('GET', '/api/clients/:id/refund', '*', ({ me, params }) => {
  const c = clientFor(me, params.id);
  const r = refundFor(c);
  return { ...r, lines: r.lines.map(({ userId, ...x }) => x) };
});
route('POST', '/api/clients/:id/delete-refund', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (me.role === 'admin' && !can(me, 'clients')) throw new HttpError(403, 'No tienes permiso para gestionar clientes.');
  const r = refundFor(c);
  await deleteEmbyUser(c); // si falla, no se borra nada ni se devuelve nada
  db.clients = db.clients.filter((x) => x.id !== c.id);
  const given = [];
  for (const p of r.parts) {
    const u = db.users.find((x) => x.id === p.userId);
    if (!u || !holdsCredits(u)) continue;
    u.credits += p.credits;
    addLedger(u, p.credits, `Devolución por eliminar ${c.embyName}`, me, 'devolucion');
    given.push(`${p.credits} a ${u.name}`);
    if (u.id !== me.id) notifyUser(u, `↩️ Se ha eliminado la cuenta ${c.embyName} y se te han devuelto ${p.credits} créditos. Saldo: ${u.credits}.`);
  }
  addLog('eliminada', c, `Eliminada de Emby y del panel${given.length ? ' con devolución de créditos: ' + given.join(', ') : ' (sin créditos que devolver)'}`, me);
  saveDb();
  return { ok: true, refunded: r.total, parts: r.parts };
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
  if (c.status === 'active' && valid && !c.off) await grantAccess(c);
  else await removeAccess(c, c.status === 'trash' || !!c.off);
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
  const shouldHave = c.status === 'active' && valid && !c.off;
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
  if (before && before.RemoteClientBitrateLimit > 0) say(false, `Tenía en Emby un tope de velocidad de ${Math.round(before.RemoteClientBitrateLimit / 1e5) / 10} Mbit/s: se ha quitado.`);
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
    say(!had, `${c.status === 'trash' ? 'Está en la papelera' : c.off ? 'La desactivaste tú' : c.demo ? 'La demo ha terminado' : 'Está caducada'}: ${had ? 'tenía bibliotecas y se le han retirado' : 'no tiene bibliotecas, como debe ser'}.`);
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
  delete c.off; delete c.offBy;
  c.status = 'trash'; c.trashedAt = today(); c.trashReason = c.demo ? 'Demo cancelada' : 'Baja manual';
  addLog('baja', c, 'Baja: cuenta desactivada y enviada a la papelera', me);
}
/* Varias cuentas a la vez */
function bulkClients(me, body) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))] : [];
  if (!ids.length) throw new HttpError(400, 'No has seleccionado ninguna cuenta.');
  if (ids.length > 500) throw new HttpError(400, 'Selecciona como mucho 500 cuentas cada vez.');
  const list = ids.map((id) => clientFor(me, id));
  list.me = me; // para cortar si a mitad le bloquean el acceso
  return list;
}
/** Aplica fn a cada cuenta; cada una se guarda aunque el proceso se corte. fn devuelve false para saltarla */
async function bulkEach(list, fn) {
  let moved = 0, skipped = 0;
  const failed = [];
  for (const c of list) {
    if (list.me && list.me.disabled) { skipped++; continue; } // bloqueado a mitad (acciones raras): no se sigue
    try { if (await fn(c) === false) skipped++; else moved++; }
    catch (e) { failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
    saveDb();
  }
  return { ok: true, moved, skipped, failed };
}
route('POST', '/api/bulk/repair', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => repairClient(me, c).then(() => true))));
route('POST', '/api/bulk/off', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => (c.status === 'trash' || c.off ? false : setOff(me, c, true)))));
route('POST', '/api/bulk/on', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => (c.status === 'trash' || !c.off ? false : setOff(me, c, false)))));
route('POST', '/api/bulk/trash', '*', ({ me, body }) => lock(async () => bulkEach(bulkClients(me, body), (c) => (c.status === 'trash' ? false : trashClient(me, c).then(() => true)))));
/* Ajustar fechas: suma o resta dias al vencimiento. No toca demos ni cuentas en la papelera */
route('POST', '/api/bulk/dates', STAFF, ({ me, body }) => lock(async () => {
  if (isStaff(me) && paysCredits(me)) throw new HttpError(403, 'Tienes el sistema de créditos activado: las fechas se cambian renovando.');
  const list = bulkClients(me, body);
  // Modo: sumar / restar (días, semanas o meses) o poner una fecha exacta. «days» suelto sigue funcionando como antes
  const mode = ['add', 'sub', 'set'].includes(body.mode) ? body.mode : 'add';
  const unit = ['d', 'w', 'm'].includes(body.unit) ? body.unit : 'd';
  const amount = body.mode ? Number(body.amount) : Number(body.days);
  const setDate = str(body.date, 10);
  if (mode === 'set') { if (!/^\d{4}-\d{2}-\d{2}$/.test(setDate)) throw new HttpError(400, 'Elige la fecha nueva.'); }
  else if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > (unit === 'm' ? 120 : unit === 'w' ? 520 : 3650)) throw new HttpError(400, 'Escribe una cantidad distinta de cero.');
  const sign = mode === 'sub' ? -1 : 1, n = sign * amount;
  const reason = str(body.reason, 200), onlyFuture = !!body.onlyFuture;
  const label = mode === 'set' ? `fecha fija ${setDate}` : `${n > 0 ? '+' : ''}${n} ${unit === 'm' ? (Math.abs(n) === 1 ? 'mes' : 'meses') : unit === 'w' ? (Math.abs(n) === 1 ? 'semana' : 'semanas') : (Math.abs(n) === 1 ? 'día' : 'días')}`;
  const t = today();
  const r = await bulkEach(list, async (c) => {
    if (c.demo || c.status === 'trash') return false;
    const before = c.expires;
    const next = mode === 'set' ? setDate : unit === 'm' ? addMonths(before, n) : addDays(before, unit === 'w' ? n * 7 : n);
    if (next === before) return false;
    if (onlyFuture && diffDays(next, t) < 0) return false; // se queda como estaba
    c.expires = next;
    try { if (diffDays(c.expires, t) >= 0) { await grantAccess(c); c.status = 'active'; } }
    catch (e) { c.expires = before; throw e; }
    addLog('edicion', c, `Editada: vencimiento ${before} → ${c.expires} (ajuste ${label})${reason ? ' · Motivo: ' + reason : ''}`, me);
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

/* Traspaso entre servicios: pasa las cuentas a Básico o a 4K y lo aplica en Emby */
route('POST', '/api/bulk/package', STAFF, ({ me, body }) => lock(async () => {
  const list = bulkClients(me, body);
  const q = body.quality === 'k4' ? 'k4' : body.quality === 'basico' ? 'basico' : null;
  if (!q) throw new HttpError(400, 'Elige Básico o 4K.');
  let moved = 0, skipped = 0;
  const failed = [];
  for (const c of list) {
    if (c.quality === q || c.status === 'trash') { skipped++; continue; }
    const s = serverOf(c);
    if (!packageReady(s, q)) { failed.push({ name: c.panelName, emby: c.embyName, error: `El contenido ${QUALITIES[q]} no está configurado en ${s.name}` }); continue; }
    const was = c.quality, wasAccess = c.access;
    c.quality = q;
    try { await applyState(c); moved++; addLog('edicion', c, `Servicio cambiado en bloque: ${was ? QUALITIES[was] : 'bibliotecas propias'} → ${QUALITIES[q]}`, me); }
    catch (e) { c.quality = was; if (wasAccess) c.access = wasAccess; failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
    saveDb();
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
  const out = { notInPanel: [], notInEmby: [], mismatch: [], errors: [], checked: 0, servers: [], at: new Date().toISOString() };
  const vd = (v) => (v && !String(v).startsWith('0001') ? String(v) : null);
  for (const s of db.servers) {
    let users;
    try { users = await emby(s, 'GET', '/Users'); }
    catch (e) { out.errors.push(e.message); continue; }
    const byId = new Map((users || []).map((u) => [u.Id, u]));
    const mine = db.clients.filter((c) => c.serverId === s.id);
    const known = new Set(mine.map((c) => c.embyId));
    let admins = 0;
    for (const u of users || []) {
      const pol = u.Policy || {};
      if (pol.IsAdministrator) { admins++; continue; }
      if (!known.has(u.Id)) out.notInPanel.push({ server: s.name, serverId: s.id, embyId: u.Id, name: u.Name, disabled: !!pol.IsDisabled,
        libs: !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0, seen: vd(u.LastActivityDate), created: vd(u.DateCreated) });
    }
    out.servers.push({ id: s.id, name: s.name, emby: (users || []).length - admins, panel: mine.length, admins });
    for (const c of mine) {
      out.checked++;
      const row = { id: c.id, server: s.name, panelName: c.panelName, embyName: c.embyName, owner: names.get(c.ownerId) || '' };
      const u = byId.get(c.embyId);
      if (!u) { out.notInEmby.push(row); continue; }
      const pol = u.Policy || {};
      const hasLibs = !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0;
      const problems = [];
      if (c.off && c.status !== 'trash') {
        if (!pol.IsDisabled) problems.push('la desactivaste en el panel, pero en Emby sigue activada');
        else if (hasLibs) problems.push('la desactivaste en el panel, pero en Emby conserva bibliotecas');
      } else if (c.status === 'active') {
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
      if (pol.RemoteClientBitrateLimit > 0) problems.push(`tiene en Emby un tope de velocidad de ${Math.round(pol.RemoteClientBitrateLimit / 1e5) / 10} Mbit/s, que obliga a convertir el vídeo`);
      if (c.status === 'active' && !c.off && !pol.IsDisabled && hasLibs && c.quality && packageReady(s, c.quality)) {
        const pk = s.packages[c.quality];
        if (!!pk.all !== !!pol.EnableAllFolders || (!pk.all && !sameLibs(pk.folders, pol.EnabledFolders))) problems.push(`sus bibliotecas en Emby no son las del paquete ${QUALITIES[c.quality]}`);
      }
      if (problems.length) out.mismatch.push({ ...row, problems });
    }
  }
  return out;
});

/* Auditoría: arreglar lo que sobra en Emby o en el panel */
route('POST', '/api/audit/emby-users', STAFF, ({ me, body }) => lock(async () => {
  const action = body.action === 'delete' ? 'delete' : body.action === 'disable' ? 'disable' : null;
  if (!action) throw new HttpError(400, 'Acción no válida.');
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  const out = { moved: 0, skipped: 0, failed: [] };
  for (const it of items) {
    const s = db.servers.find((x) => x.id === Number(it.serverId));
    const id = String(it.embyId || '');
    if (!s || !/^[A-Za-z0-9-]{1,64}$/.test(id)) { out.skipped++; continue; }
    // Nunca se toca a un administrador de Emby ni a una cuenta que si esta en el panel
    if (db.clients.some((c) => c.serverId === s.id && c.embyId === id)) { out.skipped++; continue; }
    let u;
    try { u = await emby(s, 'GET', `/Users/${id}`); } catch (e) { if (e.embyStatus === 404) { out.skipped++; continue; } out.failed.push({ name: id, emby: s.name, error: e.message }); continue; }
    const pol = u.Policy || {};
    if (pol.IsAdministrator) { out.skipped++; continue; }
    try {
      if (action === 'delete') await emby(s, 'DELETE', `/Users/${id}`);
      else { pol.IsDisabled = true; pol.EnableAllFolders = false; pol.EnabledFolders = []; await emby(s, 'POST', `/Users/${id}/Policy`, pol); }
      addLog(action === 'delete' ? 'eliminada' : 'baja', null, `Auditoría: usuario «${u.Name}» de ${s.name} ${action === 'delete' ? 'eliminado de Emby' : 'desactivado en Emby'} (no estaba en el panel)`, me);
      out.moved++;
    } catch (e) { out.failed.push({ name: u.Name, emby: s.name, error: e.message }); }
  }
  saveDb();
  return out;
}));
route('POST', '/api/audit/forget', STAFF, ({ me, body }) => lock(async () => {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).slice(0, 500) : [];
  const out = { moved: 0, skipped: 0, failed: [] };
  for (const cid of ids) {
    const c = db.clients.find((x) => x.id === cid);
    if (!c) { out.skipped++; continue; }
    const s = db.servers.find((x) => x.id === c.serverId);
    if (s) { // solo si de verdad ya no existe en Emby
      try { await emby(s, 'GET', `/Users/${c.embyId}`); out.failed.push({ name: c.panelName, emby: c.embyName, error: 'Sigue existiendo en Emby: no se quita.' }); continue; }
      catch (e) { if (e.embyStatus !== 404) { out.failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); continue; } }
    }
    db.clients = db.clients.filter((x) => x.id !== c.id);
    addLog('eliminada', c, 'Auditoría: quitada del panel porque ya no existía en Emby', me);
    out.moved++;
  }
  saveDb();
  return out;
}));

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
  const u = { id: newId(), username, name: str(body.name, 60) || username, role, parentId, credits: 0, disabled: false, createdAt: today(), mustPw: true };
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
  if (typeof body.password === 'string' && body.password) { setPassword(u, readNewPassword(body.password)); u.mustPw = true; dropSessions(u.id); }
  if (body.disabled !== undefined) { u.disabled = !!body.disabled; if (u.disabled) dropSessions(u.id); else { delete u.offBy; delete u.offAt; } }
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
/* Apagar o encender a un usuario del panel (por ejemplo, porque no paga).
   Con clients: true también apaga sus cuentas (y las de sus subresellers); al encenderlo solo se reactivan las que se apagaron con él */
route('POST', '/api/users/:id/power', ['super', 'admin', 'reseller'], ({ me, params, body }) => lock(async () => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes cambiar a este usuario.');
  needPerm(me, u.role === 'admin' ? 'admins' : 'resellers');
  const off = !!body.off, withClients = !!body.clients;
  const subs = u.role === 'reseller' ? db.users.filter((x) => x.parentId === u.id) : [];
  const out = { clients: 0, subs: 0, failed: [] };
  const people = [u, ...(withClients ? subs : [])];
  for (const p of people) {
    if (p === u) { u.disabled = off; if (off) u.offAt = new Date().toISOString(); else delete u.offAt; }
    else if (off && !p.disabled) { p.disabled = true; p.offBy = u.id; out.subs++; }
    else if (!off && p.offBy === u.id) { p.disabled = false; delete p.offBy; out.subs++; }
    if (p.disabled) dropSessions(p.id);
  }
  if (withClients) {
    const owners = new Set([u.id, ...subs.map((x) => x.id)]);
    for (const c of db.clients.filter((x) => owners.has(x.ownerId) && x.status !== 'trash')) {
      try {
        if (off && !c.off) { await setOff(me, c, true); c.offBy = u.id; out.clients++; }
        else if (!off && c.off && c.offBy === u.id) { await setOff(me, c, false); out.clients++; }
      } catch (e) { out.failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
      saveDb();
    }
  }
  if (!off) delete u.offBy;
  const extra = withClients ? `: ${out.clients} ${out.clients === 1 ? 'cuenta' : 'cuentas'}${out.subs ? ` y ${out.subs} ${out.subs === 1 ? 'subreseller' : 'subresellers'}` : ''} ${off ? 'apagadas' : 'encendidas'} con él` : ' (sus cuentas no se tocan)';
  addLog('usuario', null, `${off ? 'Desactivado' : 'Activado'} ${(ROLE_NAME[u.role] || 'usuario').toLowerCase()} ${u.name}${extra}`, me);
  saveDb();
  return { ok: true, ...out };
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
  const pay = amount > 0 ? readPayment(body, u, amount) : null;
  if (!paysCredits(me)) {
    if (u.credits + amount < 0 && !u.allowNegative) throw new HttpError(400, `No se pueden retirar ${-amount}: solo tiene ${u.credits}.`);
    u.credits += amount;
    const label = reason || (amount > 0 ? 'Recarga' : 'Retirada');
    addLedger(u, amount, label + detail + payText(pay), me, amount < 0 || /ajuste|penaliz|devoluc/i.test(label) ? 'ajuste' : 'credito');
    afterRecharge(me, u, amount, pay);
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
    addLedger(me, -amount, `Para ${u.name}` + detail + payText(pay), me, 'asignacion');
    u.credits += amount;
    addLedger(u, amount, `Recibido de ${me.name}` + detail + payText(pay), me, 'credito');
    afterRecharge(me, u, amount, pay);
  }
  saveDb();
  return { ok: true, credits: u.credits };
}));

/* Ultima conexion de cada cuenta, segun Emby (se guarda un minuto para no saturarlo).
 * Tambien el ultimo aparato usado y el ultimo inicio de sesion. Se apunta en la cuenta,
 * asi el dato se sigue viendo aunque Emby no responda en ese momento. */
const seenCache = new Map(); // serverId -> { at, map: embyId -> { seen, login, dev } }
const validDate = (v) => (v && !String(v).startsWith('0001') ? String(v) : null);
route('GET', '/api/lastseen', '*', async ({ me }) => {
  const vis = visibleOwners(me);
  const seen = {}, info = {};
  let changed = false;
  for (const s of db.servers) {
    let hit = seenCache.get(s.id);
    if (!hit || Date.now() - hit.at > 60000) {
      try {
        const users = await emby(s, 'GET', '/Users');
        const map = new Map((users || []).map((u) => [u.Id, { seen: validDate(u.LastActivityDate), login: validDate(u.LastLoginDate), dev: null }]));
        try { // ultimo aparato de cada usuario: no todas las versiones de Emby lo dan
          const d = await emby(s, 'GET', '/Devices');
          for (const x of (d && d.Items) || (Array.isArray(d) ? d : [])) {
            const m = map.get(x.LastUserId), at = validDate(x.DateLastActivity);
            if (m && at && (!m.dev || at > m.dev.at)) m.dev = { name: String(x.Name || '').slice(0, 80), app: String(x.AppName || '').slice(0, 60), at };
          }
        } catch { /* sin aparatos */ }
        hit = { at: Date.now(), map };
        seenCache.set(s.id, hit);
      } catch { hit = null; }
    }
    for (const c of db.clients) {
      if (c.serverId !== s.id) continue;
      const m = hit && hit.map.get(c.embyId);
      if (m) {
        if (m.seen && m.seen !== c.seenAt) { c.seenAt = m.seen; changed = true; }
        if (m.login && m.login !== c.loginAt) { c.loginAt = m.login; changed = true; }
        if (m.dev && (!c.seenDev || c.seenDev.at !== m.dev.at)) { c.seenDev = m.dev; changed = true; }
      }
      if (vis && !vis.has(c.ownerId)) continue;
      if (m) seen[c.id] = m.seen;
      else if (c.seenAt) seen[c.id] = c.seenAt;
      if (c.seenAt || c.loginAt || c.seenDev) info[c.id] = { seen: c.seenAt || null, login: c.loginAt || null, dev: c.seenDev || null, live: !!m };
    }
  }
  if (changed) lock(async () => saveDb()).catch(() => {}); // sin esperar: la lista no se frena
  return { seen, info };
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
            // Aviso de calidad: solo si el vídeo PIERDE calidad de verdad, y como mucho cada «tipEvery» minutos por aparato
            let tipped = false;
            if (!cfg.transcode.stop && cfg.transcode.tip !== false && videoInfo(x).quality.level === 'likely') {
              const tk = `q:${s.id}:${x.DeviceId || x.Id}`;
              if (!recent.has(tk) || now - recent.get(tk) >= (cfg.transcode.tipEvery || 30) * 60000) {
                recent.set(tk, now);
                const caps = sessionCaps(x);
                if (caps.canMsg) { try { await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: 'Calidad de vídeo', Text: (cfg.transcode.tipText || QUALITY_TEXT).slice(0, 400), TimeoutMs: 120000 }); tipped = true; } catch { /* queda registrado como aviso */ } }
              }
            }
            const key = `t:${s.id}:${x.Id}:${(x.NowPlayingItem || {}).Id || ''}`;
            if (recent.has(key) && now - recent.get(key) < (cfg.transcode.stop ? 20000 : 6 * 3600000)) continue;
            recent.set(key, now);
            let action = 'Solo aviso';
            if (cfg.transcode.stop) {
              try { await stopSession(s, x, cfg.transcode.message); action = 'Reproducción detenida'; live = live.filter((y) => y !== x); }
              catch (e) { action = 'No se pudo detener'; }
            } else if (tipped) action = 'Aviso de calidad en su pantalla';
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
    if (k === 'transcode' && b.tip !== undefined) cur[k].tip = !!b.tip;
    if (k === 'transcode' && b.tipEvery !== undefined) { const n = Number(b.tipEvery); if (Number.isInteger(n) && n >= 5 && n <= 1440) cur[k].tipEvery = n; }
    if (k === 'transcode' && typeof b.tipText === 'string') cur[k].tipText = b.tipText.trim().slice(0, 400);
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
      const byEmby = new Map(db.clients.filter((c) => c.serverId === s.id).map((c) => [c.embyId, c.id]));
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
        out.push({ server: s.name, clientId: byEmby.get(x.UserId) || null, user: x.UserName || '', device: x.DeviceName || '', app: x.Client || '', title, paused: !!ps.IsPaused, method: ps.PlayMethod || '', position: ps.PositionTicks || 0, duration: it.RunTimeTicks || 0 });
      }
    } catch (e) { if (isStaff(me)) errors.push(e.message); else errors.push('No se pudo consultar el servidor.'); }
  }));
  return { sessions: out, errors };
});

/* Mensaje a todos los que están conectados (en un servidor o en todos) */
route('POST', '/api/monitor/broadcast', '*', async ({ me, body }) => {
  const text = str(body.text, 300);
  if (!text) throw new HttpError(400, 'Escribe el mensaje.');
  const vis = visibleOwners(me), only = Number(body.serverId) || 0;
  let sent = 0, failed = 0;
  for (const s of db.servers) {
    if (only && s.id !== only) continue;
    const mine = new Map(db.clients.filter((c) => c.serverId === s.id && c.status !== 'trash' && (!vis || vis.has(c.ownerId))).map((c) => [c.embyId, c]));
    let list;
    try { list = await emby(s, 'GET', '/Sessions?ActiveWithinSeconds=600'); } catch { failed++; continue; }
    for (const x of list || []) {
      if (!x.UserId || (vis && !mine.has(x.UserId))) continue;
      if (!vis && !mine.has(x.UserId) && !x.NowPlayingItem) continue; // a los que no son clientes del panel, solo si estan viendo algo
      try { await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: str(body.header, 40) || db.settings.brand.name || 'Aviso', Text: text, TimeoutMs: 15000 }); sent++; } catch { /* esa app no admite mensajes */ }
    }
  }
  await lock(async () => { addLog('monitor', null, `Mensaje a todos${only ? ' en ' + (db.servers.find((x) => x.id === only) || {}).name : ''}: ${text.slice(0, 120)} (${sent} pantallas)`, me); saveDb(); });
  return { ok: true, sent, failed };
});

/* ---------- Vigilancia de servidores: aviso si se cae y cuando vuelve ---------- */
const health = new Map(); // serverId -> { fails, down, since, checked, ok }
async function watchServers() {
  for (const s of db.servers) {
    const h = health.get(s.id) || { fails: 0, down: false, since: null, checked: null, ok: true };
    let ok = true, why = '';
    const t0 = Date.now();
    try { const inf = await emby(s, 'GET', '/System/Info'); if (inf && inf.Version) h.version = String(inf.Version).slice(0, 20); h.ms = Date.now() - t0; } catch (e) { ok = false; why = e.message; }
    h.checked = new Date().toISOString(); h.ok = ok;
    const P = power.get(s.id), planned = P && Date.now() - P.at < 10 * 60000;
    if (P && !planned) power.delete(s.id);
    if (ok && P && P.kind === 'emby' && h.fails > 0) { // vuelve tras el reinicio pedido
      power.delete(s.id); h.fails = 0; h.down = false; h.since = null; health.set(s.id, h);
      notifyStaff('servers', `✅ Emby de «${s.name}» se ha reiniciado y vuelve a funcionar.\n${whenTxt()}`);
      continue;
    }
    if (!ok && planned) { h.fails++; health.set(s.id, h); continue; } // reinicio pedido: no es una caída
    if (ok) {
      if (h.down) {
        const mins = Math.max(1, Math.round((Date.now() - Date.parse(h.since)) / 60000));
        notifyStaff('servers', `🟢 El servidor «${s.name}» vuelve a funcionar.\nEstuvo caído unos ${mins < 60 ? (mins === 1 ? '1 minuto' : mins + ' minutos') : Math.round(mins / 6) / 10 + ' horas'}.\n${whenTxt()}`);
        lock(async () => { addLog('servidor', null, `Servidor ${s.name} recuperado (caído ${mins} min)`, null); saveDb(); }).catch(() => {});
      }
      h.fails = 0; h.down = false; h.since = null;
    } else {
      h.fails++;
      if (h.fails === 1) h.since = new Date().toISOString();
      if (h.fails === 2 && !h.down) { // dos fallos seguidos: no es un corte de un segundo
        h.down = true;
        notifyStaff('servers', `🔴 El servidor «${s.name}» no responde.\n${why}\n${whenTxt()}\n\nTus clientes de ese servidor no pueden ver nada. Te aviso cuando vuelva.`);
        lock(async () => { addLog('servidor', null, `Servidor ${s.name} caído: ${why}`, null); saveDb(); }).catch(() => {});
      }
    }
    health.set(s.id, h);
  }
}
route('GET', '/api/health', '*', () => ({ servers: db.servers.map((s) => { const h = health.get(s.id); return { id: s.id, name: s.name, ok: h ? !h.down : null, since: h && h.down ? h.since : null, checked: h ? h.checked : null, version: h ? h.version || '' : '', ms: h ? h.ms || 0 : 0 }; }) }));

/* ---------- Estadísticas de uso: el panel apunta cada minuto lo que se está viendo ---------- */
const PLAY_MS = Number(process.env.PLAY_MS) || 60000;
const seenToday = { day: '', keys: new Set() };
let usageDirty = 0, usageBusy = false;
async function recordUsage() {
  if (usageBusy || !db.servers.length) return;
  usageBusy = true;
  try {
    const t = today(), hour = new Date().getHours(), mins = PLAY_MS / 60000;
    if (!db.usage || typeof db.usage !== 'object') db.usage = { days: {} };
    const day = db.usage.days[t] || (db.usage.days[t] = { m: 0, peak: 0, peakAt: '', hours: Array(24).fill(0), titles: {}, servers: {}, clients: {}, apps: {} });
    if (seenToday.day !== t) { seenToday.day = t; seenToday.keys = new Set(); }
    let now = 0;
    for (const s of db.servers) {
      let list;
      try { list = await emby(s, 'GET', '/Sessions'); } catch { continue; }
      const byEmby = new Map(db.clients.filter((c) => c.serverId === s.id).map((c) => [c.embyId, c]));
      for (const x of list || []) {
        recordConn(byEmby.get(x.UserId), x);
        const it = x.NowPlayingItem;
        if (!it || (x.PlayState || {}).IsPaused) continue;
        now++;
        const kind = it.Type === 'Episode' ? 'serie' : it.Type === 'Movie' ? 'pelicula' : 'otro';
        const title = String((it.Type === 'Episode' ? it.SeriesName : it.Name) || 'Sin título').slice(0, 120);
        const key = kind + '|' + title;
        const tt = day.titles[key] || (Object.keys(day.titles).length < 400 ? (day.titles[key] = { t: title, k: kind, m: 0, n: 0, y: it.ProductionYear || '', p: it.SeriesId || it.Id || '', s: s.id }) : null);
        if (tt) { tt.m += mins; const vk = key + '|' + s.id + '|' + x.UserId; if (!seenToday.keys.has(vk)) { seenToday.keys.add(vk); tt.n++; } }
        day.m += mins; day.hours[hour] += mins;
        day.servers[s.id] = (day.servers[s.id] || 0) + mins;
        const c = byEmby.get(x.UserId);
        if (c) day.clients[c.id] = (day.clients[c.id] || 0) + mins;
        const app = String(x.Client || 'Otra').slice(0, 40);
        day.apps[app] = (day.apps[app] || 0) + mins;
      }
    }
    if (now > day.peak) { day.peak = now; day.peakAt = new Date().toISOString(); }
    // Se guardan 120 dias
    const keys = Object.keys(db.usage.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete db.usage.days[k];
    if (++usageDirty >= 5) { usageDirty = 0; lock(async () => saveDb()).catch(() => {}); }
    saveConn();
  } finally { usageBusy = false; }
}

/* ======================================================================
   Historial de conexiones de los clientes (sale de las sesiones de Emby que el panel ya lee cada minuto).
   Se guarda aparte, en data/conexiones.json: 45 días y hasta 150 tramos por cuenta.
   Cada tramo: [inicio, fin, aparato, app, ip, idAparato, viendo]
   ====================================================================== */
const CONN_FILE = path.join(DATA_DIR, 'conexiones.json');
let conn = null, connDirty = false, connSaved = 0;
function connLoad() { if (conn) return conn; try { conn = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8')); } catch { conn = {}; } return conn; }
function saveConn(force) {
  if (!connDirty || (!force && Date.now() - connSaved < 120000)) return;
  try {
    const lim = Date.now() - 45 * 86400000;
    for (const k of Object.keys(conn)) { conn[k] = conn[k].filter((r) => Date.parse(r[1]) >= lim).slice(-150); if (!conn[k].length || !db.clients.some((c) => String(c.id) === k)) delete conn[k]; }
    fs.writeFileSync(CONN_FILE + '.tmp', JSON.stringify(conn)); fs.renameSync(CONN_FILE + '.tmp', CONN_FILE);
    connDirty = false; connSaved = Date.now();
  } catch (e) { console.error('Conexiones:', e.message); }
}
function recordConn(c, x) {
  if (!c || !x || !x.UserId) return;
  const act = Date.parse(x.LastActivityDate || '') || 0;
  if (!x.NowPlayingItem && Date.now() - act > 3 * 60000) return; // sesion abierta pero sin uso reciente: no cuenta
  const all = connLoad(), list = all[c.id] || (all[c.id] = []);
  const nowIso = new Date().toISOString(), dev = String(x.DeviceName || 'Aparato').slice(0, 50), app = String(x.Client || '').slice(0, 40);
  const ip = String(x.RemoteEndPoint || '').replace(/^::ffff:/, '').slice(0, 45), did = String(x.DeviceId || dev + app).slice(0, 80);
  // Mismo aparato y menos de 10 minutos desde la ultima vez: se alarga el mismo tramo
  for (let i = list.length - 1; i >= 0 && i >= list.length - 8; i--) {
    const r = list[i];
    if (r[5] === did && Date.now() - Date.parse(r[1]) < 10 * 60000) { r[1] = nowIso; if (ip) r[4] = ip; if (x.NowPlayingItem) r[6] = 1; connDirty = true; return; }
  }
  list.push([nowIso, nowIso, dev, app, ip, did, x.NowPlayingItem ? 1 : 0]);
  connDirty = true;
}
/** Zona aproximada de una IP: las tres primeras partes (casa, trabajo, datos del movil...) */
const ipZone = (ip) => { const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip || ''); return m ? m[1] : (ip || '').split(':').slice(0, 4).join(':'); };
/** Resumen de los ultimos dias de una cuenta, y si parece compartida */
function shareInfo(c, days = 7) {
  const lim = Date.now() - days * 86400000, rows = (connLoad()[c.id] || []).filter((r) => Date.parse(r[1]) >= lim);
  const devs = new Map(), zones = new Set();
  for (const r of rows) { devs.set(r[5], { name: r[2], app: r[3], last: r[1] }); if (r[4]) zones.add(ipZone(r[4])); }
  // Aparatos a la vez: tramos que se solapan
  let maxAt = 0;
  const ev = []; for (const r of rows) { if (!r[6]) continue; ev.push([Date.parse(r[0]), 1, r[5]]); ev.push([Date.parse(r[1]) + 60000, -1, r[5]]); } // solo aparatos viendo algo
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const on = new Map(); for (const [, d, id] of ev) { on.set(id, (on.get(id) || 0) + d); const n = [...on.values()].filter((v) => v > 0).length; if (n > maxAt) maxAt = n; }
  const screens = c.screens || 1, reasons = [];
  if (devs.size >= Math.max(4, screens * 2 + 1)) reasons.push(`${devs.size} aparatos distintos`);
  if (zones.size >= 3) reasons.push(`desde ${zones.size} sitios diferentes`);
  if (c.screens > 0 && maxAt > c.screens) reasons.push(`${maxAt} aparatos a la vez con ${plural(c.screens, 'pantalla', 'pantallas')}`);
  const level = reasons.length >= 2 || (c.screens > 0 && maxAt > c.screens) ? 'alto' : reasons.length ? 'medio' : 'no';
  return { devices: devs.size, places: zones.size, maxAt, sessions: rows.length, reasons, level, devList: [...devs.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 8) };
}
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
/** Cuántas cuentas parecen compartidas (se recalcula como mucho cada minuto) */
const shareCache = new Map();
function sharedCount(vis) {
  const key = vis ? [...vis].sort().join(',') : 'all', hit = shareCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.n;
  const ids = db.clients.filter((c) => c.status !== 'trash' && !c.demo && (!vis || vis.has(c.ownerId)) && shareInfo(c).level !== 'no').map((c) => c.id);
  shareCache.set(key, { n: ids.length, ids, at: Date.now() });
  return ids.length;
}
route('GET', '/api/shared', '*', ({ me }) => {
  const vis = visibleOwners(me);
  const list = db.clients.filter((c) => c.status !== 'trash' && !c.demo && (!vis || vis.has(c.ownerId)))
    .map((c) => ({ id: c.id, ...shareInfo(c) })).filter((x) => x.level !== 'no')
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'alto' ? -1 : 1) || b.devices - a.devices);
  return { list, since: (() => { let min = null; for (const v of Object.values(connLoad())) for (const r of v) if (!min || r[0] < min) min = r[0]; return min; })() };
});
route('GET', '/api/clients/:id/connections', '*', ({ me, params }) => {
  const c = clientFor(me, params.id);
  const rows = (connLoad()[c.id] || []).slice().reverse().map((r) => ({ from: r[0], to: r[1], dev: r[2], app: r[3], ip: r[4], devId: r[5], playing: !!r[6] }));
  return { rows, week: shareInfo(c, 7), month: shareInfo(c, 30) };
});

/* ======================================================================
   Seguimiento de demos que terminaron sin comprar
   ====================================================================== */
function addFollowup(c) {
  if (db.followups.some((f) => f.clientId === c.id)) return;
  db.followups.unshift({ id: crypto.randomBytes(5).toString('hex'), clientId: c.id, name: c.panelName, emby: c.embyName, ownerId: c.ownerId, serverId: c.serverId,
    whatsapp: c.whatsapp || '', telegram: c.telegram || '', email: c.email || '', tgChat: c.tgChat || null, endedAt: new Date().toISOString(), status: 'pending' });
  const lim = Date.now() - 30 * 86400000;
  db.followups = db.followups.filter((f) => Date.parse(f.endedAt) >= lim).slice(0, 2000);
}
const fuVisible = (me) => { const vis = visibleOwners(me); return db.followups.filter((f) => !vis || vis.has(f.ownerId)); };
route('GET', '/api/followups', '*', ({ me }) => ({
  list: fuVisible(me).map(({ tgChat, ...f }) => ({ ...f, tgLinked: !!tgChat, text: fillText(db.settings.templates.followup || DEFAULT_TEMPLATES.followup, { panelName: f.name, embyName: f.emby, serverId: f.serverId, expires: today(), screens: 0, quality: null }) })),
}));
route('POST', '/api/followups/:id', '*', ({ me, params, body }) => lock(async () => {
  const f = fuVisible(me).find((x) => x.id === params.id);
  if (!f) throw new HttpError(404, 'Ese seguimiento ya no existe.');
  const st = ['done', 'skip', 'pending'].includes(body.status) ? body.status : null;
  if (!st) throw new HttpError(400, 'Estado no válido.');
  f.status = st; f.doneAt = new Date().toISOString(); f.doneBy = me.name;
  saveDb();
  return { ok: true };
}));
route('POST', '/api/followups/:id/telegram', '*', async ({ me, params, body }) => {
  const f = fuVisible(me).find((x) => x.id === params.id);
  if (!f) throw new HttpError(404, 'Ese seguimiento ya no existe.');
  if (!f.tgChat) throw new HttpError(400, 'Este cliente no tenía Telegram enlazado. Escríbele por WhatsApp o copia el mensaje.');
  const text = (typeof body.text === 'string' && body.text.trim()) ? body.text.trim().slice(0, 1500) : fillText(db.settings.templates.followup, { panelName: f.name, embyName: f.emby, serverId: f.serverId, expires: today(), screens: 0, quality: null });
  await tg('sendMessage', { chat_id: f.tgChat, text });
  await lock(async () => { f.status = 'done'; f.doneAt = new Date().toISOString(); f.doneBy = me.name; addLog('aviso', null, `Seguimiento de la demo de ${f.name} enviado por Telegram`, me); saveDb(); });
  return { ok: true };
});

/* ======================================================================
   Mensaje por Telegram a muchos clientes a la vez
   ====================================================================== */
function bcTargets(me, body) {
  const vis = visibleOwners(me), who = body.who || 'active';
  return db.clients.filter((c) => c.tgChat && (!vis || vis.has(c.ownerId))
    && (who === 'all' ? c.status !== 'trash' || c.demo : who === 'demo' ? c.demo && c.status === 'active' : !c.demo && c.status !== 'trash' && (who !== 'active' || c.status === 'active'))
    && (!Number(body.serverId) || c.serverId === Number(body.serverId)) && (!Number(body.ownerId) || c.ownerId === Number(body.ownerId)));
}
route('POST', '/api/broadcast/preview', '*', ({ me, body }) => {
  const vis = visibleOwners(me);
  const mine = db.clients.filter((c) => c.status !== 'trash' && (!vis || vis.has(c.ownerId)));
  return { targets: bcTargets(me, body).length, linked: mine.filter((c) => c.tgChat).length, total: mine.length, bot: !!db.settings.notices.telegram.token };
});
let bcJob = null;
route('GET', '/api/broadcast', '*', ({ me }) => ({ job: bcJob && (isStaff(me) || bcJob.byId === me.id) ? { total: bcJob.total, done: bcJob.done, ok: bcJob.ok, fail: bcJob.fail, finished: bcJob.finished } : null,
  history: db.broadcasts.filter((b) => isStaff(me) || b.byId === me.id).slice(0, 10) }));
route('POST', '/api/broadcast', '*', ({ me, body }) => {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (text.length < 3) throw new HttpError(400, 'Escribe el mensaje.');
  if (!db.settings.notices.telegram.token) throw new HttpError(400, 'El bot de Telegram no está configurado.');
  if (bcJob && !bcJob.finished) throw new HttpError(409, 'Ya se está enviando otro mensaje. Espera a que termine.');
  const list = bcTargets(me, body);
  if (!list.length) throw new HttpError(400, 'Ninguno de esos clientes tiene Telegram enlazado.');
  bcJob = { byId: me.id, total: list.length, done: 0, ok: 0, fail: 0, finished: false };
  const job = bcJob;
  (async () => {
    for (const c of list) {
      try { await tg('sendMessage', { chat_id: c.tgChat, text: fillText(text, c) }); job.ok++; }
      catch (e) { job.fail++; if (/blocked|chat not found|deactivated/i.test(e.message)) await lock(async () => { delete c.tgChat; saveDb(); }); }
      job.done++;
      await new Promise((r) => setTimeout(r, Number(process.env.BC_DELAY_MS) || 60)); // Telegram admite unos 30 mensajes por segundo
    }
    job.finished = true;
    await lock(async () => {
      db.broadcasts.unshift({ at: new Date().toISOString(), by: me.name, byId: me.id, text: text.slice(0, 300), total: job.total, ok: job.ok, fail: job.fail });
      db.broadcasts = db.broadcasts.slice(0, 50);
      addLog('aviso', null, `Mensaje por Telegram a ${job.ok} clientes${job.fail ? ` (${job.fail} no se pudieron enviar)` : ''}: ${text.slice(0, 80)}`, me);
      saveDb();
    });
  })().catch((e) => { job.finished = true; console.error('Envío a clientes:', e.message); });
  return { ok: true, total: list.length };
});
route('GET', '/api/usage', STAFF, ({ req }) => {
  const q = new URL(req.url, 'http://x').searchParams, n = Math.min(120, Math.max(1, Number(q.get('days')) || 30));
  const days = (db.usage && db.usage.days) || {}, from = addDays(today(), -(n - 1));
  const out = { days: [], hours: Array(24).fill(0), titles: {}, servers: {}, clients: {}, apps: {}, m: 0, peak: 0, peakAt: '', movies: 0, series: 0, since: Object.keys(days).sort()[0] || null };
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i), x = days[d];
    out.days.push({ d, m: x ? Math.round(x.m) : 0, peak: x ? x.peak : 0 });
    if (!x) continue;
    out.m += x.m;
    if (x.peak > out.peak) { out.peak = x.peak; out.peakAt = x.peakAt; }
    x.hours.forEach((v, h) => { out.hours[h] += v; });
    for (const [k, v] of Object.entries(x.titles)) {
      const o = out.titles[k] || (out.titles[k] = { t: v.t, k: v.k, m: 0, n: 0, y: v.y, p: v.p, s: v.s });
      o.m += v.m; o.n += v.n;
      if (v.k === 'pelicula') out.movies += v.m; else if (v.k === 'serie') out.series += v.m;
    }
    for (const [k, v] of Object.entries(x.servers)) out.servers[k] = (out.servers[k] || 0) + v;
    for (const [k, v] of Object.entries(x.clients)) out.clients[k] = (out.clients[k] || 0) + v;
    for (const [k, v] of Object.entries(x.apps)) out.apps[k] = (out.apps[k] || 0) + v;
  }
  const top = (o, k = 12) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k);
  return {
    n, since: out.since, m: Math.round(out.m), peak: out.peak, peakAt: out.peakAt, movies: Math.round(out.movies), series: Math.round(out.series),
    days: out.days, hours: out.hours.map(Math.round),
    titles: Object.values(out.titles).sort((a, b) => b.m - a.m).slice(0, 15).map((t) => ({ ...t, m: Math.round(t.m) })),
    servers: db.servers.map((s) => ({ id: s.id, name: s.name, m: Math.round(out.servers[s.id] || 0) })),
    clients: top(out.clients, 10).map(([id, m]) => { const c = db.clients.find((x) => x.id === Number(id)); return { id: Number(id), name: c ? c.panelName : 'Cuenta eliminada', emby: c ? c.embyName : '', owner: c ? (db.users.find((u) => u.id === c.ownerId) || {}).name || '' : '', m: Math.round(m) }; }),
    apps: top(out.apps, 8).map(([name, m]) => ({ name, m: Math.round(m) })),
  };
});

/* ---------- Informe de ingresos ---------- */
route('GET', '/api/income', STAFF, ({ req }) => {
  const q = new URL(req.url, 'http://x').searchParams, n = Math.min(24, Math.max(1, Number(q.get('months')) || 12));
  const t = today(), months = [];
  for (let i = n - 1; i >= 0; i--) months.push(addMonths(t.slice(0, 7) + '-01', -i).slice(0, 7));
  const first = months[0];
  const row = () => ({ sold: 0, money: 0, spent: 0, alta: 0, renovacion: 0, demo: 0, cobros: 0 });
  const byMonth = Object.fromEntries(months.map((m) => [m, row()])), byUser = new Map();
  const ur = (id) => { if (!byUser.has(id)) byUser.set(id, row()); return byUser.get(id); };
  const price = (u) => (u && u.creditPrice) || db.settings.creditPrice || 0;
  const staffIds = new Set(db.users.filter((u) => isStaff(u)).map((u) => u.id));
  for (const l of db.ledger) {
    const m = localDate(new Date(l.ts)).slice(0, 7);
    if (m < first) break;
    const bm = byMonth[m]; if (!bm) continue;
    const u = db.users.find((x) => x.id === l.userId);
    // Creditos vendidos: los que el equipo (super o administradores) pasa o recarga a un vendedor
    if (l.kind === 'credito' && l.delta > 0 && (l.byId == null || staffIds.has(l.byId)) && u && !isStaff(u)) {
      const eur = l.paid ? l.paid.amount : l.delta * price(u); // compras online: lo pagado de verdad
      bm.sold += l.delta; bm.money += eur;
      const r = ur(l.userId); r.sold += l.delta; r.money += eur;
    }
    if ((l.kind === 'alta' || l.kind === 'renovacion') && l.delta < 0) { bm.spent -= l.delta; ur(l.userId).spent -= l.delta; }
    if (l.kind === 'devolucion' && l.delta > 0) { bm.spent -= l.delta; ur(l.userId).spent -= l.delta; }
  }
  for (const l of db.log) {
    const m = localDate(new Date(l.ts)).slice(0, 7);
    if (m < first) break;
    const bm = byMonth[m]; if (!bm) continue;
    if (['alta', 'renovacion', 'demo', 'cobro'].includes(l.type)) {
      const k = l.type === 'cobro' ? 'cobros' : l.type;
      bm[k]++;
      if (l.ownerId != null) ur(l.ownerId)[k]++;
    }
  }
  const pending = db.clients.filter((c) => c.paid === false && c.status !== 'trash');
  const vendors = db.users.map((u) => {
    const r = byUser.get(u.id) || row();
    return { id: u.id, name: u.name, role: u.role, credits: u.credits || 0, price: price(u), ...r, money: Math.round(r.money * 100) / 100, pending: pending.filter((c) => c.ownerId === u.id).length,
      clients: db.clients.filter((c) => c.ownerId === u.id && c.status !== 'trash' && !c.demo).length };
  }).filter((v) => v.sold || v.alta || v.renovacion || v.spent || v.pending || v.clients).sort((a, b) => b.money - a.money || (b.alta + b.renovacion) - (a.alta + a.renovacion));
  return { months: months.map((m) => ({ m, ...byMonth[m], money: Math.round(byMonth[m].money * 100) / 100 })), vendors, pending: pending.length, currency: db.settings.currency || 'EUR',
    keep: { log: db.settings.retention.logDays, ledger: db.settings.retention.ledgerDays } };
});

/* ---------- Compra de créditos online: Stripe (tarjeta) y NOWPayments (cripto) ---------- */
const STRIPE_API = process.env.STRIPE_API || 'https://api.stripe.com';
const NOWPAY_API = process.env.NOWPAY_API || 'https://api.nowpayments.io';
const buyerPrice = (u) => Number(u.creditPrice || db.settings.creditPrice || 0);
const canBuy = (u) => (u.role === 'reseller' || u.role === 'sub') && !u.disabled;
function panelBase(req) {
  const fixed = (db.settings.brand.url || '').replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
async function stripeCall(method, p, form) {
  const key = db.payCfg.stripe.key;
  let res;
  try { res = await fetch(STRIPE_API + p, { method, headers: { Authorization: `Bearer ${key}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(20000) }); }
  catch { throw new HttpError(502, 'No se pudo conectar con Stripe.'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Stripe: ${(j.error && j.error.message) || res.status}`);
  return j;
}
async function nowpayCall(method, p, body) {
  let res;
  try { res = await fetch(NOWPAY_API + p, { method, headers: { 'x-api-key': db.payCfg.nowpay.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); }
  catch { throw new HttpError(502, 'No se pudo conectar con NOWPayments.'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `NOWPayments: ${j.message || res.status}`);
  return j;
}
const pubOrder = (o) => ({ id: o.id, userId: o.userId, user: o.user, credits: o.credits, amount: o.amount, currency: o.currency, method: o.method, status: o.status, created: o.created, paidAt: o.paidAt || null, pack: o.pack || '' });
/** Pedido pagado: suma los creditos una sola vez y avisa */
function markPaid(o, via) {
  if (o.status === 'paid') return false;
  const u = db.users.find((x) => x.id === o.userId);
  if (!u) { o.status = 'failed'; o.note = 'El usuario ya no existe'; return false; }
  o.status = 'paid'; o.paidAt = new Date().toISOString();
  u.credits += o.credits;
  const how = o.method === 'stripe' ? 'tarjeta' : 'criptomonedas';
  addLedger(u, o.credits, `Compra online con ${how}${o.pack ? ' (' + o.pack + ')' : ''}: ${o.amount.toFixed(2)} ${o.currency}`, null, 'credito', { amount: o.amount, currency: o.currency, method: o.method, order: o.id });
  addLog('cobro', null, `${u.name} compró ${o.credits} créditos con ${how} por ${o.amount.toFixed(2)} ${o.currency} (pedido ${o.id}${via ? ', ' + via : ''})`, null);
  db.vpay.unshift({ id: crypto.randomBytes(5).toString('hex'), at: o.paidAt, userId: u.id, user: u.name, credits: o.credits, amount: o.amount, method: o.method === 'stripe' ? 'Tarjeta (online)' : 'Cripto (online)', ref: o.id, status: 'paid', paidAt: o.paidAt, by: 'Compra online', byId: null, online: true });
  notifyStaff('payments', `💰 ${u.name} ha comprado ${o.credits} créditos con ${how}.\nImporte: ${o.amount.toFixed(2)} ${o.currency}\nSaldo nuevo: ${u.credits}\n${whenTxt()}`);
  notifyUser(u, `✅ Pago recibido: se han sumado ${o.credits} créditos a tu cuenta. Saldo: ${u.credits}.`);
  return true;
}
route('GET', '/api/pay', '*', ({ me }) => {
  const c = db.payCfg, price = buyerPrice(me), cur = db.settings.currency || 'EUR';
  const methods = [c.stripe.on && c.stripe.key ? 'stripe' : null, c.nowpay.on && c.nowpay.key ? 'nowpay' : null].filter(Boolean);
  const mine = db.orders.filter((o) => o.userId === me.id).slice(0, 30).map(pubOrder);
  const out = { canBuy: canBuy(me), methods, price, currency: cur, min: c.min, packs: (db.settings.creditPacks || []).map((p, i) => ({ i, name: p.name, credits: p.credits, amount: Math.round(p.credits * price * 100) / 100 })), orders: mine };
  if (me.role === 'super') {
    out.cfg = { stripe: { on: c.stripe.on, hasKey: !!c.stripe.key, test: /^sk_test_/.test(c.stripe.key), hasWh: !!c.stripe.whsec }, nowpay: { on: c.nowpay.on, hasKey: !!c.nowpay.key, hasIpn: !!c.nowpay.ipn }, min: c.min };
    out.all = db.orders.slice(0, 100).map(pubOrder);
  }
  return out;
});
route('PUT', '/api/pay/config', SUPER, async ({ me, body }) => {
  const c = db.payCfg;
  if (body.stripe) {
    const k = str(body.stripe.key, 200), w = str(body.stripe.whsec, 200);
    if (k) { if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(k)) throw new HttpError(400, 'La clave de Stripe debe empezar por sk_live_ (o sk_test_ para pruebas).'); const old = c.stripe.key; c.stripe.key = k; try { await stripeCall('GET', '/v1/balance'); } catch (e) { c.stripe.key = old; throw new HttpError(400, 'Stripe no acepta esa clave: ' + e.message); } }
    if (w) { if (!/^whsec_[A-Za-z0-9]{10,}$/.test(w)) throw new HttpError(400, 'El secreto del webhook empieza por whsec_'); c.stripe.whsec = w; }
    if (body.stripe.remove) { c.stripe = { on: false, key: '', whsec: '' }; }
    else if (body.stripe.on !== undefined) { if (body.stripe.on && !c.stripe.key) throw new HttpError(400, 'Primero pega la clave secreta de Stripe.'); c.stripe.on = !!body.stripe.on; }
  }
  if (body.nowpay) {
    const k = str(body.nowpay.key, 200), ipn = str(body.nowpay.ipn, 200);
    if (k) { const old = c.nowpay.key; c.nowpay.key = k; try { await nowpayCall('GET', '/v1/merchant/coins'); } catch (e) { c.nowpay.key = old; throw new HttpError(400, 'NOWPayments no acepta esa clave: ' + e.message); } }
    if (ipn) c.nowpay.ipn = ipn;
    if (body.nowpay.remove) { c.nowpay = { on: false, key: '', ipn: '' }; }
    else if (body.nowpay.on !== undefined) { if (body.nowpay.on && (!c.nowpay.key || !c.nowpay.ipn)) throw new HttpError(400, 'Faltan la clave API y el secreto IPN de NOWPayments.'); c.nowpay.on = !!body.nowpay.on; }
  }
  const m = Number(body.min);
  if (Number.isInteger(m) && m >= 1 && m <= 100000) c.min = m;
  await lock(async () => { addLog('ajustes', null, `Pagos online: tarjeta ${c.stripe.on ? 'activada' : 'desactivada'}, cripto ${c.nowpay.on ? 'activada' : 'desactivada'}`, me); saveDb(); });
  return { ok: true };
});
route('POST', '/api/pay/checkout', '*', async ({ me, body, req }) => {
  if (!canBuy(me)) throw new HttpError(403, 'Solo los resellers y subresellers compran créditos aquí.');
  const c = db.payCfg, method = body.method === 'nowpay' ? 'nowpay' : 'stripe';
  if (method === 'stripe' && !(c.stripe.on && c.stripe.key)) throw new HttpError(400, 'El pago con tarjeta no está activado.');
  if (method === 'nowpay' && !(c.nowpay.on && c.nowpay.key)) throw new HttpError(400, 'El pago con criptomonedas no está activado.');
  const packs = db.settings.creditPacks || [];
  let credits, packName = '';
  if (body.pack !== undefined && body.pack !== null && body.pack !== '') { const p = packs[Number(body.pack)]; if (!p) throw new HttpError(400, 'Ese paquete ya no existe.'); credits = p.credits; packName = p.name; }
  else { credits = Number(body.credits); if (!Number.isInteger(credits) || credits < c.min || credits > 100000) throw new HttpError(400, `Elige entre ${c.min} y 100000 créditos.`); }
  const price = buyerPrice(me), cur = (db.settings.currency || 'EUR').toUpperCase();
  if (!price) throw new HttpError(400, 'Tu precio por crédito no está configurado. Avisa al administrador.');
  const amount = Math.round(credits * price * 100) / 100;
  if (method === 'stripe' && amount < 0.5) throw new HttpError(400, 'El importe mínimo para pagar con tarjeta es 0,50.');
  // No mas de 5 pedidos sin pagar a la vez por usuario
  const open = db.orders.filter((o) => o.userId === me.id && o.status === 'pending' && Date.now() - Date.parse(o.created) < 3600000);
  if (open.length >= 5) throw new HttpError(429, 'Tienes varios pagos sin terminar. Espera un poco o termínalos.');
  const o = { id: 'P' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase(), userId: me.id, user: me.name, credits, amount, currency: cur, method, status: 'pending', created: new Date().toISOString(), pack: packName };
  const base = panelBase(req), back = `${base}/?pago=`;
  const desc = `${credits} créditos · ${db.settings.brand.name || 'Concha'}`;
  if (method === 'stripe') {
    const ss = await stripeCall('POST', '/v1/checkout/sessions', {
      mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': cur.toLowerCase(), 'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
      'line_items[0][price_data][product_data][name]': desc, client_reference_id: o.id, 'metadata[order]': o.id, 'metadata[user]': String(me.id),
      success_url: `${back}ok&o=${o.id}`, cancel_url: `${back}cancelado&o=${o.id}`,
    });
    o.extId = ss.id; o.url = ss.url;
  } else {
    const inv = await nowpayCall('POST', '/v1/invoice', { price_amount: amount, price_currency: cur.toLowerCase(), order_id: o.id, order_description: desc, ipn_callback_url: `${base}/api/pay/nowpayments/ipn`, success_url: `${back}ok&o=${o.id}`, cancel_url: `${back}cancelado&o=${o.id}` });
    o.extId = String(inv.id); o.url = inv.invoice_url;
  }
  await lock(async () => { db.orders.unshift(o); if (db.orders.length > 3000) db.orders.length = 3000; saveDb(); });
  return { url: o.url, order: o.id };
});
/* Al volver de pagar: se pregunta a Stripe por si el aviso (webhook) aun no ha llegado */
route('GET', '/api/pay/orders/:id', '*', async ({ me, params }) => {
  const o = db.orders.find((x) => x.id === params.id);
  if (!o || (o.userId !== me.id && me.role !== 'super')) throw new HttpError(404, 'Ese pedido no existe.');
  if (o.status === 'pending' && o.method === 'stripe' && o.extId && db.payCfg.stripe.key) {
    try {
      const ss = await stripeCall('GET', `/v1/checkout/sessions/${encodeURIComponent(o.extId)}`);
      if (ss.payment_status === 'paid' && ss.amount_total === Math.round(o.amount * 100) && String(ss.currency).toUpperCase() === o.currency) await lock(async () => { if (markPaid(o, 'comprobado al volver')) saveDb(); });
      else if (ss.status === 'expired') await lock(async () => { o.status = 'expired'; saveDb(); });
    } catch { /* se vuelve a mirar luego */ }
  }
  return pubOrder(o);
});
/** Avisos de las pasarelas (llegan sin sesion; se comprueba la firma) */
async function payWebhook(req, res, pathname) {
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 1e6) { res.writeHead(413); return res.end(); } chunks.push(ch); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ok = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"received":true}'); };
  const bad = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
  if (pathname === '/api/pay/stripe/webhook') {
    const wh = db.payCfg.stripe.whsec;
    if (!wh) return bad(400, 'webhook sin configurar');
    const sig = String(req.headers['stripe-signature'] || ''), t = (/t=(\d+)/.exec(sig) || [])[1], v1s = [...sig.matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1]);
    if (!t || !v1s.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return bad(400, 'firma');
    const expect = crypto.createHmac('sha256', wh).update(`${t}.${raw}`).digest('hex');
    if (!v1s.some((v) => v.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)))) return bad(400, 'firma');
    let ev; try { ev = JSON.parse(raw); } catch { return bad(400, 'json'); }
    const ss = ev.data && ev.data.object;
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      const o = db.orders.find((x) => x.method === 'stripe' && x.extId === (ss && ss.id));
      if (o && ss.payment_status === 'paid' && ss.amount_total === Math.round(o.amount * 100) && String(ss.currency).toUpperCase() === o.currency) await lock(async () => { if (markPaid(o, 'aviso de Stripe')) saveDb(); });
    }
    if (ev.type === 'checkout.session.expired') { const o = db.orders.find((x) => x.method === 'stripe' && x.extId === (ss && ss.id)); if (o && o.status === 'pending') await lock(async () => { o.status = 'expired'; saveDb(); }); }
    return ok();
  }
  if (pathname === '/api/pay/nowpayments/ipn') {
    const secret = db.payCfg.nowpay.ipn;
    if (!secret) return bad(400, 'ipn sin configurar');
    let data; try { data = JSON.parse(raw); } catch { return bad(400, 'json'); }
    const sortObj = (x) => (Array.isArray(x) ? x.map(sortObj) : x && typeof x === 'object' ? Object.keys(x).sort().reduce((a, k) => { a[k] = sortObj(x[k]); return a; }, {}) : x);
    const expect = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObj(data))).digest('hex');
    const got = String(req.headers['x-nowpayments-sig'] || '');
    if (got.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect))) return bad(400, 'firma');
    const o = db.orders.find((x) => x.method === 'nowpay' && x.id === String(data.order_id || ''));
    if (o && data.payment_status === 'finished') {
      const paid = Number(data.price_amount), cur = String(data.price_currency || '').toUpperCase();
      if (Math.abs(paid - o.amount) < 0.01 && cur === o.currency) await lock(async () => { if (markPaid(o, 'aviso de NOWPayments')) saveDb(); });
    } else if (o && ['failed', 'expired', 'refunded'].includes(data.payment_status) && o.status === 'pending') await lock(async () => { o.status = data.payment_status === 'refunded' ? 'failed' : data.payment_status; saveDb(); });
    else if (o && data.payment_status === 'partially_paid') await lock(async () => { o.note = 'Pago incompleto'; saveDb(); notifyStaff('payments', `⚠️ ${o.user} ha pagado solo una parte del pedido ${o.id} con cripto. Revísalo en NOWPayments.`); });
    return ok();
  }
  return bad(404, 'no');
}

/* ---------- Copias de seguridad cifradas (descarga, Telegram y restaurar) ---------- */
const BK_MAGIC = 'concha-copia';
function bkKey(password, salt) { return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }); }
/** Cifra la base de datos con AES-256-GCM: sin la contraseña no se puede leer */
function encryptBackup(json, key, salt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(json))), c.final()]);
  return Buffer.from(JSON.stringify({ app: BK_MAGIC, v: 1, at: new Date().toISOString(), panel: db.settings.brand.name || 'Concha', salt, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }));
}
function decryptBackup(text, password) {
  let o;
  try { o = JSON.parse(text); } catch { throw new HttpError(400, 'Ese archivo no es una copia del panel.'); }
  if (!o || o.app !== BK_MAGIC || !o.salt || !o.data) throw new HttpError(400, 'Ese archivo no es una copia del panel.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', bkKey(password, o.salt), Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.tag, 'base64'));
    return { at: o.at, json: zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()])).toString('utf8') };
  } catch { throw new HttpError(400, 'La contraseña de la copia no es correcta (o el archivo está dañado).'); }
}
const bkName = () => `copia-${(db.settings.brand.name || 'concha').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${today()}.concha`;
function localCopies() {
  try { return fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().map((f) => ({ name: f, date: f.slice(3, 13), size: fs.statSync(path.join(BACKUP_DIR, f)).size })); }
  catch { return []; }
}
route('GET', '/api/backup', SUPER, ({ me }) => {
  const c = db.backupCfg, cfg = db.settings.notices.telegram;
  const g = c.gdrive;
  return { copies: localCopies(), cfg: { on: c.on, hour: c.hour, last: c.last, lastError: c.lastError, hasKey: !!c.key }, gdrive: { on: g.on, hasUrl: !!g.url, last: g.last, lastError: g.lastError }, tgLinked: !!me.tgChat, bot: cfg.token ? cfg.bot : '', size: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0 };
});
route('POST', '/api/backup/download', SUPER, ({ me, body }) => {
  const pw = typeof body.password === 'string' ? body.password : '';
  if (pw.length < 8) throw new HttpError(400, 'La contraseña de la copia necesita al menos 8 caracteres.');
  let json;
  if (body.name) {
    if (!/^db-\d{4}-\d{2}-\d{2}\.json$/.test(body.name)) throw new HttpError(400, 'Copia no válida.');
    const f = path.join(BACKUP_DIR, body.name);
    if (!fs.existsSync(f)) throw new HttpError(404, 'Esa copia ya no existe.');
    json = fs.readFileSync(f, 'utf8');
    try { const d = JSON.parse(json); openApiKeys(d.servers); json = JSON.stringify(d); } catch { /* se manda tal cual */ }
  } else json = JSON.stringify(db);
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = encryptBackup(json, bkKey(pw, salt), salt);
  addLog('seguridad', null, `Copia de seguridad descargada${body.name ? ' (' + body.name.slice(3, 13) + ')' : ''}`, me); saveDb();
  return { __raw: buf, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${body.name ? bkName().replace(today(), body.name.slice(3, 13)) : bkName()}"`, 'Cache-Control': 'no-store' } };
});
route('PUT', '/api/backup/config', SUPER, ({ me, body }) => lock(async () => {
  const c = db.backupCfg;
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 10) throw new HttpError(400, 'Para las copias automáticas usa una contraseña de al menos 10 caracteres.');
    c.salt = crypto.randomBytes(16).toString('hex');
    c.key = bkKey(body.password, c.salt).toString('hex'); // se guarda la llave derivada, nunca la contraseña
  }
  const h = Number(body.hour);
  if (Number.isInteger(h) && h >= 0 && h <= 23) c.hour = h;
  if (body.on !== undefined) {
    if (body.on && !c.key) throw new HttpError(400, 'Elige primero la contraseña con la que se cifrarán las copias.');
    c.on = !!body.on;
  }
  addLog('ajustes', null, `Copia diaria por Telegram ${c.on ? 'activada a las ' + pad(c.hour) + ':00' : 'desactivada'}`, me);
  saveDb();
  return { ok: true };
}));
/** Envia la copia cifrada por Telegram a los superadministradores enlazados */
async function sendBackupTelegram() {
  const c = db.backupCfg, cfg = db.settings.notices.telegram;
  if (!c.key || !cfg.token) throw new Error('Falta la contraseña de las copias o el bot de Telegram.');
  const to = db.users.filter((u) => u.role === 'super' && u.tgChat && (u.secAlerts || {}).backup !== false);
  if (!to.length) throw new Error('Enlaza tu Telegram en Ajustes › Seguridad para recibir la copia.');
  const buf = encryptBackup(JSON.stringify(db), Buffer.from(c.key, 'hex'), c.salt);
  if (buf.length > 45e6) throw new Error('La copia pesa demasiado para Telegram (más de 45 MB).');
  for (const u of to) {
    const form = new FormData();
    form.append('chat_id', String(u.tgChat));
    form.append('caption', `💾 Copia de seguridad de ${db.settings.brand.name || 'Concha'} · ${whenTxt()}\nCifrada con tu contraseña de copias. Para recuperarla: Ajustes › Copias de seguridad › Restaurar.`);
    form.append('document', new Blob([buf], { type: 'application/octet-stream' }), bkName());
    const res = await fetch(`${TG_API}/bot${cfg.token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram no aceptó la copia: ${j.description || res.status}`);
  }
  return to.length;
}
route('POST', '/api/backup/send', SUPER, async ({ me }) => {
  try { await sendBackupTelegram(); } catch (e) { throw new HttpError(400, e.message); }
  await lock(async () => { db.backupCfg.last = new Date().toISOString(); db.backupCfg.lastError = ''; addLog('seguridad', null, 'Copia de seguridad enviada por Telegram', me); saveDb(); });
  return { ok: true };
});
/* Copia diaria a Google Drive: el panel la deja en un "buzón" (Apps Script) de la cuenta de Google del superadministrador */
const GDRIVE_RE = process.env.GDRIVE_TEST ? /^https?:\/\// : /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
async function gdriveCall(url, secret, payload) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ clave: secret, ...payload }), redirect: 'follow', signal: AbortSignal.timeout(180000) }); }
  catch { throw new Error('No se pudo conectar con Google. Revisa la dirección del buzón.'); }
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { throw new Error(/<html/i.test(txt) ? 'Google no deja usar el buzón: en «Quién tiene acceso» elige «Cualquier usuario» y vuelve a implementarlo.' : `Google respondió: ${res.status}`); }
  if (!j.ok) throw new Error(j.error === 'Clave incorrecta' ? 'La clave no coincide con la del código del buzón (línea CLAVE).' : `Google Drive: ${j.error || 'error'}`);
  return j;
}
async function sendBackupDrive() {
  const c = db.backupCfg, g = c.gdrive;
  if (!c.key) throw new Error('Falta la contraseña de las copias.');
  if (!g.url || !g.secret) throw new Error('Falta la dirección o la clave del buzón de Google Drive.');
  const buf = encryptBackup(JSON.stringify(db), Buffer.from(c.key, 'hex'), c.salt);
  if (buf.length > 35e6) throw new Error('La copia pesa demasiado para el buzón de Google (más de 35 MB).');
  await gdriveCall(g.url, g.secret, { nombre: bkName(), datos: buf.toString('base64') });
}
route('PUT', '/api/backup/gdrive', SUPER, async ({ me, body }) => {
  const c = db.backupCfg, g = c.gdrive;
  if (body.remove) { c.gdrive = { on: false, url: '', secret: '', last: null, lastError: '' }; await lock(async () => saveDb()); return { ok: true }; }
  const url = str(body.url, 300), secret = str(body.secret, 200);
  if (url && !GDRIVE_RE.test(url)) throw new HttpError(400, 'La dirección debe ser la «URL de la aplicación web» de Apps Script: empieza por https://script.google.com/macros/s/ y acaba en /exec');
  if (secret && secret.length < 10) throw new HttpError(400, 'La clave del buzón es demasiado corta: usa al menos 10 caracteres (la misma que pusiste en el código).');
  const nu = url || g.url, ns = secret || g.secret;
  if (!nu || !ns) throw new HttpError(400, 'Pega la dirección del buzón y su clave.');
  let folder;
  try { folder = (await gdriveCall(nu, ns, { prueba: true })).carpeta; } catch (e) { throw new HttpError(400, e.message); }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 10) throw new HttpError(400, 'Para las copias automáticas usa una contraseña de al menos 10 caracteres.');
    c.salt = crypto.randomBytes(16).toString('hex'); c.key = bkKey(body.password, c.salt).toString('hex');
  }
  if (!c.key) throw new HttpError(400, 'Elige la contraseña con la que se cifrarán las copias.');
  const h = Number(body.hour); if (Number.isInteger(h) && h >= 0 && h <= 23) c.hour = h;
  c.gdrive = { ...g, url: nu, secret: ns, on: true, lastError: '' };
  await lock(async () => { addLog('ajustes', null, `Copia diaria a Google Drive activada a las ${pad(c.hour)}:00`, me); saveDb(); });
  return { ok: true, folder };
});
route('POST', '/api/backup/gdrive/off', SUPER, ({ me }) => lock(async () => { db.backupCfg.gdrive.on = false; addLog('ajustes', null, 'Copia diaria a Google Drive desactivada', me); saveDb(); return { ok: true }; }));
route('POST', '/api/backup/gdrive/send', SUPER, async ({ me }) => {
  try { await sendBackupDrive(); } catch (e) { throw new HttpError(400, e.message); }
  await lock(async () => { db.backupCfg.gdrive.last = new Date().toISOString(); db.backupCfg.gdrive.lastError = ''; addLog('seguridad', null, 'Copia de seguridad enviada a Google Drive', me); saveDb(); });
  return { ok: true };
});
/* Comprobar una copia: abre el archivo con su contraseña y dice qué lleva, sin restaurar nada */
route('POST', '/api/backup/verify', SUPER, ({ body }) => {
  const { at, json } = decryptBackup(String(body.content || ''), typeof body.password === 'string' ? body.password : '');
  let d; try { d = JSON.parse(json); } catch { throw new HttpError(400, 'La copia está dañada.'); }
  const cl = Array.isArray(d.clients) ? d.clients : [];
  return { ok: true, at, clients: cl.filter((c) => !c.demo && c.status !== 'trash').length, demos: cl.filter((c) => c.demo).length, trash: cl.filter((c) => c.status === 'trash').length,
    users: Array.isArray(d.users) ? d.users.length : 0, servers: Array.isArray(d.servers) ? d.servers.map((x) => x.name) : [], panel: (d.settings && d.settings.brand && d.settings.brand.name) || '' };
});
let bkBusy = false;
async function backupJob() {
  const c = db.backupCfg, g = c.gdrive;
  if ((!c.on && !g.on) || !c.key || bkBusy) return;
  const now = new Date(), localH = Number(now.toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', hour12: false }));
  if (localH < c.hour) return;
  const due = (last, tryAt) => !(last && localDate(new Date(last)) === today()) && !(tryAt && Date.now() - tryAt < 30 * 60000); // si falla, se reintenta cada media hora
  const doTg = c.on && due(c.last, c.lastTry), doGd = g.on && due(g.last, g.lastTry);
  if (!doTg && !doGd) return;
  bkBusy = true;
  try {
    if (doTg) {
      c.lastTry = Date.now();
      try { await sendBackupTelegram(); c.last = new Date().toISOString(); c.lastError = ''; addLog('seguridad', null, 'Copia de seguridad diaria enviada por Telegram', null); }
      catch (e) { c.lastError = e.message; console.error('Copia por Telegram:', e.message); }
    }
    if (doGd) {
      g.lastTry = Date.now();
      try { await sendBackupDrive(); g.last = new Date().toISOString(); g.lastError = ''; addLog('seguridad', null, 'Copia de seguridad diaria enviada a Google Drive', null); }
      catch (e) { g.lastError = e.message; console.error('Copia a Google Drive:', e.message); notifyStaff('backup', `⚠️ No se pudo guardar la copia diaria en Google Drive: ${e.message}`); }
    }
  } finally { bkBusy = false; lock(async () => saveDb()).catch(() => {}); }
}
route('POST', '/api/backup/restore', SUPER, ({ me, body, req }) => lock(async () => {
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!checkPassword(me, typeof body.mine === 'string' ? body.mine : '')) throw new HttpError(400, 'Tu contraseña del panel no es correcta.');
  const { at, json } = decryptBackup(String(body.content || ''), pw);
  let data;
  try { data = JSON.parse(json); } catch { throw new HttpError(400, 'La copia está dañada.'); }
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.clients) || !data.users.some((u) => u.role === 'super')) throw new HttpError(400, 'La copia no tiene datos del panel válidos.');
  // Antes de nada, se guarda lo que hay ahora por si hay que volver atrás
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, `antes-de-restaurar-${Date.now()}.json`), JSON.stringify(dbForDisk()));
  openApiKeys(data.servers);
  db = data; saveDb(); // se escribe ya con las API keys cifradas
  loadDb();
  sessions.clear();
  addLog('seguridad', null, `Panel restaurado desde una copia del ${String(at || '').slice(0, 10)} por ${me.username}`, null);
  saveDb();
  return { ok: true, at };
}));

/* ---------- Seguridad de cada usuario: verificacion en dos pasos, Telegram, sesiones ---------- */
route('GET', '/api/security', '*', ({ me, req }) => {
  const tok = sessionToken(req), cfg = db.settings.notices.telegram;
  const list = [...sessions.entries()].filter(([, v]) => v.userId === me.id && v.exp > Date.now())
    .map(([k, v]) => ({ sid: v.sid, current: k === tok, created: new Date(v.created || Date.now()).toISOString(), seen: new Date(v.seen || v.created || Date.now()).toISOString(), ip: v.ip || '', ua: v.ua || '' }))
    .sort((a, b) => b.current - a.current || b.seen.localeCompare(a.seen));
  const al = me.secAlerts || {};
  return {
    twoFa: !!(me.totp && me.totp.on), codesLeft: me.totp && me.totp.on ? (me.totp.codes || []).length : 0,
    bot: cfg.token ? cfg.bot || '' : '', tgLinked: !!me.tgChat, tgLink: cfg.token && cfg.bot ? `https://t.me/${cfg.bot}?start=${userTgCode(me)}` : '',
    alerts: { login: al.login !== false, credits: me.role === 'super' ? al.credits !== false : false, sabotage: me.role === 'super' ? al.sabotage !== false : al.sabotage === true, daily: me.role === 'super' ? al.daily !== false : al.daily === true, quality: me.role === 'super' ? al.quality !== false : al.quality === true, servers: me.role === 'super' ? al.servers !== false : al.servers === true, staffLogins: me.role === 'super' ? al.staffLogins !== false : false, backup: me.role === 'super' ? al.backup !== false : false, payments: me.role === 'super' ? al.payments !== false : false },
    sessions: list, idleMin: db.settings.security.idleMin,
  };
});
route('POST', '/api/security/totp/start', '*', ({ me }) => lock(async () => {
  if (me.totp && me.totp.on) throw new HttpError(400, 'Ya tienes activada la verificación en dos pasos.');
  const secret = b32enc(crypto.randomBytes(20));
  me.totpPending = { secret, exp: Date.now() + 15 * 60000 };
  const issuer = (db.settings.brand.name || 'Concha').replace(/[:]/g, '');
  const uri = `otpauth://totp/${encodeURIComponent(issuer + ':' + me.username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qrSvg(uri) };
}));
route('POST', '/api/security/totp/enable', '*', ({ me, body }) => lock(async () => {
  const p = me.totpPending;
  if (!p || p.exp < Date.now()) throw new HttpError(400, 'Ha pasado demasiado tiempo. Pulsa otra vez «Activar».');
  const t = { secret: p.secret, on: true, last: 0, codes: [] };
  if (!checkTotp(t, body.code)) throw new HttpError(400, 'El código no coincide. Escribe el que sale ahora en la app (cambia cada 30 segundos).');
  me.totp = t; delete me.totpPending;
  const codes = newRecoveryCodes(me);
  addLog('seguridad', null, `${me.username} activó la verificación en dos pasos`, me);
  saveDb();
  notifyUser(me, `✅ Verificación en dos pasos activada en tu cuenta «${me.username}».`);
  return { ok: true, codes };
}));
route('POST', '/api/security/totp/disable', '*', ({ me, body }) => lock(async () => {
  if (!me.totp || !me.totp.on) return { ok: true };
  if (!checkPassword(me, typeof body.password === 'string' ? body.password : '')) throw new HttpError(400, 'La contraseña no es correcta.');
  if (!checkTotp(me.totp, body.code) && !useRecoveryCode(me, body.code || '')) throw new HttpError(400, 'El código no es correcto.');
  delete me.totp;
  addLog('seguridad', null, `${me.username} desactivó la verificación en dos pasos`, me);
  saveDb();
  notifyUser(me, `⚠️ Se ha DESACTIVADO la verificación en dos pasos de tu cuenta «${me.username}».\n${whenTxt()}\nSi no has sido tú, cambia la contraseña y avisa al superadministrador.`);
  return { ok: true };
}));
route('POST', '/api/security/totp/codes', '*', ({ me, body }) => lock(async () => {
  if (!me.totp || !me.totp.on) throw new HttpError(400, 'Primero activa la verificación en dos pasos.');
  if (!checkPassword(me, typeof body.password === 'string' ? body.password : '')) throw new HttpError(400, 'La contraseña no es correcta.');
  const codes = newRecoveryCodes(me);
  addLog('seguridad', null, `${me.username} generó códigos de rescate nuevos`, me);
  saveDb();
  return { codes };
}));
/* Quitar la verificacion a otro usuario que ha perdido el movil */
route('POST', '/api/users/:id/reset2fa', '*', ({ me, params }) => lock(async () => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes cambiar a ese usuario.');
  if (u.totp) { delete u.totp; dropSessions(u.id); addLog('seguridad', null, `Verificación en dos pasos quitada a ${u.username}`, me); saveDb(); }
  return { ok: true };
}));
route('PUT', '/api/security/alerts', '*', ({ me, body }) => lock(async () => {
  const al = me.secAlerts || {};
  for (const k of ['login', 'servers', 'staffLogins', 'backup', 'payments', 'quality', 'sabotage', 'daily', 'credits']) if (typeof body[k] === 'boolean') al[k] = body[k];
  me.secAlerts = al; saveDb();
  return { ok: true };
}));
route('POST', '/api/security/tg/test', '*', async ({ me }) => {
  if (!me.tgChat) throw new HttpError(400, 'Primero enlaza tu Telegram.');
  if (!(await notifyUser(me, `👋 Prueba: los avisos de seguridad del panel ${db.settings.brand.name || 'Concha'} te llegarán aquí.`))) throw new HttpError(502, 'Telegram no ha aceptado el mensaje. Revisa el bot en Ajustes › Notificaciones.');
  return { ok: true };
});
route('POST', '/api/security/tg/unlink', '*', ({ me }) => lock(async () => { delete me.tgChat; saveDb(); return { ok: true }; }));
route('POST', '/api/security/sessions/close', '*', ({ me, body, req }) => {
  const tok = sessionToken(req);
  let n = 0;
  for (const [k, v] of sessions) {
    if (v.userId !== me.id || k === tok) continue;
    if (body.all || v.sid === body.sid) { sessions.delete(k); n++; }
  }
  if (n) lock(async () => { addLog('seguridad', null, `${me.username} cerró ${n === 1 ? '1 sesión' : n + ' sesiones'} abiertas`, me); saveDb(); }).catch(() => {});
  return { ok: true, closed: n };
});
route('PUT', '/api/security/policy', SUPER, ({ me, body }) => lock(async () => {
  const n = Number(body.idleMin);
  if (!Number.isInteger(n) || n < 0 || n > 10080) throw new HttpError(400, 'El tiempo de inactividad debe estar entre 0 y 10080 minutos.');
  db.settings.security.idleMin = n;
  addLog('ajustes', null, n ? `Cierre de sesión por inactividad: ${n} min` : 'Cierre de sesión por inactividad desactivado', me);
  saveDb();
  return { ok: true };
}));

/* ---------- Monitor: reproducciones con carátula, calidad, consumo y acciones ---------- */
function videoInfo(x) {
  const it = x.NowPlayingItem || {}, tr = x.TranscodingInfo || null;
  const v = (it.MediaStreams || []).find((m) => m.Type === 'Video') || {};
  const w = v.Width || 0, h = v.Height || 0;
  const res = w >= 3200 || h >= 1800 ? '4K' : w >= 1800 || h >= 1000 ? '1080p' : w >= 1200 || h >= 700 ? '720p' : w || h ? 'SD' : '';
  // Bitrate del archivo (lo que informa Emby del original) y bitrate PEDIDO al codificador (no es una medida real)
  let srcBitrate = 0;
  if (it.Bitrate) srcBitrate = it.Bitrate;
  else if (Array.isArray(it.MediaSources) && it.MediaSources[0] && it.MediaSources[0].Bitrate) srcBitrate = it.MediaSources[0].Bitrate;
  else srcBitrate = (it.MediaStreams || []).reduce((n, m) => n + (m.BitRate || 0), 0);
  const encBitrate = tr && tr.Bitrate ? tr.Bitrate : 0;
  const bitrate = encBitrate || srcBitrate;
  // Pistas elegidas: audio y subtitulos que se estan usando
  const ps = x.PlayState || {}, streams = it.MediaStreams || [];
  const au = streams.find((m) => m.Type === 'Audio' && m.Index === ps.AudioStreamIndex) || streams.find((m) => m.Type === 'Audio' && m.IsDefault) || streams.find((m) => m.Type === 'Audio') || {};
  const sb = ps.SubtitleStreamIndex != null && ps.SubtitleStreamIndex >= 0 ? streams.find((m) => m.Type === 'Subtitle' && m.Index === ps.SubtitleStreamIndex) || null : null;
  const low = (v) => String(v || '').toLowerCase().slice(0, 20);
  const reasons = tr && Array.isArray(tr.TranscodeReasons) ? tr.TranscodeReasons.map(String) : [];
  const vRecoded = !!tr && tr.IsVideoDirect === false;
  return {
    width: w, height: h, res, codec: low(v.Codec), bitrate, srcBitrate, encBitrate,
    quality: qualityLoss({ vRecoded, reasons, srcBitrate, encBitrate, h, trH: tr ? tr.Height || 0 : 0, vBitrate: v.BitRate || 0 }),
    trCodec: tr ? low(tr.VideoCodec) : '', trWidth: tr ? tr.Width || 0 : 0, trHeight: tr ? tr.Height || 0 : 0,
    trReasons: tr && Array.isArray(tr.TranscodeReasons) ? tr.TranscodeReasons.map((r) => String(r).slice(0, 40)).slice(0, 6) : [],
    // Que se esta convirtiendo de verdad: el video, el audio o solo el formato del archivo
    trVideo: !!tr && tr.IsVideoDirect === false, trAudio: !!tr && tr.IsAudioDirect === false,
    audio: low(au.Codec), audioCh: au.Channels || 0, trAudioCodec: tr ? low(tr.AudioCodec) : '',
    subs: sb ? { codec: low(sb.Codec), text: sb.IsTextSubtitleStream !== false && !/pgs|dvd|vobsub|dvb/.test(low(sb.Codec)) } : null,
  };
}
/** Pérdida de calidad del VÍDEO, separada del método de reproducción.
    Una sesión «Transcode» que solo convierte el audio no pierde calidad de imagen. */
function qualityLoss({ vRecoded, reasons, srcBitrate, encBitrate, h, trH, vBitrate }) {
  if (!vRecoded) return { level: 'none', text: 'El vídeo llega sin recodificar' };
  const why = [];
  if (reasons.some((r) => /Bitrate/.test(r))) why.push('la app pide menos calidad que la del archivo');
  const ref = vBitrate || srcBitrate;
  if (encBitrate && ref && encBitrate < ref * 0.7) why.push('se pide al codificador bastante menos bitrate que el original');
  if (trH && h && trH < h * 0.9) why.push(`se reduce la resolución (${h}p → ${trH}p)`);
  if (why.length) return { level: 'likely', text: 'Probable pérdida de calidad: ' + why.join('; ') };
  return { level: 'possible', text: 'El vídeo se recodifica (por compatibilidad); no tiene por qué verse peor' };
}
/** Qué puede hacer el panel con esa reproducción, según lo que declara el aparato */
function sessionCaps(x) {
  const cmds = Array.isArray(x.SupportedCommands) ? x.SupportedCommands : null;
  return { canMsg: cmds ? cmds.includes('DisplayMessage') : true, remote: x.SupportsRemoteControl !== false, cmdsKnown: !!cmds };
}
const QUALITY_TEXT = 'Para ver el vídeo con la mejor calidad:\n1. Abre los Ajustes de Emby en este dispositivo.\n2. Busca Calidad de vídeo o Calidad remota.\n3. Elige la calidad máxima: el valor más alto que aparezca.\nDespués, vuelve a reproducir el vídeo.';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
route('GET', '/api/monitor', '*', async ({ me }) => {
  const vis = visibleOwners(me);
  const out = [], errors = [], servers = [];
  await Promise.all(db.servers.map(async (s) => {
    const cl = db.clients.filter((c) => c.serverId === s.id && c.status !== 'trash');
    const byEmby = new Map(cl.map((c) => [c.embyId, c]));
    try {
      const list = await emby(s, 'GET', '/Sessions');
      let n = 0;
      for (const x of list || []) {
        const it = x.NowPlayingItem;
        if (!it) continue;
        const c = byEmby.get(x.UserId);
        if (vis && (!c || !vis.has(c.ownerId))) continue;
        n++;
        const ps = x.PlayState || {}, vi = videoInfo(x);
        const ep = it.Type === 'Episode' && it.ParentIndexNumber != null && it.IndexNumber != null ? `T${it.ParentIndexNumber} · E${pad(it.IndexNumber)}` : '';
        const posterId = it.SeriesId && it.SeriesPrimaryImageTag ? it.SeriesId : (it.ImageTags && it.ImageTags.Primary ? it.Id : (it.SeriesId || it.Id || ''));
        out.push({
          id: String(x.Id || ''), serverId: s.id, server: s.name,
          user: x.UserName || '', client: c ? c.panelName : '', clientId: c ? c.id : null, demo: !!(c && c.demo),
          owner: c && isStaff(me) ? (db.users.find((u) => u.id === c.ownerId) || {}).name || '' : '',
          screens: c ? c.screens || 0 : 0, expires: c ? c.expires || '' : '',
          device: x.DeviceName || '', app: x.Client || '', version: x.ApplicationVersion || '',
          kind: it.Type === 'Episode' ? 'serie' : it.Type === 'Movie' ? 'pelicula' : (it.Type === 'TvChannel' ? 'tv' : 'otro'),
          title: it.Type === 'Episode' ? (it.SeriesName || it.Name || '') : (it.Name || ''),
          sub: it.Type === 'Episode' ? [ep, it.Name || ''].filter(Boolean).join(' – ') : '',
          year: it.ProductionYear || '',
          poster: posterId && ID_RE.test(String(posterId)) ? String(posterId) : '',
          itemId: String(it.Id || ''), ...sessionCaps(x),
          paused: !!ps.IsPaused, method: ps.PlayMethod || '', transcode: ps.PlayMethod === 'Transcode' || !!(x.TranscodingInfo && !x.TranscodingInfo.IsVideoDirect),
          position: ps.PositionTicks || 0, duration: it.RunTimeTicks || 0, ...vi,
        });
      }
      servers.push({ id: s.id, name: s.name, ok: true, n });
    } catch (e) {
      servers.push({ id: s.id, name: s.name, ok: false, n: 0 });
      errors.push(isStaff(me) ? e.message : 'No se pudo consultar un servidor.');
    }
  }));
  const nm = (x) => (x.client || x.user || '').toLowerCase();
  out.sort((a, b) => nm(a).localeCompare(nm(b), 'es') || a.user.localeCompare(b.user, 'es') || a.server.localeCompare(b.server, 'es') || a.device.localeCompare(b.device, 'es') || a.id.localeCompare(b.id));
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { sessions: out, servers, errors, at: new Date().toISOString() };
});

/* Carátulas: el panel las pide a Emby, así la API key nunca llega al navegador */
const posterCache = new Map(); // "server:item" -> { buf, type, at }
const posterMiss = new Map(); // "server:item" -> momento en que Emby dijo que no tiene
route('GET', '/api/poster/:sid/:item', '*', async ({ params }) => {
  const s = serverById(params.sid);
  if (!ID_RE.test(params.item)) throw new HttpError(400, 'Imagen no válida.');
  const key = s.id + ':' + params.item;
  const miss = posterMiss.get(key);
  if (miss && Date.now() - miss < 30 * 60000) throw new HttpError(404, 'Sin carátula.');
  let hit = posterCache.get(key);
  if (!hit || Date.now() - hit.at > 6 * 3600000) {
    let r;
    try {
      r = await fetch(`${s.url}/emby/Items/${params.item}/Images/Primary?maxHeight=330&quality=80`, { headers: { 'X-Emby-Token': s.apiKey }, signal: AbortSignal.timeout(15000) });
    } catch { throw new HttpError(502, 'Sin carátula.'); }
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) {
      posterMiss.set(key, Date.now());
      while (posterMiss.size > 2000) posterMiss.delete(posterMiss.keys().next().value);
      throw new HttpError(404, 'Sin carátula.');
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3e6) throw new HttpError(404, 'Sin carátula.');
    hit = { buf, type, at: Date.now() };
    posterCache.set(key, hit);
    while (posterCache.size > 400) posterCache.delete(posterCache.keys().next().value);
  }
  return { __raw: hit.buf, headers: { 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=21600', 'X-Content-Type-Options': 'nosniff' } };
});

/** Busca la reproducción y comprueba que la cuenta es del usuario (o que es del equipo) */
async function findSession(me, body) {
  const s = serverById(body.serverId);
  const sid = String(body.sessionId || '');
  if (!ID_RE.test(sid)) throw new HttpError(400, 'Reproducción no válida.');
  const list = await emby(s, 'GET', '/Sessions');
  const x = (list || []).find((y) => String(y.Id) === sid);
  if (!x || !x.NowPlayingItem) throw new HttpError(404, 'Esa reproducción ya ha terminado.');
  if (body.itemId && String(x.NowPlayingItem.Id) !== String(body.itemId)) throw new HttpError(409, 'Ese aparato ya está viendo otra cosa. Actualiza el monitor antes de actuar.');
  const c = db.clients.find((k) => k.serverId === s.id && k.embyId === x.UserId && k.status !== 'trash') || null;
  const vis = visibleOwners(me);
  if (vis && (!c || !vis.has(c.ownerId))) throw new HttpError(403, 'Esa reproducción no es de una cuenta tuya.');
  return { s, x, c };
}
route('POST', '/api/monitor/stop', '*', async ({ me, body }) => {
  const { s, x, c } = await findSession(me, body);
  const text = str(body.message, 300) || 'Tu reproducción ha sido detenida.';
  await stopSession(s, x, text); // Emby ha aceptado la orden…
  // …pero hay que mirar si el aparato la ha cumplido
  await new Promise((r) => setTimeout(r, Number(process.env.STOP_CHECK_MS) || 4000));
  let still = null;
  try { still = ((await emby(s, 'GET', '/Sessions')) || []).find((y) => String(y.Id) === String(x.Id) && y.NowPlayingItem && String(y.NowPlayingItem.Id) === String(x.NowPlayingItem.Id)); } catch { /* no se pudo comprobar */ }
  const stopped = !still;
  await lock(async () => { addLog('monitor', c, `${stopped ? 'Reproducción detenida' : 'Orden de detener enviada (el aparato siguió reproduciendo)'}: ${sessionTitle(x)} (${x.DeviceName || 'dispositivo'}, ${s.name})`, me); saveDb(); });
  return { ok: true, stopped, note: stopped ? 'Emby aceptó la orden y el aparato ha dejado de reproducir.' : `Emby aceptó la orden, pero el aparato sigue reproduciendo.${x.SupportsRemoteControl === false ? ' Este aparato no admite control remoto.' : ' Algunas apps ignoran esta orden.'}` };
});
route('POST', '/api/monitor/message', '*', async ({ me, body }) => {
  const { s, x, c } = await findSession(me, body);
  const text = str(body.text, 300);
  if (!text) throw new HttpError(400, 'Escribe el mensaje.');
  const header = str(body.header, 40) || db.settings.brand.name || 'Aviso';
  return sendScreenMsg(me, s, x, c, header, text, 15000);
});
/** Manda un mensaje a la pantalla. Se decide por los comandos que declara el aparato (DisplayMessage), no por SupportsRemoteControl */
async function sendScreenMsg(me, s, x, c, header, text, timeoutMs) {
  const caps = sessionCaps(x);
  if (!caps.canMsg) throw new HttpError(400, 'Este aparato no admite mensajes en pantalla (no declara DisplayMessage).');
  await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: header, Text: text, TimeoutMs: timeoutMs });
  await lock(async () => { addLog('monitor', c, `Mensaje en pantalla (${x.DeviceName || 'dispositivo'}): ${text.slice(0, 120)}`, me); saveDb(); });
  return { ok: true, note: 'Emby ha aceptado el mensaje. No podemos confirmar que el aparato lo haya mostrado: algunas apps no enseñan mensajes o los quitan antes.' };
}
/* Aviso de calidad baja, a mano: 120 segundos en pantalla (algunas apps lo quitan antes) */
route('POST', '/api/monitor/notice', '*', async ({ me, body }) => {
  const { s, x, c } = await findSession(me, body);
  const text = (db.settings.alerts.transcode.tipText || QUALITY_TEXT).slice(0, 400);
  return sendScreenMsg(me, s, x, c, 'Calidad de vídeo', text, 120000);
});


/* ======================================================================
   Calidad remota (Emby Quality Guard)
   Emby 4.9.3 añadió una opción por usuario para fijar su calidad remota automática.
   El panel solo la toca si el servidor devuelve el campo AutoRemoteQuality en la política del usuario:
   si no aparece, se informa y no se escribe nada. Unidad: bits por segundo (100 Mbps = 100.000.000).
   ====================================================================== */
const QF = 'AutoRemoteQuality';
const QUALITY_DIR = path.join(DATA_DIR, 'calidad');
const mbpsToBps = (m) => Math.round(Number(m) * 1e6);
const bpsToMbps = (b) => Math.round((Number(b) / 1e6) * 100) / 100;
function qCfg(sid) {
  const all = db.quality.servers;
  if (!all[sid]) all[sid] = { mbps: 100, auto: false, exclude: [], known: [] };
  const c = all[sid];
  if (!Array.isArray(c.exclude)) c.exclude = [];
  if (!Array.isArray(c.known)) c.known = [];
  if (!(c.mbps > 0)) c.mbps = 100;
  return c;
}
/** Limita cuantas tareas van a la vez */
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
/** Todos los usuarios de un servidor, por páginas. Si la versión de Emby no tiene /Users/Query, se usa /Users */
async function embyAllUsers(s) {
  const out = [], seen = new Set(), LIM = 200;
  let start = 0, paged = true;
  for (let guard = 0; guard < 500; guard++) {
    let r;
    try { r = await emby(s, 'GET', `/Users/Query?StartIndex=${start}&Limit=${LIM}`); }
    catch (e) { if (e.embyStatus === 404 && start === 0) { paged = false; r = { Items: (await emby(s, 'GET', '/Users')) || [] }; } else throw e; }
    const items = Array.isArray(r) ? r : (r && Array.isArray(r.Items) ? r.Items : []);
    for (const u of items) if (u && u.Id && !seen.has(u.Id)) { seen.add(u.Id); out.push(u); }
    if (!paged) break;
    const total = r && Number.isFinite(r.TotalRecordCount) ? r.TotalRecordCount : null;
    start += items.length;
    if (!items.length || (total != null && start >= total) || (total == null && items.length < LIM)) break;
  }
  // Si la lista no trae la política, se pide usuario a usuario (4 a la vez)
  const noPol = out.filter((u) => !u.Policy);
  if (noPol.length) await pool(noPol, 4, async (u) => { try { u.Policy = (await emby(s, 'GET', `/Users/${u.Id}`)).Policy || null; } catch { u.Policy = null; } });
  out.sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || ''), 'es'));
  return { users: out, paged };
}
/** Estado de cada usuario frente al objetivo */
function qStatus(u, cfg, bps) {
  const pol = u.Policy || null;
  if (!pol) return 'error';
  if (pol.IsAdministrator) return 'admin';
  if (cfg.exclude.includes(u.Id)) return 'excluido';
  if (!(QF in pol)) return 'nodisp';
  return Number(pol[QF]) === bps ? 'correcto' : 'pendiente';
}
async function qPreview(s) {
  const cfg = qCfg(s.id), bps = mbpsToBps(cfg.mbps);
  const panel = new Map(db.clients.filter((c) => c.serverId === s.id).map((c) => [c.embyId, c]));
  const { users, paged } = await embyAllUsers(s);
  const known = new Set(cfg.known);
  const rows = users.map((u) => {
    const pol = u.Policy || {}, st = qStatus(u, cfg, bps), has = QF in pol;
    return { id: u.Id, name: u.Name || '', admin: !!pol.IsAdministrator, panel: panel.has(u.Id) ? panel.get(u.Id).panelName : '',
      value: has ? Number(pol[QF]) : null, mbps: has ? bpsToMbps(pol[QF]) : null, status: st, isNew: cfg.known.length > 0 && !known.has(u.Id) };
  });
  const cnt = (k) => rows.filter((r) => r.status === k).length;
  return { id: s.id, name: s.name, ok: true, paged, mbps: cfg.mbps, bps, auto: !!cfg.auto, supported: rows.some((r) => r.value !== null),
    total: rows.length, counts: { pendiente: cnt('pendiente'), correcto: cnt('correcto'), excluido: cnt('excluido'), admin: cnt('admin'), nodisp: cnt('nodisp'), error: cnt('error') },
    nuevos: rows.filter((r) => r.isNew && r.status === 'pendiente').length, rows };
}
const qAllowed = (me) => { needPerm(me, 'servers'); };
route('GET', '/api/quality', STAFF, async ({ me, req }) => {
  qAllowed(me);
  const only = Number(new URL(req.url, 'http://x').searchParams.get('server')) || 0;
  const list = db.servers.filter((x) => !only || x.id === only);
  const servers = await Promise.all(list.map(async (x) => {
    try { return await qPreview(x); }
    catch (e) { const c = qCfg(x.id); return { id: x.id, name: x.name, ok: false, error: e.message, mbps: c.mbps, bps: mbpsToBps(c.mbps), auto: !!c.auto, rows: [], counts: {}, total: 0 }; }
  }));
  return { servers, job: qJobPublic(), guard: qGuard(), reports: db.quality.reports.map(({ rows, ...r }) => r).slice(0, 20) };
});
route('PUT', '/api/quality/server/:id', STAFF, ({ me, params, body }) => lock(async () => {
  qAllowed(me);
  const x = serverById(params.id), c = qCfg(x.id);
  if (body.mbps !== undefined) {
    const m = Number(body.mbps);
    if (!(m >= 1 && m <= 1000)) throw new HttpError(400, 'El objetivo debe estar entre 1 y 1000 Mbps.');
    c.mbps = Math.round(m * 100) / 100;
  }
  if (body.auto !== undefined) c.auto = !!body.auto;
  addLog('calidad', null, `Calidad remota de "${x.name}": objetivo ${c.mbps} Mbps${c.auto ? ', se aplica a cada cuenta nueva y renovación' : ''}`, me);
  saveDb();
  return { ok: true };
}));
route('POST', '/api/quality/exclude', STAFF, ({ me, body }) => lock(async () => {
  qAllowed(me);
  const x = serverById(body.serverId), c = qCfg(x.id), uid = String(body.userId || '');
  if (!ID_RE.test(uid)) throw new HttpError(400, 'Usuario no válido.');
  c.exclude = c.exclude.filter((v) => v !== uid);
  if (body.on) c.exclude.push(uid);
  saveDb();
  return { ok: true };
}));

/* Tarea en segundo plano: simular o aplicar */
let qJob = null; // { id, mode, by, at, total, done, phase, finished, error, reportId }
const qJobPublic = () => (qJob ? { id: qJob.id, mode: qJob.mode, total: qJob.total, done: qJob.done, phase: qJob.phase, finished: qJob.finished, error: qJob.error || '', reportId: qJob.reportId || null } : null);
route('GET', '/api/quality/job', STAFF, ({ me }) => { qAllowed(me); return { job: qJobPublic() }; });
route('POST', '/api/quality/run', STAFF, ({ me, body }) => {
  qAllowed(me);
  if (qJob && !qJob.finished) throw new HttpError(409, 'Ya hay una tarea de calidad en marcha. Espera a que termine.');
  const mode = body.mode === 'apply' ? 'apply' : 'simulate';
  const only = Number(body.serverId) || 0;
  const list = db.servers.filter((x) => !only || x.id === only);
  if (!list.length) throw new HttpError(400, 'No hay servidores que revisar.');
  qJob = { id: crypto.randomBytes(6).toString('hex'), mode, by: me, at: new Date().toISOString(), total: 0, done: 0, phase: 'Leyendo usuarios…', finished: false };
  runQualityJob(qJob, list).catch((e) => { qJob.error = e.message; qJob.finished = true; });
  return { ok: true, job: qJobPublic() };
});
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Que campos (aparte de AutoRemoteQuality) han cambiado entre dos politicas */
function policyDiff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.delete(QF);
  return [...keys].filter((k) => !sameJson((before || {})[k], (after || {})[k]));
}
async function runQualityJob(job, list) {
  const t0 = Date.now();
  const report = { id: job.id, at: job.at, by: job.by ? job.by.name : 'Revisión diaria automática', mode: job.mode, auto: !job.by, servers: [], rows: [] };
  const backups = [];
  // 1) leer todos los servidores (cada uno por su lado: uno caído no para a los demás)
  const prepared = await Promise.all(list.map(async (x) => {
    const cfg = qCfg(x.id), bps = mbpsToBps(cfg.mbps);
    try { const { users } = await embyAllUsers(x); return { x, cfg, bps, users }; }
    catch (e) { return { x, cfg, bps, error: e.message }; }
  }));
  job.total = prepared.reduce((n, p) => n + (p.users ? p.users.length : 0), 0);
  job.phase = job.mode === 'apply' ? 'Aplicando y comprobando…' : 'Simulando…';
  for (const p of prepared) {
    const sum = { id: p.x.id, name: p.x.name, mbps: p.cfg.mbps, bps: p.bps, total: 0, correctos: 0, sinCambios: 0, excluidos: 0, errores: 0, modificados: 0, verificados: 0, simulados: 0, noDisponible: 0, error: p.error || '' };
    report.servers.push(sum);
    if (p.error) continue;
    sum.total = p.users.length;
    for (const u of p.users) {
      const row = { server: p.x.name, serverId: p.x.id, userId: u.Id, name: u.Name || '', before: null, after: null, result: '', detail: '' };
      try {
        const st = qStatus(u, p.cfg, p.bps);
        if (st === 'admin' || st === 'excluido') { row.result = 'Excluido'; row.detail = st === 'admin' ? 'Administrador de Emby (protegido)' : 'Excluido a mano'; sum.excluidos++; continue; }
        if (st === 'nodisp') { row.result = 'Sin cambios'; row.detail = 'Este Emby no tiene el ajuste de calidad remota (hace falta 4.9.3 o superior)'; sum.noDisponible++; sum.sinCambios++; continue; }
        // Leer-cambiar-escribir-comprobar dentro del cerrojo: nadie mas toca la politica a la vez
        await lock(async () => {
          const before = (await emby(p.x, 'GET', `/Users/${u.Id}`)).Policy;
          if (!before) throw new Error('Emby no ha devuelto la política del usuario.');
          if (before.IsAdministrator) { row.result = 'Excluido'; row.detail = 'Administrador de Emby (protegido)'; sum.excluidos++; return; }
          if (!(QF in before)) { row.result = 'Sin cambios'; row.detail = 'Sin ajuste de calidad remota en este Emby'; sum.noDisponible++; sum.sinCambios++; return; }
          row.before = Number(before[QF]);
          if (row.before === p.bps) { row.after = row.before; row.result = 'Sin cambios'; row.detail = 'Ya tenía el objetivo'; sum.sinCambios++; return; }
          if (job.mode === 'simulate') { row.after = p.bps; row.result = 'Simulado'; row.detail = `Se cambiaría de ${bpsToMbps(row.before)} a ${p.cfg.mbps} Mbps`; sum.simulados++; return; }
          backups.push({ serverId: p.x.id, server: p.x.name, userId: u.Id, name: u.Name || '', policy: JSON.parse(JSON.stringify(before)) });
          const next = { ...before, [QF]: p.bps }; // solo cambia este campo; el resto (pantallas, bibliotecas…) se manda igual
          let ambiguous = false;
          try { await emby(p.x, 'POST', `/Users/${u.Id}/Policy`, next); }
          catch (e) {
            if (e.embyStatus === 0 || e.embyStatus >= 500) ambiguous = true; // no sabemos si se guardó: se consulta antes de nada
            else throw e;
          }
          const after = (await emby(p.x, 'GET', `/Users/${u.Id}`)).Policy || {};
          row.after = QF in after ? Number(after[QF]) : null;
          if (row.after !== p.bps) throw new Error(ambiguous ? 'Emby no respondió bien y, al consultarlo, el valor no había cambiado. No se ha vuelto a escribir.' : 'Emby respondió OK, pero al leerlo de nuevo el valor no ha cambiado.');
          sum.modificados++;
          const changed = policyDiff(before, after);
          if (changed.length) throw new Error(`El valor se guardó, pero Emby cambió también: ${changed.slice(0, 6).join(', ')}. Revisa la copia de seguridad.`);
          sum.verificados++; sum.correctos++;
          row.result = 'Correcto'; row.detail = `Verificado en Emby${ambiguous ? ' (tras una respuesta dudosa)' : ''}: ${bpsToMbps(row.before)} → ${bpsToMbps(row.after)} Mbps; el resto de ajustes intacto`;
        });
      } catch (e) {
        row.result = 'Error'; row.detail = e.message; sum.errores++;
      } finally {
        report.rows.push(row);
        job.done++;
      }
    }
    if (job.mode === 'apply') p.cfg.known = p.users.map((u) => u.Id);
  }
  report.ms = Date.now() - t0;
  if (backups.length) {
    fs.mkdirSync(QUALITY_DIR, { recursive: true });
    fs.writeFileSync(path.join(QUALITY_DIR, `copia-${job.id}.json`), JSON.stringify({ at: job.at, reportId: job.id, users: backups }, null, 1), { mode: 0o600 });
    report.backup = `copia-${job.id}.json`; report.backupUsers = backups.length;
  }
  await lock(async () => {
    db.quality.reports.unshift({ ...report, rows: report.rows.slice(0, 5000) });
    db.quality.reports = db.quality.reports.slice(0, 20);
    const tot = report.servers.reduce((a, x) => ({ c: a.c + x.correctos, e: a.e + x.errores, sim: a.sim + x.simulados }), { c: 0, e: 0, sim: 0 });
    addLog('calidad', null, job.mode === 'apply' ? `Calidad remota aplicada: ${tot.c} correctos, ${tot.e} errores` : `Calidad remota simulada: ${tot.sim} usuarios cambiarían`, job.by);
    saveDb();
  });
  job.reportId = job.id; job.phase = 'Terminado'; job.finished = true;
  return report;
}
/* Deshacer: devuelve la calidad remota al valor que tenía antes de una aplicación.
   Solo toca ese ajuste (no se restaura la política entera, para no pisar cambios posteriores como pantallas o bibliotecas)
   y solo si sigue con el valor que puso el panel: si alguien lo cambió después, se respeta. */
route('POST', '/api/quality/undo', STAFF, ({ me, body }) => {
  qAllowed(me);
  const name = String(body.name || '');
  if (!/^copia-[0-9a-f]{12}\.json$/.test(name)) throw new HttpError(400, 'Copia no válida.');
  const f = path.join(QUALITY_DIR, name);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Esa copia ya no existe.');
  if (qJob && !qJob.finished) throw new HttpError(409, 'Ya hay una tarea de calidad en marcha. Espera a que termine.');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  qJob = { id: crypto.randomBytes(6).toString('hex'), mode: 'undo', by: me, at: new Date().toISOString(), total: (data.users || []).length, done: 0, phase: 'Deshaciendo y comprobando…', finished: false };
  runQualityUndo(qJob, data, name).catch((e) => { qJob.error = e.message; qJob.finished = true; });
  return { ok: true, job: qJobPublic() };
});
async function runQualityUndo(job, data, name) {
  const src = db.quality.reports.find((r) => r.id === data.reportId);
  const applied = new Map((src ? src.rows : []).map((r) => [r.serverId + ':' + r.userId, r.after]));
  const report = { id: job.id, at: job.at, by: job.by.name, mode: 'undo', from: data.reportId, servers: [], rows: [] };
  const sums = new Map();
  for (const b of data.users || []) {
    const x = db.servers.find((v) => v.id === b.serverId);
    if (!sums.has(b.serverId)) { const sm = { id: b.serverId, name: x ? x.name : b.server, total: 0, correctos: 0, sinCambios: 0, excluidos: 0, errores: 0, modificados: 0, verificados: 0, simulados: 0, error: '' }; sums.set(b.serverId, sm); report.servers.push(sm); }
    const sum = sums.get(b.serverId);
    sum.total++;
    const row = { server: sum.name, serverId: b.serverId, userId: b.userId, name: b.name, before: null, after: null, result: '', detail: '' };
    try {
      if (!x) throw new Error('Ese servidor ya no está en el panel.');
      const want = b.policy && QF in b.policy ? Number(b.policy[QF]) : null;
      if (want === null) throw new Error('La copia no tiene el valor anterior.');
      await lock(async () => {
        const cur = (await emby(x, 'GET', `/Users/${b.userId}`)).Policy || {};
        if (!(QF in cur)) throw new Error('Este Emby ya no tiene el ajuste de calidad remota.');
        row.before = Number(cur[QF]);
        if (row.before === want) { row.after = want; row.result = 'Sin cambios'; row.detail = 'Ya tenía el valor de antes'; sum.sinCambios++; return; }
        const setBy = applied.get(b.serverId + ':' + b.userId);
        if (setBy != null && row.before !== setBy) { row.after = row.before; row.result = 'Sin cambios'; row.detail = 'Alguien lo cambió después: no se toca'; sum.sinCambios++; return; }
        let ambiguous = false;
        try { await emby(x, 'POST', `/Users/${b.userId}/Policy`, { ...cur, [QF]: want }); }
        catch (e) { if (e.embyStatus === 0 || e.embyStatus >= 500) ambiguous = true; else throw e; }
        const after = (await emby(x, 'GET', `/Users/${b.userId}`)).Policy || {};
        row.after = QF in after ? Number(after[QF]) : null;
        if (row.after !== want) throw new Error(ambiguous ? 'Emby no respondió bien y el valor no ha vuelto atrás. No se ha reintentado.' : 'Emby respondió OK, pero el valor no ha vuelto atrás.');
        sum.modificados++;
        const changed = policyDiff(cur, after);
        if (changed.length) throw new Error(`Se deshizo, pero Emby cambió también: ${changed.slice(0, 6).join(', ')}.`);
        sum.verificados++; sum.correctos++;
        row.result = 'Correcto'; row.detail = `Deshecho y verificado: ${bpsToMbps(row.before)} → ${bpsToMbps(row.after)} Mbps`;
      });
    } catch (e) { row.result = 'Error'; row.detail = e.message; sum.errores++; }
    finally { report.rows.push(row); job.done++; }
  }
  await lock(async () => {
    db.quality.reports.unshift(report); db.quality.reports = db.quality.reports.slice(0, 20);
    const t = report.servers.reduce((a, v) => ({ c: a.c + v.correctos, e: a.e + v.errores }), { c: 0, e: 0 });
    addLog('calidad', null, `Calidad remota deshecha (${name}): ${t.c} usuarios devueltos, ${t.e} errores`, job.by);
    saveDb();
  });
  job.reportId = job.id; job.phase = 'Terminado'; job.finished = true;
}

/* Vigilancia: revisión diaria automática y aviso de saturación */
const qGuard = () => {
  const g = db.quality.guard || (db.quality.guard = {});
  g.daily = { on: false, hour: 5, last: null, ...(g.daily || {}) };
  g.sat = { on: false, limit: 5, cooldown: 30, ...(g.sat || {}) };
  return g;
};
route('PUT', '/api/quality/guard', STAFF, ({ me, body }) => lock(async () => {
  qAllowed(me);
  const g = qGuard();
  if (body.daily) {
    g.daily.on = !!body.daily.on;
    const h = Number(body.daily.hour); if (Number.isInteger(h) && h >= 0 && h <= 23) g.daily.hour = h;
  }
  if (body.sat) {
    g.sat.on = !!body.sat.on;
    const l = Number(body.sat.limit); if (Number.isInteger(l) && l >= 1 && l <= 200) g.sat.limit = l;
    const cd = Number(body.sat.cooldown); if (Number.isInteger(cd) && cd >= 5 && cd <= 1440) g.sat.cooldown = cd;
  }
  addLog('calidad', null, `Vigilancia de calidad: revisión diaria ${g.daily.on ? 'a las ' + pad(g.daily.hour) + ':00' : 'apagada'}, aviso de saturación ${g.sat.on ? 'con ' + g.sat.limit + ' conversiones de vídeo' : 'apagado'}`, me);
  saveDb();
  return { ok: true };
}));
async function qualityDaily() {
  const g = qGuard().daily;
  if (!g.on || (qJob && !qJob.finished)) return;
  const localH = Number(new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', hour12: false }));
  if (!process.env.QDAILY_ANYTIME && localH < g.hour) return;
  if (g.last && localDate(new Date(g.last)) === today()) return;
  if (g.lastTry && Date.now() - g.lastTry < 30 * 60000) return;
  g.lastTry = Date.now();
  const list = db.servers.filter((x) => !x.keyLost);
  if (!list.length) return;
  qJob = { id: crypto.randomBytes(6).toString('hex'), mode: 'apply', by: null, at: new Date().toISOString(), total: 0, done: 0, phase: 'Revisión diaria…', finished: false };
  let r;
  try { r = await runQualityJob(qJob, list); } catch (e) { qJob.error = e.message; qJob.finished = true; notifyStaff('quality', `⚠️ La revisión diaria de calidad no pudo terminar: ${e.message}`); return; }
  g.last = new Date().toISOString();
  await lock(async () => saveDb());
  const t = r.servers.reduce((a, v) => ({ c: a.c + v.correctos, e: a.e + v.errores, down: a.down + (v.error ? 1 : 0) }), { c: 0, e: 0, down: 0 });
  if (t.c || t.e || t.down) {
    const lines = r.servers.filter((v) => v.error || v.correctos || v.errores).map((v) => v.error ? `• ${v.name}: sin conexión` : `• ${v.name}: ${v.correctos} ${v.correctos === 1 ? 'usuario corregido' : 'usuarios corregidos'}${v.errores ? `, ${v.errores} con error` : ''}`);
    const rest = r.servers.length - lines.length;
    if (rest > 0) lines.push(`• ${rest === 1 ? 'El otro servidor estaba' : `Los otros ${rest} servidores estaban`} ya correctos`);
    notifyStaff('quality', `📺 Revisión diaria de calidad remota\n${lines.join('\n')}\n\nEl informe está en el panel, en Emby › Calidad remota.`);
  }
}
const satState = new Map(); // servidor -> { high, at }
async function saturationCheck() {
  const g = qGuard().sat;
  if (!g.on) return;
  for (const x of db.servers) {
    if (x.keyLost) continue;
    let list;
    try { list = await emby(x, 'GET', '/Sessions'); } catch { continue; } // si no responde ya avisa la vigilancia de servidores
    const conv = (list || []).filter((y) => y.NowPlayingItem && y.TranscodingInfo && y.TranscodingInfo.IsVideoDirect === false);
    const st = satState.get(x.id) || { high: false, at: 0 };
    if (conv.length >= g.limit) {
      if (!st.high || Date.now() - st.at >= g.cooldown * 60000) {
        const who = conv.slice(0, 10).map((y) => { const c = db.clients.find((k) => k.serverId === x.id && k.embyId === y.UserId); return `• ${c ? c.panelName : (y.UserName || '?')} — ${y.DeviceName || 'aparato'} (${sessionTitle(y)})`; });
        notifyStaff('quality', `🔥 «${x.name}» está convirtiendo ${conv.length} vídeos a la vez (tu límite de aviso es ${g.limit}).\n${who.join('\n')}${conv.length > 10 ? `\n…y ${conv.length - 10} más` : ''}\n\nMíralo en el Monitor del panel.`);
        await lock(async () => { addLog('calidad', null, `Saturación en "${x.name}": ${conv.length} vídeos convirtiéndose a la vez`, null); saveDb(); });
        satState.set(x.id, { high: true, at: Date.now() });
      }
    } else if (st.high && conv.length < Math.max(1, Math.floor(g.limit / 2))) {
      notifyStaff('quality', `✅ «${x.name}» ha vuelto a la normalidad: ${conv.length} ${conv.length === 1 ? 'vídeo convirtiéndose' : 'vídeos convirtiéndose'}.`);
      satState.set(x.id, { high: false, at: Date.now() });
    }
  }
}
route('GET', '/api/quality/reports/:id', STAFF, ({ me, params }) => {
  qAllowed(me);
  const r = db.quality.reports.find((x) => x.id === params.id);
  if (!r) throw new HttpError(404, 'Ese informe ya no existe.');
  return { report: r };
});
route('GET', '/api/quality/backups', STAFF, ({ me }) => {
  qAllowed(me);
  let files = [];
  try { files = fs.readdirSync(QUALITY_DIR).filter((f) => /^copia-[0-9a-f]{12}\.json$/.test(f)); } catch { /* aun no hay */ }
  return { backups: files.map((f) => { const st = fs.statSync(path.join(QUALITY_DIR, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at)) };
});
route('GET', '/api/quality/backups/:name', STAFF, ({ me, params }) => {
  qAllowed(me);
  if (!/^copia-[0-9a-f]{12}\.json$/.test(params.name)) throw new HttpError(400, 'Copia no válida.');
  const f = path.join(QUALITY_DIR, params.name);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Esa copia ya no existe.');
  return { __raw: fs.readFileSync(f), headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${params.name}"`, 'Cache-Control': 'no-store' } };
});


/* ======================================================================
   Equipo: anti-sabotaje, accesos sospechosos, vendedores que necesitan atención,
   tasa de renovación, mensaje a vendedores y resumen diario
   ====================================================================== */
function addChurn(ownerId, k) {
  if (ownerId == null) return;
  db.churn.push({ t: new Date().toISOString(), o: ownerId, k });
  const lim = Date.now() - 120 * 86400000;
  if (db.churn.length > 30000 || Date.parse(db.churn[0].t) < lim) db.churn = db.churn.filter((x) => Date.parse(x.t) >= lim).slice(-30000);
}
/** Tasa de renovación de los últimos 90 días: renovaciones / (renovaciones + cuentas perdidas por no renovar) */
function renewRate(ownerIds) {
  const set = new Set(ownerIds), lim = Date.now() - 90 * 86400000;
  let ren = 0, lost = 0;
  for (const x of db.churn) if (set.has(x.o) && Date.parse(x.t) >= lim) { if (x.k === 'ren') ren++; else lost++; }
  return ren + lost >= 3 ? { rate: Math.round((ren / (ren + lost)) * 100), ren, lost } : { rate: null, ren, lost };
}

/* Anti-sabotaje: muchas acciones delicadas seguidas de alguien del equipo */
const guardHits = new Map(); // userId -> [momentos]
function riskyAction(type, text) {
  if (['baja', 'eliminada', 'desactivada', 'transferida'].includes(type)) return true;
  if (type === 'edicion' && /contraseña/.test(text)) return true;
  if (type === 'monitor' && /detenida/i.test(text)) return true;
  if (type === 'usuario' && /^(Desactivado|Usuario eliminado)/.test(text)) return true;
  if (type === 'servidor' || type === 'calidad') return true;
  return false;
}
function guardTrack(actor, type, text) {
  const g = db.settings.guard;
  if (!g || !g.on || !riskyAction(type, text)) return;
  const now = Date.now(), win = (g.minutes || 10) * 60000;
  const list = (guardHits.get(actor.id) || []).filter((t) => now - t < win);
  list.push(now); guardHits.set(actor.id, list);
  if (list.length < (g.limit || 10)) return;
  const open = db.incidents.find((x) => x.userId === actor.id && !x.closed && now - Date.parse(x.at) < win);
  if (open) { open.count = list.length; return; } // ya avisado: solo se actualiza la cuenta
  const u = db.users.find((x) => x.id === actor.id);
  const recent = db.log.filter((l) => l.actorId === actor.id && now - Date.parse(l.ts) < win && riskyAction(l.type, l.text)).slice(0, 6).map((l) => `${l.client ? l.client + ' — ' : ''}${l.text}`.slice(0, 110));
  const inc = { id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), userId: actor.id, name: actor.name, role: actor.role, count: list.length, minutes: g.minutes, sample: recent, blocked: false, closed: false };
  if (g.block && u && u.role !== 'super') { u.disabled = true; u.offAt = inc.at; dropSessions(u.id); inc.blocked = true; }
  db.incidents.unshift(inc); db.incidents = db.incidents.slice(0, 200);
  db.log.unshift({ ts: inc.at, type: 'seguridad', client: '', emby: '', clientId: null, ownerId: null, demo: false, actorId: null, actor: '', text: `Acciones raras: ${actor.name} hizo ${list.length} acciones delicadas en ${g.minutes} minutos${inc.blocked ? '. Acceso bloqueado' : ''}`, auto: true });
  notifyStaff('sabotage', `🚨 Acciones raras en el panel\n${actor.name} (${ROLE_NAME[actor.role] || actor.role}) ha hecho ${list.length} acciones delicadas en menos de ${g.minutes} minutos:\n${recent.map((t) => '• ' + t).join('\n')}\n\n${inc.blocked ? '🔒 Su acceso se ha bloqueado automáticamente. Revísalo en Vendedores › Atención.' : 'Revísalo en Vendedores › Atención. Si no es normal, desactívalo.'}`);
}

/* Accesos sospechosos de alguien del equipo (de su historial de accesos) */
function accessRisk(u) {
  const lim = Date.now() - 7 * 86400000;
  const rows = db.access.filter((e) => e.userId === u.id && e.kind === 'entrada' && Date.parse(e.ts) >= lim);
  const zones = new Set(rows.map((e) => ipZone(e.ip)).filter(Boolean));
  const fails = db.access.filter((e) => e.userId === u.id && /fallido/.test(e.kind) && Date.parse(e.ts) >= lim).length;
  let twoAtOnce = false;
  const sorted = rows.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  for (let i = 1; i < sorted.length; i++) if (ipZone(sorted[i].ip) !== ipZone(sorted[i - 1].ip) && Date.parse(sorted[i].ts) - Date.parse(sorted[i - 1].ts) < 15 * 60000) { twoAtOnce = true; break; }
  const reasons = [];
  if (twoAtOnce) reasons.push('entró desde dos sitios distintos casi a la vez');
  if (zones.size >= 3) reasons.push(`entró desde ${zones.size} sitios diferentes esta semana`);
  if (fails >= 5) reasons.push(`${fails} intentos fallidos de contraseña`);
  return { level: twoAtOnce || reasons.length >= 2 ? 'alto' : reasons.length ? 'medio' : 'no', reasons, zones: zones.size, logins: rows.length, fails, devs: [...new Set(rows.map((e) => e.dev))].slice(0, 4) };
}
/* Vendedores que necesitan atención */
function vendorAttention(u) {
  const now = Date.now(), day = 86400000, reasons = [];
  const mine = db.clients.filter((c) => c.ownerId === u.id);
  let last = 0;
  for (const c of mine) if (!c.demo) last = Math.max(last, Date.parse(c.createdAt) || 0);
  for (const x of db.churn) if (x.o === u.id && x.k === 'ren') last = Math.max(last, Date.parse(x.t));
  const age = now - (Date.parse(u.createdAt) || now);
  const noSale = Math.floor((now - (last || Date.parse(u.createdAt) || now)) / day);
  if (age > 14 * day && noSale >= 30) reasons.push({ k: 'ventas', t: last ? `Sin vender desde hace ${noSale} días` : 'Todavía no ha vendido nada' });
  const seen = Date.parse(u.lastSeen || (u.lastLogin && u.lastLogin.at) || '') || 0;
  const away = Math.floor((now - (seen || Date.parse(u.createdAt) || now)) / day);
  if (age > 7 * day && away >= 14) reasons.push({ k: 'acceso', t: seen ? `No entra al panel desde hace ${away} días` : 'Nunca ha entrado al panel' });
  if (paysCredits(u) && (u.credits || 0) <= 2) reasons.push({ k: 'creditos', t: (u.credits || 0) <= 0 ? 'Se ha quedado sin créditos' : `Le ${u.credits === 1 ? 'queda 1 crédito' : 'quedan ' + u.credits + ' créditos'}` });
  return { reasons, clients: mine.filter((c) => c.status !== 'trash' && !c.demo).length, credits: u.credits || 0, tgLinked: !!u.tgChat };
}
/** A quién del equipo puede ver cada uno en esta pantalla */
function teamVisible(me) {
  if (me.role === 'super') return db.users.filter((u) => u.id !== me.id);
  if (me.role === 'admin') return can(me, 'resellers') ? db.users.filter((u) => u.role === 'reseller' || u.role === 'sub') : [];
  if (me.role === 'reseller') return db.users.filter((u) => u.parentId === me.id);
  return [];
}
route('GET', '/api/team', ['super', 'admin', 'reseller'], ({ me }) => {
  const team = teamVisible(me).filter((u) => !u.disabled);
  const attention = team.filter((u) => u.role !== 'admin').map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, ...vendorAttention(u) })).filter((x) => x.reasons.length);
  const suspicious = team.map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, ...accessRisk(u) })).filter((x) => x.level !== 'no');
  const visIds = new Set(teamVisible(me).map((u) => u.id));
  const incidents = me.role === 'super' || (me.role === 'admin' && can(me, 'resellers')) ? db.incidents.filter((x) => visIds.has(x.userId)).slice(0, 30) : [];
  const rates = {};
  for (const u of teamVisible(me)) if (u.role !== 'admin') rates[u.id] = renewRate([u.id]);
  return { attention, suspicious, incidents, rates, guard: me.role === 'super' ? db.settings.guard : null };
});
function teamCount(me) {
  if (!['super', 'admin', 'reseller'].includes(me.role)) return 0;
  const team = teamVisible(me).filter((u) => !u.disabled);
  const visIds = new Set(teamVisible(me).map((u) => u.id)); // los avisos cuentan aunque ya esté bloqueado
  return team.filter((u) => u.role !== 'admin' && vendorAttention(u).reasons.length).length
    + team.filter((u) => accessRisk(u).level !== 'no').length
    + db.incidents.filter((x) => !x.closed && visIds.has(x.userId)).length;
}
route('POST', '/api/incidents/:id', STAFF, ({ me, params, body }) => lock(async () => {
  const inc = db.incidents.find((x) => x.id === params.id);
  if (!inc) throw new HttpError(404, 'Ese aviso ya no existe.');
  const u = db.users.find((x) => x.id === inc.userId);
  if (u && !canManageUser(me, u)) throw new HttpError(403, 'No puedes cambiar a este usuario.');
  if (body.unblock && u) { u.disabled = false; delete u.offAt; inc.blocked = false; addLog('usuario', null, `Desbloqueado ${u.name} tras revisar las acciones raras`, me); }
  inc.closed = true; inc.closedBy = me.name; inc.closedAt = new Date().toISOString();
  saveDb();
  return { ok: true };
}));
route('PUT', '/api/guard', SUPER, ({ me, body }) => lock(async () => {
  const g = db.settings.guard;
  g.on = !!body.on; g.block = !!body.block;
  const l = Number(body.limit); if (Number.isInteger(l) && l >= 3 && l <= 200) g.limit = l;
  const m = Number(body.minutes); if (Number.isInteger(m) && m >= 1 && m <= 120) g.minutes = m;
  addLog('ajustes', null, `Alerta de acciones raras: ${g.on ? `${g.limit} acciones en ${g.minutes} minutos${g.block ? ', con bloqueo automático' : ''}` : 'apagada'}`, me);
  saveDb();
  return { ok: true };
}));

/* Mensaje por Telegram al equipo */
function vbTargets(me, body) {
  const who = body.who || 'vendors';
  return teamVisible(me).filter((u) => !u.disabled && u.tgChat && (who === 'all' || (who === 'admins' ? u.role === 'admin' : u.role === 'reseller' || u.role === 'sub')));
}
route('POST', '/api/vbroadcast/preview', ['super', 'admin', 'reseller'], ({ me, body }) => {
  const team = teamVisible(me).filter((u) => !u.disabled);
  return { targets: vbTargets(me, body).length, linked: team.filter((u) => u.tgChat).length, total: team.length, bot: !!db.settings.notices.telegram.token };
});
let vbJob = null;
route('GET', '/api/vbroadcast', ['super', 'admin', 'reseller'], ({ me }) => ({ job: vbJob && vbJob.byId === me.id ? { total: vbJob.total, done: vbJob.done, ok: vbJob.ok, fail: vbJob.fail, finished: vbJob.finished } : null,
  history: (db.vbroadcasts || []).filter((b) => me.role === 'super' || b.byId === me.id).slice(0, 10) }));
route('POST', '/api/vbroadcast', ['super', 'admin', 'reseller'], ({ me, body }) => {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (text.length < 3) throw new HttpError(400, 'Escribe el mensaje.');
  if (!db.settings.notices.telegram.token) throw new HttpError(400, 'El bot de Telegram no está configurado.');
  if (vbJob && !vbJob.finished) throw new HttpError(409, 'Ya se está enviando otro mensaje. Espera a que termine.');
  const list = vbTargets(me, body);
  if (!list.length) throw new HttpError(400, 'Nadie de ese grupo tiene Telegram enlazado.');
  vbJob = { byId: me.id, total: list.length, done: 0, ok: 0, fail: 0, finished: false };
  const job = vbJob;
  (async () => {
    for (const u of list) {
      try { await tg('sendMessage', { chat_id: u.tgChat, text: text.replace(/\{nombre\}/gi, u.name).replace(/\{creditos\}|\{créditos\}/gi, String(u.credits || 0)) }); job.ok++; } catch { job.fail++; }
      job.done++;
      await new Promise((r) => setTimeout(r, Number(process.env.BC_DELAY_MS) || 60));
    }
    job.finished = true;
    await lock(async () => {
      if (!Array.isArray(db.vbroadcasts)) db.vbroadcasts = [];
      db.vbroadcasts.unshift({ at: new Date().toISOString(), by: me.name, byId: me.id, text: text.slice(0, 300), total: job.total, ok: job.ok, fail: job.fail });
      db.vbroadcasts = db.vbroadcasts.slice(0, 50);
      addLog('aviso', null, `Mensaje por Telegram a ${job.ok} del equipo: ${text.slice(0, 80)}`, me);
      saveDb();
    });
  })().catch(() => { job.finished = true; });
  return { ok: true, total: list.length };
});
/* Mensaje a un vendedor concreto (desde Atención) */
route('POST', '/api/users/:id/message', ['super', 'admin', 'reseller'], async ({ me, params, body }) => {
  const u = userById(params.id);
  if (!teamVisible(me).some((x) => x.id === u.id)) throw new HttpError(403, 'No puedes escribir a este usuario.');
  if (!u.tgChat) throw new HttpError(400, 'No tiene Telegram enlazado. Copia el mensaje y mándaselo por donde habléis.');
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1500) : '';
  if (!text) throw new HttpError(400, 'Escribe el mensaje.');
  await tg('sendMessage', { chat_id: u.tgChat, text });
  await lock(async () => { addLog('aviso', null, `Mensaje por Telegram a ${u.name}: ${text.slice(0, 80)}`, me); saveDb(); });
  return { ok: true };
});

/* Resumen diario por Telegram (9:00) */
function dailySummaryText() {
  const t = today(), y = addDays(t, -1), isY = (ts) => ts && localDate(new Date(ts)) === y;
  const L = db.log.filter((l) => isY(l.ts));
  const altas = L.filter((l) => l.type === 'alta').length, demos = L.filter((l) => l.type === 'demo').length;
  const ren = L.filter((l) => l.type === 'renovacion' && /^Renovada/.test(l.text)).length, conv = L.filter((l) => l.type === 'renovacion' && /^Demo convertida/.test(l.text)).length;
  const sold = db.ledger.filter((x) => isY(x.ts) && x.kind === 'credito' && x.delta > 0).reduce((n, x) => n + x.delta, 0);
  const soon = db.clients.filter((c) => !c.demo && c.status === 'active' && diffDays(c.expires, t) >= 0 && diffDays(c.expires, t) <= 7).length;
  const errs = db.clients.filter((c) => c.lastError && c.status !== 'trash').length;
  const fu = db.followups.filter((f) => f.status === 'pending').length;
  const shared = db.clients.filter((c) => c.status !== 'trash' && !c.demo && shareInfo(c).level !== 'no').length;
  const fails = db.access.filter((e) => isY(e.ts) && /fallido|bloqueado/.test(e.kind)).length;
  const inc = db.incidents.filter((x) => !x.closed).length;
  const lines = [`☀️ Buenos días. Así fue ayer en ${db.settings.brand.name || 'tu panel'}:`, '',
    `🆕 ${altas} ${altas === 1 ? 'alta' : 'altas'} · 🔄 ${ren} ${ren === 1 ? 'renovación' : 'renovaciones'} · 🎬 ${demos} ${demos === 1 ? 'demo' : 'demos'}${conv ? ` (${conv} ${conv === 1 ? 'se convirtió' : 'se convirtieron'})` : ''}`];
  if (sold) lines.push(`💰 ${sold} ${sold === 1 ? 'crédito vendido' : 'créditos vendidos'}`);
  const cobrado = db.vpay.filter((x) => x.status === 'paid' && !x.gift && isY(x.paidAt)).reduce((n, x) => n + x.amount, 0);
  if (cobrado) lines.push(`💶 Cobrado a vendedores: ${money2(cobrado)}`);
  const deben = db.users.reduce((n, u) => n + (u.role === 'reseller' || u.role === 'sub' ? debtOf(u).amount : 0), 0);
  if (deben) lines.push(`⏳ Te deben: ${money2(deben)}`);
  lines.push('', `⏳ Vencen esta semana: ${soon}`);
  const todo = [];
  if (fu) todo.push(`• ${fu} ${fu === 1 ? 'demo por escribir' : 'demos por escribir'}`);
  if (shared) todo.push(`• ${shared} ${shared === 1 ? 'cuenta parece compartida' : 'cuentas parecen compartidas'}`);
  if (errs) todo.push(`• ${errs} ${errs === 1 ? 'cuenta con error en Emby' : 'cuentas con error en Emby'}`);
  if (fails) todo.push(`• ${fails} ${fails === 1 ? 'intento fallido' : 'intentos fallidos'} de entrar al panel`);
  if (inc) todo.push(`• 🚨 ${inc} ${inc === 1 ? 'aviso de acciones raras' : 'avisos de acciones raras'} sin revisar`);
  lines.push(...(todo.length ? ['', 'Para revisar:', ...todo] : ['', '✅ Nada pendiente de revisar.']));
  return lines.join('\n');
}
let dailyLast = null;
function dailySummary() {
  const h = Number(new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', hour12: false }));
  const t = today();
  if (!process.env.DAILY_ANYTIME && h < 9) return;
  if ((db.settings.dailyLast || dailyLast) === t) return;
  dailyLast = t; db.settings.dailyLast = t;
  notifyStaff('daily', dailySummaryText());
  lock(async () => saveDb()).catch(() => {});
}
route('POST', '/api/daily/test', SUPER, ({ me }) => { if (!me.tgChat) throw new HttpError(400, 'Enlaza primero tu Telegram en Ajustes › Seguridad.'); notifyUser(me, dailySummaryText()); return { ok: true }; });


/* ======================================================================
   Cobros a vendedores: forma de pago, deudas, recordatorios, justificantes,
   extracto de cuenta, aviso de créditos regalados e informe de cobros
   ====================================================================== */
const PAY_METHODS = ['Bizum', 'Efectivo', 'Transferencia', 'PayPal', 'Cripto', 'Tarjeta', 'Otro', 'Sin cobro'];
const money2 = (n) => `${(Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${db.settings.currency === 'EUR' || !db.settings.currency ? '€' : db.settings.currency}`;
function readPayment(body, u, credits) {
  const p = body.payment;
  if (!p || typeof p !== 'object') return null;
  const method = PAY_METHODS.includes(p.method) ? p.method : 'Otro';
  if (method === 'Sin cobro') return { method, amount: 0, status: 'paid', ref: '', gift: true };
  const amount = Math.round(Number(p.amount) * 100) / 100;
  if (!(amount >= 0) || amount > 1e6) throw new HttpError(400, 'Escribe un importe válido.');
  return { method, amount, status: p.status === 'pending' ? 'pending' : 'paid', ref: str(p.ref, 60) };
}
const payText = (p) => (!p ? '' : p.gift ? ' · sin cobro' : ` · ${money2(p.amount)} ${p.method}`); // si está pagada o no se ve en Cobros y deudas (cambia con el tiempo)
function afterRecharge(me, u, credits, pay) {
  if (pay) {
    const rec = { id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), userId: u.id, user: u.name, credits, amount: pay.amount, method: pay.method, ref: pay.ref, status: pay.status, paidAt: pay.status === 'paid' ? new Date().toISOString() : null, by: me.name, byId: me.id, gift: !!pay.gift };
    // referencia repetida: mismo concepto de Bizum o transferencia ya usado
    if (rec.ref) { const dup = db.vpay.find((x) => x.ref && x.ref.toLowerCase() === rec.ref.toLowerCase() && x.method === rec.method); if (dup) rec.dupOf = dup.id; }
    db.vpay.unshift(rec);
    if (db.vpay.length > 20000) db.vpay.length = 20000;
    const cfg = db.settings.vpay;
    if (cfg.receipts !== false && u.tgChat) notifyUser(u, `✅ Recarga de ${plural(credits, 'crédito', 'créditos')}${pay.gift ? '' : ` · ${money2(pay.amount)} por ${pay.method}${pay.status === 'pending' ? ' (pendiente de pago)' : ''}`}\nSaldo: ${plural(u.credits, 'crédito', 'créditos')}${pay.status === 'pending' ? `\nTienes pendiente: ${money2(debtOf(u).amount)}` : ''}`);
    if (rec.dupOf) notifyStaff('credits', `⚠️ Referencia repetida: la recarga de ${u.name} usa «${rec.ref}» (${rec.method}), que ya se había apuntado antes. Revisa que no sea el mismo pago dos veces.`);
  }
  // Aviso de créditos regalados o grandes recargas hechas por otro (no por ti)
  const cfg = db.settings.vpay;
  if (me.role !== 'super' && (credits >= (cfg.giftAlert || 50) || (pay && pay.gift) || (!pay && credits > 0 && me.role === 'admin'))) {
    notifyStaff('credits', `💳 ${me.name} ha cargado ${plural(credits, 'crédito', 'créditos')} a ${u.name}${pay ? (pay.gift ? ' SIN COBRO' : ` · ${money2(pay.amount)} ${pay.method}${pay.status === 'pending' ? ' (pendiente)' : ''}`) : ' sin apuntar el cobro'}.\n${whenTxt()}`);
  }
}
/** Lo que debe un vendedor: recargas pendientes + saldo en negativo */
function debtOf(u) {
  const pend = db.vpay.filter((x) => x.userId === u.id && x.status === 'pending');
  const neg = u.credits < 0 ? Math.round(-u.credits * buyerPrice(u) * 100) / 100 : 0;
  const amount = Math.round((pend.reduce((n, x) => n + x.amount, 0) + neg) * 100) / 100;
  const oldest = pend.length ? pend[pend.length - 1].at : null;
  return { amount, pending: pend.length, neg, negCredits: u.credits < 0 ? -u.credits : 0, oldest, days: oldest ? Math.floor((Date.now() - Date.parse(oldest)) / 86400000) : 0 };
}
function debtGate(me) {
  const cfg = db.settings.vpay;
  if (!cfg || (!(cfg.limit > 0) && !(cfg.days > 0)) || isStaff(me)) return;
  const d = debtOf(me);
  if (!d.amount) return;
  if ((cfg.limit > 0 && d.amount > cfg.limit) || (cfg.days > 0 && d.days >= cfg.days)) {
    throw new HttpError(402, `Tienes ${money2(d.amount)} pendientes de pagar${d.days ? ` desde hace ${plural(d.days, 'día', 'días')}` : ''}. Cuando lo pagues podrás seguir dando altas y renovaciones. Habla con quien te recarga los créditos.`);
  }
}
/** Quién puede ver/gestionar los cobros de quién */
function payVisible(me) {
  if (me.role === 'super' || (me.role === 'admin' && can(me, 'credits'))) return (x) => true;
  return (x) => x.byId === me.id;
}
const debtorsFor = (me) => db.users.filter((u) => !['super'].includes(u.role) && u.id !== me.id && (me.role === 'super' || (me.role === 'admin' && can(me, 'credits')) || db.vpay.some((x) => x.userId === u.id && x.byId === me.id) || u.parentId === me.id));
route('GET', '/api/vpay', ['super', 'admin', 'reseller'], ({ me, req }) => {
  const q = new URL(req.url, 'http://x').searchParams, month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : today().slice(0, 7);
  const vis = payVisible(me), list = db.vpay.filter(vis);
  const debtors = debtorsFor(me).map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, credits: u.credits, price: buyerPrice(u), tgLinked: !!u.tgChat, ...debtOf(u) }))
    .filter((d) => d.amount > 0 && (me.role === 'super' || (me.role === 'admin' && can(me, 'credits')) || list.some((x) => x.userId === d.id) || db.users.find((u) => u.id === d.id).parentId === me.id))
    .sort((a, b) => b.amount - a.amount);
  const inMonth = list.filter((x) => x.status === 'paid' && !x.gift && x.paidAt && x.paidAt.slice(0, 7) === month);
  const prevM = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const prevTotal = list.filter((x) => x.status === 'paid' && !x.gift && x.paidAt && x.paidAt.slice(0, 7) === prevM).reduce((n, x) => n + x.amount, 0);
  const byMethod = {}, byUser = {};
  for (const x of inMonth) { byMethod[x.method] = (byMethod[x.method] || 0) + x.amount; byUser[x.user] = (byUser[x.user] || 0) + x.amount; }
  return { month, total: Math.round(inMonth.reduce((n, x) => n + x.amount, 0) * 100) / 100, prevTotal: Math.round(prevTotal * 100) / 100, count: inMonth.length, byMethod, byUser,
    gifts: list.filter((x) => x.gift && x.at.slice(0, 7) === month).reduce((n, x) => n + x.credits, 0),
    debt: Math.round(debtors.reduce((n, d) => n + d.amount, 0) * 100) / 100, debtors, recent: list.slice(0, 40), methods: PAY_METHODS, cfg: me.role === 'super' ? db.settings.vpay : null,
    months: [...new Set(list.filter((x) => x.paidAt).map((x) => x.paidAt.slice(0, 7)).concat([today().slice(0, 7)]))].sort().reverse().slice(0, 18) };
});
/* Registrar que ha pagado (todas o algunas recargas pendientes) */
route('POST', '/api/vpay/settle', ['super', 'admin', 'reseller'], ({ me, body }) => lock(async () => {
  const u = userById(body.userId), vis = payVisible(me);
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
  const method = PAY_METHODS.includes(body.method) ? body.method : null, ref = str(body.ref, 60);
  const pend = db.vpay.filter((x) => x.userId === u.id && x.status === 'pending' && vis(x) && (!ids || ids.includes(x.id)));
  if (!pend.length) throw new HttpError(400, 'No hay recargas pendientes que marcar.');
  const at = new Date().toISOString();
  for (const x of pend) { x.status = 'paid'; x.paidAt = at; x.settledBy = me.name; if (method) x.method = method; if (ref) x.ref = ref; }
  const total = pend.reduce((n, x) => n + x.amount, 0);
  addLog('cobro', null, `Pago registrado de ${u.name}: ${money2(total)}${method ? ' por ' + method : ''} (${plural(pend.length, 'recarga', 'recargas')})`, me);
  if (db.settings.vpay.receipts !== false && u.tgChat) notifyUser(u, `✅ Pago recibido: ${money2(total)}${method ? ' por ' + method : ''}. ¡Gracias!${debtOf(u).amount ? `\nTe queda pendiente: ${money2(debtOf(u).amount)}` : '\nYa no tienes nada pendiente.'}`);
  saveDb();
  return { ok: true, total };
}));
/* Recordatorio de pago (a mano) */
function remindText(u) { const d = debtOf(u); return `Hola ${u.name} 👋\n\nTienes pendiente de pago ${money2(d.amount)}${d.pending ? ` (${plural(d.pending, 'recarga', 'recargas')}${d.days ? `, la más antigua de hace ${plural(d.days, 'día', 'días')}` : ''})` : ''}${d.negCredits ? `${d.pending ? ' y' : ''} ${plural(d.negCredits, 'crédito', 'créditos')} en negativo` : ''}.\n\nCuando puedas, házmelo llegar. ¡Gracias!`; }
route('POST', '/api/vpay/remind', ['super', 'admin', 'reseller'], async ({ me, body }) => {
  const u = userById(body.userId);
  if (!debtorsFor(me).some((x) => x.id === u.id)) throw new HttpError(403, 'No puedes escribir a este usuario.');
  if (!u.tgChat) throw new HttpError(400, 'No tiene Telegram enlazado. Copia el mensaje y mándaselo.');
  await tg('sendMessage', { chat_id: u.tgChat, text: typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 1500) : remindText(u) });
  await lock(async () => { u.lastRemind = new Date().toISOString(); addLog('aviso', null, `Recordatorio de pago enviado a ${u.name}`, me); saveDb(); });
  return { ok: true };
});
/* Extracto de cuenta de un vendedor */
function statementOf(u, from, to) {
  const inR = (ts) => ts >= from && ts < to;
  const led = db.ledger.filter((x) => x.userId === u.id && inR(x.ts));
  const pays = db.vpay.filter((x) => x.userId === u.id && inR(x.at));
  const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
  return {
    user: { id: u.id, name: u.name, credits: u.credits, price: buyerPrice(u) }, from, to,
    loaded: sum(led.filter((x) => x.delta > 0 && x.kind === 'credito'), (x) => x.delta),
    spent: -sum(led.filter((x) => x.delta < 0 && (x.kind === 'alta' || x.kind === 'renovacion' || x.kind === 'asignacion')), (x) => x.delta),
    refunds: sum(led.filter((x) => x.kind === 'devolucion'), (x) => x.delta),
    paid: Math.round(sum(pays.filter((x) => x.status === 'paid' && !x.gift), (x) => x.amount) * 100) / 100,
    pending: Math.round(sum(pays.filter((x) => x.status === 'pending'), (x) => x.amount) * 100) / 100,
    debt: debtOf(u),
    rows: led.slice(0, 300).map((x) => ({ ts: x.ts, text: x.text, delta: x.delta, balance: x.balance, kind: x.kind })),
  };
}
function statementText(st) {
  const d = (s) => s.slice(0, 10).split('-').reverse().join('/');
  return `📄 Extracto de ${st.user.name}\n${d(st.from)} – ${d(new Date(Date.parse(st.to) - 1).toISOString())}\n\n` +
    `➕ Recargas: ${plural(st.loaded, 'crédito', 'créditos')}\n➖ Gastados en altas y renovaciones: ${st.spent}\n${st.refunds ? `↩️ Devueltos: ${st.refunds}\n` : ''}` +
    `💶 Pagado: ${money2(st.paid)}${st.pending ? `\n⏳ Pendiente de este periodo: ${money2(st.pending)}` : ''}\n\n` +
    `Saldo actual: ${plural(st.user.credits, 'crédito', 'créditos')}${st.debt.amount ? `\nTotal pendiente de pago: ${money2(st.debt.amount)}` : '\nNo tienes nada pendiente ✅'}`;
}
route('GET', '/api/users/:id/statement', ['super', 'admin', 'reseller'], ({ me, params, req }) => {
  const u = userById(params.id);
  if (u.id !== me.id && !canManageUser(me, u)) throw new HttpError(403, 'No puedes ver este extracto.');
  const q = new URL(req.url, 'http://x').searchParams, days = Math.min(365, Math.max(1, Number(q.get('days')) || 30));
  const to = new Date(Date.now() + 60000).toISOString(), from = new Date(Date.now() - days * 86400000).toISOString();
  const st = statementOf(u, from, to);
  return { ...st, text: statementText(st), tgLinked: !!u.tgChat };
});
route('POST', '/api/users/:id/statement/send', ['super', 'admin', 'reseller'], async ({ me, params, body }) => {
  const u = userById(params.id);
  if (!canManageUser(me, u)) throw new HttpError(403, 'No puedes enviar este extracto.');
  if (!u.tgChat) throw new HttpError(400, 'No tiene Telegram enlazado. Descárgalo o cópialo y mándaselo.');
  const days = Math.min(365, Math.max(1, Number(body.days) || 30));
  await tg('sendMessage', { chat_id: u.tgChat, text: statementText(statementOf(u, new Date(Date.now() - days * 86400000).toISOString(), new Date(Date.now() + 60000).toISOString())) });
  return { ok: true };
});
route('PUT', '/api/vpay/config', SUPER, ({ me, body }) => lock(async () => {
  const c = db.settings.vpay, num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : d; };
  c.limit = num(body.limit, 0, 1e6, c.limit); c.days = num(body.days, 0, 365, c.days); c.remind = num(body.remind, 0, 60, c.remind);
  c.giftAlert = num(body.giftAlert, 1, 100000, c.giftAlert); c.receipts = !!body.receipts; c.monthly = !!body.monthly;
  addLog('ajustes', null, `Cobros a vendedores: límite ${c.limit ? money2(c.limit) : 'sin límite'}, ${c.days ? c.days + ' días' : 'sin plazo'}, recordatorio ${c.remind ? 'cada ' + c.remind + ' días' : 'apagado'}`, me);
  saveDb();
  return { ok: true };
}));
/* Tareas diarias: recordatorios automáticos y extracto mensual (día 1) */
let vpayDay = null;
function vpayDaily() {
  const t = today(), h = Number(new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', hour12: false }));
  if ((!process.env.DAILY_ANYTIME && h < 10) || vpayDay === t || db.settings.vpayDay === t) return;
  vpayDay = t; db.settings.vpayDay = t;
  const c = db.settings.vpay;
  if (c.remind > 0) for (const u of db.users) {
    if (u.disabled || !u.tgChat) continue;
    const d = debtOf(u);
    if (!d.amount || d.days < c.remind) continue;
    if (u.lastRemind && Date.now() - Date.parse(u.lastRemind) < c.remind * 86400000) continue;
    notifyUser(u, remindText(u)); u.lastRemind = new Date().toISOString();
  }
  if (c.monthly && t.slice(8) === '01') {
    const end = new Date(t + 'T00:00:00').toISOString(), [y, m] = t.split('-').map(Number), start = new Date(`${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01T00:00:00`).toISOString();
    for (const u of db.users) if (!u.disabled && u.tgChat && (u.role === 'reseller' || u.role === 'sub')) { const st = statementOf(u, start, end); if (st.loaded || st.spent || st.debt.amount) notifyUser(u, statementText(st)); }
  }
  lock(async () => saveDb()).catch(() => {});
}

/* ---------- Servidor HTTP ---------- */
/** Comprime con gzip lo que pesa, si el navegador lo acepta: la página carga mucho antes en el móvil */
const wantsGzip = (res) => /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '');
function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length > 2048 && wantsGzip(res)) { res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(body, { level: 6 })); }
  res.writeHead(status, headers);
  res.end(body);
}
let indexCache = null; // { mtime, raw, gz }
function indexFile() {
  const mtime = fs.statSync(INDEX_FILE).mtimeMs;
  if (!indexCache || indexCache.mtime !== mtime) {
    const raw = fs.readFileSync(INDEX_FILE);
    indexCache = { mtime, raw, gz: zlib.gzipSync(raw, { level: 9 }) };
  }
  return indexCache;
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) { reject(new HttpError(413, 'Petición demasiado grande.')); req.destroy(); return; }
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

/* ---------- Estado del servidor: un agente pequeño en el VPS de Emby manda cada minuto CPU, memoria, disco e internet ----------
 * Instalación: el panel da una orden de un solo uso (caduca a las 48 h). Al ejecutarla, el VPS descarga el instalador,
 * que lleva dentro una clave propia del agente (en el panel solo se guarda su huella). Los datos van solo a este panel. */
const AGENT_FILE = path.join(DATA_DIR, 'estado-servidores.json');
const AGENT_KEEP = 24 * 60; // 24 h de muestras de 1 minuto por servidor
let agentData = {}; // sid -> { samples: [...], last, alerts: {} }
try { agentData = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8')) || {}; } catch { agentData = {}; }
let agentDirty = false;
function saveAgents(force) {
  if (!agentDirty && !force) return;
  agentDirty = false;
  try { fs.writeFileSync(AGENT_FILE + '.tmp', JSON.stringify(agentData)); fs.renameSync(AGENT_FILE + '.tmp', AGENT_FILE); } catch (e) { console.error('Estado servidores:', e.message); }
}
setInterval(() => saveAgents(), 5 * 60000).unref();
const agentHash = (t) => crypto.createHash('sha256').update('agente:' + String(t)).digest('hex');
function panelBase(req) {
  const b = db.settings.brand && db.settings.brand.url;
  if (b && /^https?:\/\//.test(b)) return b.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
const agNum = (v, max = 1e15) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
function agentView(s) {
  const a = s.agent || {}, d = agentData[s.id] || {}, last = d.last || null;
  const online = !!(last && Date.now() - Date.parse(last.at) < 3 * 60000);
  // historia de 24 h resumida a puntos de 10 minutos para las gráficas
  const hist = [];
  const src = d.samples || [];
  for (let i = 0; i < src.length; i += 10) {
    const g = src.slice(i, i + 10), avg = (k) => Math.round(g.reduce((n, x) => n + (x[k] || 0), 0) / g.length * 10) / 10;
    hist.push({ at: g[g.length - 1].at, cpu: avg('cpu'), mem: avg('mem'), up: avg('up'), down: avg('down') });
  }
  const pw = power.get(s.id);
  // previsión del disco: lo que ha crecido en las últimas horas
  let diskDays = null;
  const ds = src.filter((x) => x.disk != null);
  if (ds.length >= 360 && last) { const a = ds[0], b = ds[ds.length - 1], hrs = (Date.parse(b.at) - Date.parse(a.at)) / 3600e3, perDay = ((b.disk - a.disk) / hrs) * 24; if (perDay > 0.05) diskDays = Math.round((100 - b.disk) / perDay); }
  return { diskDays, plan: s.powerPlan || null, rescue: !!s.autoRescue, agentVer: last ? Number(last.ver) || 1 : 0, power: pw ? { kind: pw.kind, at: new Date(pw.at).toISOString(), sent: !!pw.sent, waitUntil: pw.waitUntil && pw.waitUntil > Date.now() ? new Date(pw.waitUntil).toISOString() : null } : null, id: s.id, name: s.name, installed: !!a.tokenHash, pending: !!(a.oneHash && a.oneExp > Date.now()) && !a.tokenHash, online, last, hist, since: a.since || null };
}
route('GET', '/api/agent/status', SUPER, () => ({ servers: db.servers.map(agentView) }));
route('POST', '/api/servers/:id/agent/link', SUPER, ({ req, me, params }) => lock(async () => {
  const s = serverById(params.id);
  const one = crypto.randomBytes(24).toString('base64url');
  s.agent = { ...(s.agent || {}), oneHash: agentHash(one), oneExp: Date.now() + 48 * 3600e3 };
  addLog('servidor', null, `Orden de instalación del agente creada para ${s.name}`, me);
  saveDb();
  const url = `${panelBase(req)}/api/agent/install/${one}`;
  return { ok: true, command: `curl -fsSL "${url}" | sudo bash`, expires: new Date(s.agent.oneExp).toISOString() };
}));
route('POST', '/api/servers/:id/agent/remove', SUPER, ({ me, params }) => lock(async () => {
  const s = serverById(params.id);
  delete s.agent; delete agentData[s.id]; agentDirty = true; saveAgents(true);
  addLog('servidor', null, `Agente de ${s.name} quitado del panel`, me);
  saveDb(); return { ok: true };
}));
/* El VPS descarga el instalador con la orden de un solo uso */
route('GET', '/api/agent/install/:one', null, ({ req, params }) => lock(async () => {
  const ip = clientIp(req);
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos.');
  const h = agentHash(params.one);
  const s = db.servers.find((x) => x.agent && x.agent.oneHash === h);
  if (!s || !(s.agent.oneExp > Date.now())) { ipFail(ip); return { __raw: 'echo "La orden de instalación no es válida o ya se usó. Crea una nueva en el panel." >&2; exit 1\n', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }; }
  const token = crypto.randomBytes(32).toString('hex');
  s.agent = { tokenHash: agentHash(token), since: new Date().toISOString() }; // la orden ya no sirve más
  addLog('servidor', null, `Agente instalado en ${s.name} (desde ${ip})`, null);
  saveDb();
  return { __raw: agentInstaller(panelBase(req), token, s.name), headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } };
}));
/* El agente informa cada minuto */
route('POST', '/api/agent/report', null, ({ req, body }) => {
  const ip = clientIp(req);
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos.');
  const tk = String(req.headers['x-agent-token'] || '');
  const s = /^[a-f0-9]{64}$/.test(tk) ? db.servers.find((x) => x.agent && x.agent.tokenHash === agentHash(tk)) : null;
  if (!s) { ipFail(ip); throw new HttpError(403, 'Agente no reconocido.'); }
  const disks = Array.isArray(body.disks) ? body.disks.slice(0, 8).map((x) => ({ mount: str(x.mount, 80), size: agNum(x.size) || 0, used: agNum(x.used) || 0 })).filter((x) => x.size > 0) : [];
  const smp = {
    at: new Date().toISOString(),
    cpu: Math.min(100, agNum(body.cpu, 100) || 0), mem: Math.min(100, agNum(body.mem, 100) || 0),
    memTotal: agNum(body.memTotal) || 0, load: agNum(body.load, 1e4) || 0, cores: agNum(body.cores, 4096) || 0,
    up: agNum(body.up, 1e7) || 0, down: agNum(body.down, 1e7) || 0, // Mbit/s
    disk: disks.reduce((m, x) => Math.max(m, Math.round((x.used / x.size) * 1000) / 10), 0), disks,
    emby: body.emby === true, uptime: agNum(body.uptime, 1e10) || 0, host: str(body.host, 60), os: str(body.os, 80), ver: str(body.ver, 20),
  };
  const d = agentData[s.id] = agentData[s.id] || { samples: [], alerts: {} };
  d.samples.push({ at: smp.at, cpu: smp.cpu, mem: smp.mem, up: smp.up, down: smp.down, disk: smp.disk });
  if (d.samples.length > AGENT_KEEP) d.samples.splice(0, d.samples.length - AGENT_KEEP);
  const wasOff = d.last && Date.now() - Date.parse(d.last.at) > 5 * 60000;
  d.last = smp; agentDirty = true;
  if (wasOff) agentAlert(s, d, 'back', `🟢 El agente de «${s.name}» vuelve a mandar datos.`, 0);
  // vuelve después de un reinicio pedido desde el panel
  const P = power.get(s.id);
  if (P && P.kind === 'vps' && P.sent && smp.uptime < (Date.now() - P.sent) / 1000 + 120) {
    power.delete(s.id);
    notifyStaff('servers', `✅ El VPS de «${s.name}» se ha reiniciado y vuelve a estar en marcha.\n${whenTxt()}`);
    lock(async () => { addLog('servidor', null, `VPS de ${s.name} reiniciado correctamente`, null); saveDb(); }).catch(() => {});
  }
  agentCheck(s, d);
  // orden pendiente (solo «reboot»): se entrega una vez
  if (s.agent.cmd && s.agent.cmd.exp > Date.now()) {
    const cmd = s.agent.cmd; delete s.agent.cmd;
    const pw = power.get(s.id); if (pw) pw.sent = Date.now();
    lock(async () => { addLog('servidor', null, `Orden «${cmd.cmd === 'reboot' ? 'reiniciar VPS' : 'reiniciar Emby'}» entregada al agente de ${s.name}`, null); saveDb(); }).catch(() => {});
    return { ok: true, every: 60, cmd: cmd.cmd };
  }
  return { ok: true, every: 60 };
});
/* ---------- Reiniciar Emby o el VPS (solo el superadministrador, con su contraseña) ---------- */
const power = new Map(); // sid -> { kind: 'emby'|'vps', at, by, sent }
async function viewersOn(s) { try { const l = await emby(s, 'GET', '/Sessions'); return (l || []).filter((x) => x.NowPlayingItem).length; } catch { return null; } }
function powerCheck(me, body) {
  if (me.role !== 'super') throw new HttpError(403, 'Solo el superadministrador puede reiniciar servidores.');
  if (typeof body.password !== 'string' || !checkPassword(me, body.password)) throw new HttpError(403, 'La contraseña no es correcta.');
}
route('GET', '/api/servers/:id/power', SUPER, async ({ params }) => {
  const s = serverById(params.id), d = agentData[s.id], last = d && d.last;
  return { viewers: await viewersOn(s), agent: !!(s.agent && s.agent.tokenHash), agentOnline: !!(last && Date.now() - Date.parse(last.at) < 3 * 60000), agentVer: last ? Number(last.ver) || 1 : 0, busy: power.get(s.id) || null };
});
/* Comprueba si se puede hacer ahora mismo; si no, explica por qué */
async function powerReady(s, kind) {
  const d = agentData[s.id], last = d && d.last, agentOn = !!(s.agent && s.agent.tokenHash && last && Date.now() - Date.parse(last.at) < 3 * 60000), ver = last ? Number(last.ver) || 1 : 0;
  if (kind === 'vps') {
    if (!s.agent || !s.agent.tokenHash) throw new Error('Para reiniciar el VPS hace falta instalar el agente de «Estado del servidor».');
    if (!agentOn) throw new Error('El agente no está conectado ahora mismo: no puede recibir la orden.');
    if (ver < 2) throw new Error('Tu agente es antiguo. Pulsa «Reinstalar» en este servidor y ejecuta la orden nueva en el VPS.');
    return 'agent';
  }
  // Emby: primero por su API; si Emby está colgado y el agente es nuevo, el agente reinicia el servicio
  try {
    const info = await emby(s, 'GET', '/System/Info');
    if (info && info.CanSelfRestart === false) { if (agentOn && ver >= 3) return 'agent'; throw new Error('Este Emby no puede reiniciarse solo. Usa «Reiniciar VPS», o reinstala el agente para que pueda reiniciarlo él.'); }
    return 'api';
  } catch (e) {
    if (agentOn && ver >= 3) return 'agent';
    throw new Error(e.message.startsWith('Este Emby') ? e.message : 'Emby no responde y el agente no está conectado (o es antiguo): no se le puede reiniciar desde aquí. Prueba con «Reiniciar VPS».');
  }
}
/** Hace el reinicio. warn: avisa antes en pantalla a quien esté viendo y espera 2 minutos */
async function powerRun(s, kind, by, warn) {
  const how = await powerReady(s, kind);
  let viewers = 0;
  try {
    const list = (await emby(s, 'GET', '/Sessions')) || [];
    const watching = list.filter((x) => x.NowPlayingItem);
    viewers = watching.length;
    if (warn && viewers) {
      const txt = kind === 'vps' ? 'El servicio se va a reiniciar en 2 minutos para mejorar su funcionamiento. Volverá en unos minutos. Disculpa las molestias.' : 'El servicio se va a reiniciar en 2 minutos. Volverá en un momento. Disculpa las molestias.';
      for (const x of watching) await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: db.settings.brand.name || 'Aviso', Text: txt, TimeoutMs: 30000 }).catch(() => {});
      power.set(s.id, { kind, at: Date.now(), by, waitUntil: Date.now() + 120000 });
      await new Promise((r) => setTimeout(r, Number(process.env.POWER_WARN_MS) || 120000));
    }
  } catch { /* si no se puede leer quién ve, se sigue */ }
  if (how === 'api') await emby(s, 'POST', '/System/Restart');
  else s.agent.cmd = { cmd: kind === 'vps' ? 'reboot' : 'restart-emby', exp: Date.now() + 5 * 60000 };
  power.set(s.id, { kind, at: Date.now(), by });
  const what = kind === 'vps' ? 'el VPS' : 'Emby';
  await lock(async () => { addLog('servidor', null, `Reinicio de ${what} en ${s.name}${by ? ' pedido por ' + by : ' (automático)'}${viewers ? ` · había ${viewers} viendo` : ''}`, null); saveDb(); });
  notifyStaff('servers', `🔄 ${by ? by + ' ha reiniciado' : 'Se ha reiniciado'} ${what} en «${s.name}». ${kind === 'vps' ? 'Vuelve en unos minutos.' : 'Vuelve en uno o dos minutos.'}\n${whenTxt()}`);
}
/** Plan: ahora, cuando nadie vea, o a una hora. Se guarda para que sobreviva a un reinicio del panel */
route('POST', '/api/servers/:id/power-plan', SUPER, async ({ me, params, body }) => {
  powerCheck(me, body);
  const s = serverById(params.id), kind = body.kind === 'vps' ? 'vps' : 'emby', when = ['now', 'idle', 'at'].includes(body.when) ? body.when : 'now';
  try { await powerReady(s, kind); } catch (e) { throw new HttpError(400, e.message); }
  if (power.get(s.id) && !power.get(s.id).plan) throw new HttpError(409, 'Ya hay un reinicio en marcha en este servidor.');
  if (when === 'now') { powerRun(s, kind, me.name, !!body.warn).catch((e) => { power.delete(s.id); notifyStaff('servers', `❌ No se pudo reiniciar en «${s.name}»: ${e.message}`); }); power.set(s.id, { kind, at: Date.now(), by: me.name, waitUntil: body.warn ? Date.now() + 120000 : 0 }); return { ok: true }; }
  let at = null;
  if (when === 'at') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.time || ''));
    if (!m || +m[1] > 23 || +m[2] > 59) throw new HttpError(400, 'Elige la hora.');
    const now = new Date(), t = new Date(now); t.setHours(+m[1], +m[2], 0, 0); if (t <= now) t.setDate(t.getDate() + 1);
    at = t.toISOString();
  }
  await lock(async () => { s.powerPlan = { kind, when, at, warn: !!body.warn, by: me.name, created: new Date().toISOString() }; addLog('servidor', null, `Reinicio de ${kind === 'vps' ? 'VPS' : 'Emby'} en ${s.name} programado (${when === 'idle' ? 'cuando nadie esté viendo' : 'a las ' + body.time})`, me); saveDb(); });
  return { ok: true };
});
route('POST', '/api/servers/:id/power-cancel', SUPER, ({ me, params }) => lock(async () => {
  const s = serverById(params.id); if (!s.powerPlan) return { ok: true };
  delete s.powerPlan; addLog('servidor', null, `Reinicio programado de ${s.name} cancelado`, me); saveDb(); return { ok: true };
}));
route('POST', '/api/servers/:id/rescue', SUPER, ({ me, params, body }) => lock(async () => {
  const s = serverById(params.id); s.autoRescue = !!body.on;
  addLog('servidor', null, `Rescate automático de Emby ${s.autoRescue ? 'activado' : 'desactivado'} en ${s.name}`, me); saveDb(); return { ok: true };
}));
/* Cada minuto: planes pendientes y rescate automático */
let planBusy = false;
async function powerLoop() {
  if (planBusy) return; planBusy = true;
  try {
    for (const s of db.servers) {
      const P = s.powerPlan;
      if (P && !power.get(s.id)) {
        let go = false;
        if (P.when === 'at') go = Date.now() >= Date.parse(P.at);
        else if (Date.now() - Date.parse(P.created) > 24 * 3600e3) { await lock(async () => { delete s.powerPlan; saveDb(); }); notifyStaff('servers', `⏹ El reinicio de «${s.name}» «cuando nadie esté viendo» se canceló: en 24 horas siempre había alguien viendo.`); continue; }
        else { try { go = !((await emby(s, 'GET', '/Sessions')) || []).some((x) => x.NowPlayingItem); } catch { go = false; } }
        if (go) {
          await lock(async () => { delete s.powerPlan; saveDb(); });
          await powerRun(s, P.kind, P.by, P.when === 'at' && P.warn).catch((e) => { power.delete(s.id); notifyStaff('servers', `❌ No se pudo hacer el reinicio programado en «${s.name}»: ${e.message}`); });
        }
      }
      // Rescate: Emby no contesta varios minutos, pero el VPS sí manda datos -> el agente reinicia Emby (máx. 1 vez por hora)
      const h = health.get(s.id), d = agentData[s.id], last = d && d.last;
      if (s.autoRescue && h && h.fails >= 4 && !power.get(s.id) && last && Date.now() - Date.parse(last.at) < 3 * 60000 && (Number(last.ver) || 1) >= 3 && !(s.rescueAt && Date.now() - s.rescueAt < 3600e3)) {
        s.rescueAt = Date.now();
        s.agent.cmd = { cmd: 'restart-emby', exp: Date.now() + 5 * 60000 };
        power.set(s.id, { kind: 'emby', at: Date.now(), by: '' });
        await lock(async () => { addLog('servidor', null, `Rescate automático: Emby de ${s.name} no respondía y se ha reiniciado`, null); saveDb(); });
        notifyStaff('servers', `🛟 Emby de «${s.name}» llevaba unos minutos sin responder, pero el VPS está bien. Lo he reiniciado automáticamente.\n${whenTxt()}`);
      }
    }
  } finally { planBusy = false; }
}
setInterval(() => { powerLoop().catch((e) => console.error('Reinicios:', e.message)); }, Number(process.env.POWER_MS) || 60000).unref();
// Las rutas anteriores siguen funcionando (reinicio inmediato)
route('POST', '/api/servers/:id/restart-emby', SUPER, async ({ me, params, body }) => { powerCheck(me, body); const s = serverById(params.id); try { await powerReady(s, 'emby'); } catch (e) { throw new HttpError(400, e.message); } await powerRun(s, 'emby', me.name, false).catch((e) => { throw new HttpError(502, e.message); }); return { ok: true }; });
route('POST', '/api/servers/:id/reboot-vps', SUPER, async ({ me, params, body }) => { powerCheck(me, body); const s = serverById(params.id); try { await powerReady(s, 'vps'); } catch (e) { throw new HttpError(400, e.message); } await powerRun(s, 'vps', me.name, false); return { ok: true }; });

/** Avisos: cada tipo como mucho una vez por hora */
function agentAlert(s, d, kind, text, gap = 3600e3) {
  d.alerts = d.alerts || {};
  if (gap && d.alerts[kind] && Date.now() - d.alerts[kind] < gap) return;
  d.alerts[kind] = Date.now();
  notifyStaff('servers', `${text}\n${whenTxt()}`);
}
function agentCheck(s, d) {
  const L = d.last, recent = d.samples.slice(-5);
  if (L.disk >= 90) agentAlert(s, d, 'disk', `💾 El disco del servidor «${s.name}» está al ${L.disk}%. Si se llena, Emby puede dejar de funcionar.`, 6 * 3600e3);
  if (recent.length === 5 && recent.every((x) => x.cpu >= 90)) agentAlert(s, d, 'cpu', `🔥 El procesador de «${s.name}» lleva 5 minutos por encima del 90%. Puede que haya demasiadas conversiones de vídeo a la vez.`);
  if (recent.length === 5 && recent.every((x) => x.mem >= 92)) agentAlert(s, d, 'mem', `🧠 La memoria de «${s.name}» lleva 5 minutos por encima del 92%.`);
  if (!L.emby && d.prevEmby !== false) agentAlert(s, d, 'emby', `⚠️ En «${s.name}» no se encuentra Emby funcionando. Revisa el servidor.`, 3600e3);
  d.prevEmby = L.emby;
}
/* Si un agente deja de informar más de 5 minutos, aviso (una vez) */
setInterval(() => {
  for (const s of db.servers) {
    const d = agentData[s.id];
    if (!s.agent || !s.agent.tokenHash || !d || !d.last) continue;
    const mins = (Date.now() - Date.parse(d.last.at)) / 60000;
    if (mins > 5 && !(d.alerts && d.alerts.off > Date.parse(d.last.at))) agentAlert(s, d, 'off', `📡 El agente de «${s.name}» no manda datos desde hace ${Math.round(mins)} minutos. El VPS puede estar apagado o sin internet.`, 0);
  }
}, 60000).unref();

/** Instalador para Ubuntu/Debian (también otras distros con systemd). Solo lee /proc y df; no toca Emby. */
function agentInstaller(base, token, name) {
  const agent = String.raw`#!/bin/bash
# Agente de estado del panel. Solo lee datos de la máquina y los manda al panel cada minuto.
. /etc/panel-agente.conf
read_cpu() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
read_net() { awk -F'[: ]+' 'NR>2 && $2!="lo" && $2!~/^(docker|veth|br-|virbr|tun|tap)/ {rx+=$3; tx+=$11} END{print rx+0, tx+0}' /proc/net/dev; }
CORES=$(nproc 2>/dev/null || echo 1)
HOST=$(hostname 2>/dev/null)
OS=$( (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") | tr -d '"\\' )
set -- $(read_cpu); C1=$1; I1=$2
set -- $(read_net); R1=$1; T1=$2; S1=$(date +%s)
while true; do
  sleep 60
  set -- $(read_cpu); C2=$1; I2=$2
  set -- $(read_net); R2=$1; T2=$2; S2=$(date +%s)
  DT=$((S2-S1)); [ "$DT" -le 0 ] && DT=60
  CPU=$(awk -v a=$((C2-C1)) -v b=$((I2-I1)) 'BEGIN{ if (a>0) printf "%.1f", (a-b)*100/a; else print 0 }')
  DOWN=$(awk -v d=$((R2-R1)) -v t=$DT 'BEGIN{ if (d<0) d=0; printf "%.2f", d*8/t/1000000 }')
  UP=$(awk -v d=$((T2-T1)) -v t=$DT 'BEGIN{ if (d<0) d=0; printf "%.2f", d*8/t/1000000 }')
  C1=$C2; I1=$I2; R1=$R2; T1=$T2; S1=$S2
  MEM=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{ if (t>0) printf "%.1f %d", (t-a)*100/t, t*1024; else print "0 0" }' /proc/meminfo)
  LOAD=$(cut -d' ' -f1 /proc/loadavg)
  UPT=$(cut -d. -f1 /proc/uptime)
  DISKS=$(df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk 'NR>1 && $2>1000000000 {printf "%s{\"mount\":\"%s\",\"size\":%s,\"used\":%s}", (n++?",":""), $6, $2, $3}')
  if pgrep -f -i 'EmbyServer|emby-server|embyserver' >/dev/null 2>&1; then EMBY=true; else EMBY=false; fi
  set -- $MEM
  JSON="{\"cpu\":$CPU,\"mem\":$1,\"memTotal\":$2,\"load\":$LOAD,\"cores\":$CORES,\"up\":$UP,\"down\":$DOWN,\"uptime\":$UPT,\"emby\":$EMBY,\"disks\":[$DISKS],\"host\":\"$HOST\",\"os\":\"$OS\",\"ver\":\"3\"}"
  RESP=$(curl -fsS -m 20 -X POST -H 'Content-Type: application/json' -H "X-Agent-Token: $TOKEN" --data "$JSON" "$PANEL/api/agent/report" 2>/dev/null || true)
  # Única orden que acepta: reiniciar la máquina, pedida por el superadministrador desde el panel
  case "$RESP" in
    *'"cmd":"reboot"'*) logger -t panel-agente "Reinicio del VPS pedido desde el panel"; sleep 3; systemctl reboot ;;
    *'"cmd":"restart-emby"'*) logger -t panel-agente "Reinicio de Emby pedido desde el panel"
      if systemctl list-units --all --type=service 2>/dev/null | grep -q 'emby-server'; then systemctl restart emby-server
      elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qi emby; then docker restart $(docker ps -a --format '{{.Names}}' | grep -i emby | head -n1)
      fi ;;
  esac
done
`;
  const esc1 = (v) => String(v).replace(/'/g, '');
  return `#!/bin/bash
# Instalador del agente «Estado del servidor» para ${esc1(name).replace(/[\r\n]/g, ' ')}
set -e
if [ "$(id -u)" != "0" ]; then echo "Ejecuta la orden con sudo."; exit 1; fi
command -v curl >/dev/null || { echo "Falta curl: instálalo con  apt install -y curl"; exit 1; }
command -v systemctl >/dev/null || { echo "Este sistema no usa systemd: no se puede instalar el agente."; exit 1; }
mkdir -p /opt/panel-agente
cat > /opt/panel-agente/agente.sh <<'AGENTE_EOF'
${agent}AGENTE_EOF
chmod 755 /opt/panel-agente/agente.sh
umask 077
cat > /etc/panel-agente.conf <<'CONF_EOF'
PANEL='${esc1(base)}'
TOKEN='${token}'
CONF_EOF
chmod 600 /etc/panel-agente.conf
cat > /etc/systemd/system/panel-agente.service <<'UNIT_EOF'
[Unit]
Description=Agente de estado del panel
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/panel-agente/agente.sh
Restart=always
RestartSec=30
Nice=10

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now panel-agente >/dev/null 2>&1
systemctl restart panel-agente
echo ""
echo "  Agente instalado y en marcha."
echo "  En 1 o 2 minutos verás los datos en el panel, en Emby > Estado del servidor."
echo ""
echo "  Para quitarlo algún día:"
echo "  sudo systemctl disable --now panel-agente && sudo rm -rf /opt/panel-agente /etc/panel-agente.conf /etc/systemd/system/panel-agente.service"
echo ""
`;
}

/* ---------- Licencias: alquiler del uso del panel por meses ----------
 * Panel principal (sin LICENSE_TOKEN): el superadministrador apunta a quién alquila, hasta qué día ha pagado, y lo renueva.
 * Panel alquilado (con LICENSE_SERVER y LICENSE_TOKEN en Coolify): pregunta al principal cada hora si sigue pagado.
 * Al caducar (más los días de margen) el panel alquilado se pone en pausa; las cuentas Emby de sus clientes NO se tocan. */
const LIC_SERVER = String(process.env.LICENSE_SERVER || '').trim().replace(/\/+$/, '');
const LIC_TOKEN = String(process.env.LICENSE_TOKEN || '').trim();
const LIC_CLIENT = !!(LIC_SERVER && LIC_TOKEN);
const LIC_GRACE = 3; // días de margen tras el vencimiento
const licHash = (t) => crypto.createHash('sha256').update('lic:' + String(t)).digest('hex');
function licDefaults() {
  if (!Array.isArray(db.licenses)) db.licenses = [];
  db.settings.licContact = typeof db.settings.licContact === 'string' ? db.settings.licContact : '';
  if (!db.licState || typeof db.licState !== 'object') db.licState = {};
}
function licView(l) {
  const { tokenHash, ...rest } = l; // la clave nunca sale del panel
  const left = diffDays(l.until, today());
  const state = l.blocked ? 'blocked' : left < -LIC_GRACE ? 'locked' : left < 0 ? 'grace' : left <= 7 ? 'soon' : 'ok';
  return { ...rest, left, state, online: !!l.lastCheck && Date.now() - Date.parse(l.lastCheck) < 3 * 3600e3 };
}
function licFind(id) { const l = db.licenses.find((x) => x.id === Number(id)); if (!l) throw new HttpError(404, 'Esa licencia no existe.'); return l; }
function licGuard() { if (LIC_CLIENT) throw new HttpError(403, 'Este es un panel alquilado: las licencias se llevan desde el panel principal.'); }
function licToken() { return 'cl_' + crypto.randomBytes(24).toString('base64url'); }
function licFields(l, body) {
  if (body.name !== undefined) { const n = str(body.name, 60); if (!n) throw new HttpError(400, 'Pon un nombre.'); l.name = n; }
  if (body.url !== undefined) { const u = str(body.url, 200).replace(/\/+$/, ''); if (u && !/^https?:\/\/[^\s/]+/i.test(u)) throw new HttpError(400, 'La dirección debe empezar por http:// o https://'); l.url = u; }
  if (body.contact !== undefined) l.contact = str(body.contact, 80);
  if (body.notes !== undefined) l.notes = str(body.notes, 300);
  if (body.price !== undefined) { const p = Math.round(Number(body.price) * 100) / 100; if (!(p >= 0) || p > 100000) throw new HttpError(400, 'El precio no es válido.'); l.price = p; }
  if (body.until !== undefined) { const d = str(body.until, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'La fecha no es válida.'); l.until = d; }
}
route('GET', '/api/licenses', SUPER, () => { licGuard(); return { list: db.licenses.map(licView), contact: db.settings.licContact, grace: LIC_GRACE, today: today() }; });
route('POST', '/api/licenses', SUPER, ({ me, body }) => lock(async () => {
  licGuard();
  const months = Math.round(Number(body.months));
  if (!(months >= 0 && months <= 36)) throw new HttpError(400, 'Los meses no son válidos.');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start || '')) ? body.start : today();
  const token = licToken(), id = (db.licenses.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  const l = { id, name: '', url: '', contact: '', notes: '', price: 0, start, until: months ? addMonths(start, months) : addDays(start, 0), blocked: false, payments: [], createdAt: new Date().toISOString(), tokenHash: licHash(token) };
  licFields(l, { ...body, until: undefined });
  if (months && body.paid !== false) l.payments.push({ at: new Date().toISOString(), months, amount: Math.round((Number(body.amount ?? l.price * months) || 0) * 100) / 100, until: l.until, method: str(body.method, 30) });
  db.licenses.push(l);
  addLog('ajustes', null, `Licencia nueva para ${l.name}: pagado hasta el ${l.until}`, me);
  saveDb();
  return { ok: true, lic: licView(l), token };
}));
route('PUT', '/api/licenses/contact', SUPER, ({ body }) => lock(async () => { licGuard(); db.settings.licContact = str(body.contact, 120); saveDb(); return { ok: true }; }));
route('PUT', '/api/licenses/:id', SUPER, ({ me, body, params }) => lock(async () => {
  licGuard(); const l = licFind(params.id), before = l.until;
  licFields(l, body);
  if (l.until !== before) { l.warned = {}; addLog('ajustes', null, `Licencia de ${l.name}: fecha cambiada a mano del ${before} al ${l.until}`, me); }
  saveDb(); return { ok: true, lic: licView(l) };
}));
route('POST', '/api/licenses/:id/renew', SUPER, ({ me, body, params }) => lock(async () => {
  licGuard(); const l = licFind(params.id);
  const months = Math.round(Number(body.months));
  if (!(months >= 1 && months <= 36)) throw new HttpError(400, 'Elige cuántos meses.');
  const base = l.until > today() ? l.until : today(); // si ya había caducado, cuenta desde hoy
  l.until = addMonths(base, months); l.warned = {};
  const amount = Math.round((Number(body.amount ?? (l.price || 0) * months) || 0) * 100) / 100;
  l.payments.push({ at: new Date().toISOString(), months, amount, until: l.until, method: str(body.method, 30) });
  if (l.payments.length > 200) l.payments.splice(0, l.payments.length - 200);
  addLog('ajustes', null, `Licencia de ${l.name} renovada ${months} ${months === 1 ? 'mes' : 'meses'}: pagado hasta el ${l.until}`, me);
  saveDb(); return { ok: true, lic: licView(l) };
}));
route('POST', '/api/licenses/:id/block', SUPER, ({ me, body, params }) => lock(async () => {
  licGuard(); const l = licFind(params.id); l.blocked = !!body.blocked;
  addLog('ajustes', null, `Licencia de ${l.name} ${l.blocked ? 'bloqueada' : 'desbloqueada'} a mano`, me);
  saveDb(); return { ok: true, lic: licView(l) };
}));
route('POST', '/api/licenses/:id/token', SUPER, ({ me, params }) => lock(async () => {
  licGuard(); const l = licFind(params.id), token = licToken(); l.tokenHash = licHash(token);
  addLog('seguridad', null, `Clave de licencia de ${l.name} cambiada`, me);
  saveDb(); return { ok: true, token };
}));
route('DELETE', '/api/licenses/:id', SUPER, ({ me, params }) => lock(async () => {
  licGuard(); const l = licFind(params.id); db.licenses = db.licenses.filter((x) => x !== l);
  addLog('ajustes', null, `Licencia de ${l.name} borrada`, me);
  saveDb(); return { ok: true };
}));
/* Lo llaman los paneles alquilados (sin sesión, con su clave) */
route('POST', '/api/license/check', null, ({ req }) => {
  const ip = clientIp(req);
  if (LIC_CLIENT) throw new HttpError(404, 'No encontrado.');
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos. Espera un rato.');
  const tk = String(req.headers['x-license-token'] || '');
  const l = tk.length > 10 && tk.length < 100 ? db.licenses.find((x) => x.tokenHash === licHash(tk)) : null;
  if (!l) { ipFail(ip); throw new HttpError(404, 'Clave de licencia no válida.'); }
  const first = !l.lastCheck;
  l.lastCheck = new Date().toISOString(); l.lastIp = ip.slice(0, 45);
  if (first || !l._saved || Date.now() - l._saved > 3600e3) { l._saved = Date.now(); saveDb(); }
  return { ok: true, name: l.name, until: l.until, blocked: !!l.blocked, grace: LIC_GRACE, contact: db.settings.licContact || '', today: today() };
});
/* Avisos diarios en el panel principal: 7, 3 y 1 día antes, el día que vence y cuando se pausa */
function licDaily() {
  if (LIC_CLIENT) return;
  let changed = false;
  for (const l of db.licenses) {
    if (l.blocked) continue;
    const left = diffDays(l.until, today());
    const th = left === 7 || left === 3 || left === 1 || left === 0 ? String(left) : left === -LIC_GRACE - 1 ? 'off' : null;
    if (!th) continue;
    l.warned = l.warned || {};
    const k = l.until + ':' + th;
    if (l.warned[k]) continue;
    l.warned[k] = 1; changed = true;
    const txt = th === 'off' ? `⛔ El panel alquilado de ${l.name} se ha puesto en pausa: venció el ${l.until} y no se ha renovado.`
      : th === '0' ? `📅 Hoy vence la licencia del panel de ${l.name}. Tiene ${LIC_GRACE} días de margen antes de pausarse.`
      : `📅 La licencia del panel de ${l.name} vence en ${th} ${th === '1' ? 'día' : 'días'} (el ${l.until}).`;
    notifyStaff('license', txt + (l.price ? `\nPrecio: ${l.price} € al mes.` : ''));
  }
  if (changed) saveDb();
}

/* ---- Lado del panel alquilado ---- */
function licStatus() {
  if (!LIC_CLIENT) return null;
  const st = db.licState || {};
  const base = { contact: st.contact || '', until: st.until || null, lastOk: st.lastOk || null };
  if (st.invalid) return { ...base, state: 'locked', reason: 'invalid' };
  if (!st.until) return { ...base, state: 'pending' };
  if (st.blocked) return { ...base, state: 'locked', reason: 'blocked' };
  const left = diffDays(st.until, today()), grace = Number.isFinite(st.grace) ? st.grace : LIC_GRACE;
  if (left < -grace) return { ...base, state: 'locked', reason: 'expired', left };
  if (left < 0) return { ...base, state: 'grace', left, lockOn: addDays(st.until, grace + 1) };
  return { ...base, state: left <= 7 ? 'soon' : 'ok', left };
}
const licLocked = () => { const s = licStatus(); return !!s && s.state === 'locked'; };
let licBusy = false, licTry = 0;
async function licCheck() {
  if (!LIC_CLIENT || licBusy) return;
  licBusy = true; licTry = Date.now();
  try {
    const r = await fetch(LIC_SERVER + '/api/license/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-License-Token': LIC_TOKEN }, body: '{}', signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const before = licStatus();
    if (r.ok && j.ok && /^\d{4}-\d{2}-\d{2}$/.test(String(j.until))) {
      db.licState = { ...db.licState, until: j.until, blocked: !!j.blocked, grace: Number(j.grace) || LIC_GRACE, contact: str(j.contact, 120), invalid: false, lastOk: new Date().toISOString(), err: '' };
    } else if (r.status === 404) { // la clave no existe en el panel principal (borrada o mal copiada)
      db.licState = { ...db.licState, invalid: true, lastOk: new Date().toISOString(), err: 'clave' };
    } else db.licState = { ...db.licState, err: 'Respuesta ' + r.status }; // fallo pasajero: se queda con lo último que sabía
    const now = licStatus();
    if (before && now && before.state === 'locked' && now.state !== 'locked') addLog('ajustes', null, 'Licencia renovada: el panel vuelve a funcionar', null);
    licWarn(now);
    saveDb();
  } catch (e) { db.licState = { ...db.licState, err: 'Sin conexión con el panel principal' }; }
  finally { licBusy = false; }
}
function licWarn(s) {
  if (!s || !s.until) return;
  const th = s.state === 'locked' ? 'off' : s.state === 'grace' ? 'grace' : s.left === 7 || s.left === 3 || s.left === 1 || s.left === 0 ? String(s.left) : null;
  if (!th) return;
  const w = db.licState.warned = db.licState.warned || {}, k = s.until + ':' + th + (s.reason ? ':' + s.reason : '');
  if (w[k]) return; w[k] = 1;
  const who = s.contact ? `\nPara renovar: ${s.contact}` : '';
  const txt = th === 'off' ? (s.reason === 'expired' ? `⛔ Tu panel está en pausa porque la suscripción venció el ${s.until}.` : '⛔ Tu panel está en pausa.') + ` Las cuentas de tus clientes siguen funcionando.${who}`
    : th === 'grace' ? `⚠️ Tu suscripción al panel venció el ${s.until}. El panel se pondrá en pausa el ${s.lockOn} si no la renuevas.${who}`
    : th === '0' ? `📅 Tu suscripción al panel vence hoy.${who}` : `📅 Tu suscripción al panel vence en ${th} ${th === '1' ? 'día' : 'días'} (el ${s.until}).${who}`;
  for (const u of db.users) if (u.role === 'super' && !u.disabled) notifyUser(u, txt);
}
route('POST', '/api/license/recheck', null, async () => {
  if (!LIC_CLIENT) throw new HttpError(404, 'No encontrado.');
  if (Date.now() - licTry > 5000) await licCheck();
  return { ok: true, license: licStatus() };
});

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const t0 = Date.now(); res.on('finish', () => { const ms = Date.now() - t0; if (ms > 3000 && pathname.startsWith('/api/')) console.warn(`Petición lenta: ${req.method} ${pathname} tardó ${ms} ms`); });
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const f = indexFile(), gz = wantsGzip(res);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
        'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      });
      return res.end(gz ? f.gz : f.raw);
    }
    if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'No encontrado.' });
    if (req.method === 'POST' && (pathname === '/api/pay/stripe/webhook' || pathname === '/api/pay/nowpayments/ipn')) return await payWebhook(req, res, pathname);
    // Panel alquilado en pausa: solo se responde lo justo para mostrar el aviso
    if (LIC_CLIENT && licLocked() && !['/api/state', '/api/license/recheck', '/api/logout', '/api/agent/report'].includes(pathname)) return send(res, 423, { error: 'El panel está en pausa: la suscripción ha caducado.', licLocked: true });
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
        if (me.mustPw && !['/api/my-password', '/api/data', '/api/logout'].includes(pathname)) return send(res, 403, { error: 'Antes de seguir, cambia la contraseña que te dieron.', mustPw: true });
      }
      let body = {};
      if (req.method !== 'GET') {
        if (req.method !== 'DELETE' && !/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Formato no admitido.');
        body = await readBody(req, pathname === '/api/backup/restore' || pathname === '/api/backup/verify' ? 60e6 : 1e6);
      }
      const result = await r.handler({ req, res, body, me, params: m.groups || {} });
      if (result && result.__raw) { res.writeHead(200, result.headers); return res.end(result.__raw); }
      return send(res, 200, result);
    }
    send(res, 404, { error: 'No encontrado.' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e.embyStatus !== undefined ? 502 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Error interno.' });
  }
});

loadDb();
/* Rescate desde la terminal (Coolify › Terminal, o la ventana del servidor):
 *   node server.js clave NUEVACLAVE [usuario]   -> pone una contraseña nueva (por defecto al superadministrador)
 *   node server.js sin2fa [usuario]             -> quita la verificacion en dos pasos (si perdiste el movil)
 * La orden se deja en data/rescate.json y el panel la aplica en unos segundos, aunque este en marcha. */
const RESCUE_FILE = path.join(DATA_DIR, 'rescate.json');
function applyRescue() {
  if (!fs.existsSync(RESCUE_FILE)) return;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(RESCUE_FILE, 'utf8')); } catch { list = []; }
  try { fs.unlinkSync(RESCUE_FILE); } catch { /* ya no esta */ }
  for (const a of Array.isArray(list) ? list : []) {
    const u = a.user ? db.users.find((x) => x.username === String(a.user).toLowerCase()) : db.users.find((x) => x.role === 'super');
    if (!u) { console.log('Rescate: no existe el usuario', a.user); continue; }
    if (a.do === 'clave' && a.salt && a.hash) { u.salt = a.salt; u.hash = a.hash; u.disabled = false; dropSessions(u.id); addLog('seguridad', null, `Contraseña de ${u.username} cambiada desde la terminal`, null); }
    if (a.do === 'sin2fa') { delete u.totp; dropSessions(u.id); addLog('seguridad', null, `Verificación en dos pasos de ${u.username} quitada desde la terminal`, null); }
    console.log(`Rescate aplicado a ${u.username}: ${a.do}`);
  }
  saveDb();
}
if (process.argv[2] === 'clave' || process.argv[2] === 'sin2fa') {
  const act = process.argv[2];
  const boss = db.users.find((u) => u.role === 'super');
  if (!boss) { console.log('Todavia no hay superadministrador: abre el panel y crealo.'); process.exit(1); }
  const who = act === 'clave' ? process.argv[4] : process.argv[3];
  const target = who ? db.users.find((u) => u.username === who.toLowerCase()) : boss;
  if (!target) { console.log(`No existe el usuario ${who}.`); process.exit(1); }
  const order = { do: act, user: target.username };
  if (act === 'clave') {
    const pw = process.argv[3] || '';
    if (pw.length < 8) { console.log('Uso: node server.js clave NUEVACLAVE [usuario]  (minimo 8 caracteres)'); process.exit(1); }
    order.salt = crypto.randomBytes(16).toString('hex'); order.hash = hashPassword(pw, order.salt);
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(RESCUE_FILE, 'utf8')); } catch { list = []; }
  list.push(order);
  fs.writeFileSync(RESCUE_FILE, JSON.stringify(list));
  console.log(act === 'clave' ? `Hecho. En unos segundos la contraseña de ${target.username} sera la nueva.` : `Hecho. En unos segundos ${target.username} podra entrar sin el codigo del movil. Vuelve a activarlo en Ajustes, Seguridad.`);
  process.exit(0);
}
applyRescue();
setInterval(() => { try { applyRescue(); } catch (e) { console.error('Rescate:', e.message); } }, 5000);
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Panel de cuentas Emby en marcha');
  console.log(`  Abre en el navegador:  http://localhost:${PORT}`);
  console.log('  Deja esta ventana abierta. Para parar el panel, cierrala.');
  console.log('');
  const live = () => !licLocked(); // en pausa el panel no toca nada de Emby: las cuentas se quedan como estaban
  if (live()) runLifecycle();
  let ticks = 0;
  setInterval(() => { if (++ticks % 60 === 0) { backupDb(); lock(async () => pruneRecords()).catch(() => {}); } if (live()) runLifecycle(); }, CHECK_EVERY_MS);
  if (LIC_CLIENT) { const lLoop = () => { licCheck().finally(() => { const s = licStatus(); setTimeout(lLoop, Number(process.env.LICENSE_MS) || (s && s.state !== 'ok' ? 5 * 60000 : 3600e3)); }); }; setTimeout(lLoop, 2000); }
  // Al apagar (Redeploy en Coolify) se guarda lo pendiente del historial de conexiones
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { saveConn(true); } catch { /* nada */ } try { saveAgents(true); } catch { /* nada */ } process.exit(0); });
  const dLoop = () => { try { licDaily(); } catch (e) { console.error('Licencias:', e.message); } if (live()) try { vpayDaily(); } catch (e) { console.error('Cobros:', e.message); } if (live()) try { dailySummary(); } catch (e) { console.error('Resumen diario:', e.message); } setTimeout(dLoop, Number(process.env.DAILY_MS) || 60000); };
  setTimeout(dLoop, Number(process.env.DAILY_MS) || 30000);
  const qLoop = () => { (live() ? qualityDaily() : Promise.resolve()).catch((e) => console.error('Revisión de calidad:', e.message)).finally(() => setTimeout(qLoop, Number(process.env.QDAILY_MS) || 60000)); };
  setTimeout(qLoop, Number(process.env.QDAILY_MS) || 20000);
  const satLoop = () => { (live() ? saturationCheck() : Promise.resolve()).catch((e) => console.error('Saturación:', e.message)).finally(() => setTimeout(satLoop, Number(process.env.SAT_MS) || 60000)); };
  setTimeout(satLoop, Number(process.env.SAT_MS) || 15000);
  // vigilancia de transcodificacion y sesiones, cada tantos segundos como diga Ajustes, Tiempos
  const watch = () => { Promise.resolve(live() && monitor()).catch(() => {}).finally(() => setTimeout(watch, Number(process.env.MONITOR_MS) || (db.settings.monitorSec || 30) * 1000)); };
  setTimeout(watch, 3000);
  setInterval(() => live() && screenNotices(), Number(process.env.NOTICE_MS) || 60000); // aviso de vencimiento en la pantalla de Emby
  setInterval(() => { backupJob().catch(() => {}); }, Number(process.env.BACKUP_MS) || 10 * 60000);
  const usageLoop = () => { (live() ? recordUsage() : Promise.resolve()).catch((e) => console.error('Estadísticas:', e.message)).finally(() => setTimeout(usageLoop, PLAY_MS)); };
  setTimeout(usageLoop, 8000);
  const watchLoop = () => { (live() ? watchServers() : Promise.resolve()).catch(() => {}).finally(() => setTimeout(watchLoop, Number(process.env.WATCH_MS) || 60000)); };
  setTimeout(watchLoop, 5000);
  setInterval(() => live() && telegramPoll(), Number(process.env.TG_POLL_MS) || 5000); // mensajes que llegan al bot de Telegram
});
