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
// App propia para los clientes (ver «App propia para los clientes» más abajo)
const APP_DIR = path.join(DATA_DIR, 'app'), APP_APK = path.join(APP_DIR, 'app.apk');
const APP_MAX = 400 * 1024 * 1024;
const APP_DEF = { name: 'SERVICLUB', client: 'SERVICLUB', version: '', code: 0, pkg: '', size: 0, at: '', file: false, downloads: 0, inMsg: true, tag: true,
  only: { on: false, apple: true, allow: '', message: 'Para ver el contenido usa nuestra app oficial {app}. Descárgala aquí: {link}' }, history: [] };
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'copias');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CHECK_EVERY_MS = 60 * 1000;

/* Alertas: los dos modulos vienen apagados; los enciende un administrador */
const DEFAULT_ALERTS = {
  transcode: { on: false, stop: true, tip: true, tipEvery: 30, tipText: '', onlyVideo: true, retention: 30, message: 'Tu app está convirtiendo el vídeo y eso satura el servidor. Ve a Ajustes › Reproducción › Velocidad de transmisión máx. y elige la más alta (1000 Mbit/s o la máxima que tenga). Así se verá fluido.' },
  sessions: { on: false, stop: false, logout: true, retention: 30, grace: 5, policy: 'newest', message: 'Has superado el número de pantallas de tu cuenta. Se ha detenido esta reproducción.' },
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
  3: { 1: 3, 2: 3, 4: 6 },
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
const DEFAULT_SETTINGS = { pauseStop: { on: true, minutes: 15 }, graceDays: 5, purgeDays: 30, demoPurgeDays: 1, warnDays: 7, demoMax: 3, demoHours: [2, 4, 12], monitorSec: 30, liveSec: 15, currency: 'EUR', creditPrice: 0,
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
  // Precios en euros para clientes (meses-pantallas). Por defecto, la tarifa del propietario
  db.settings.clientPay = { on: false, desc: 'Suscripción', prices: { '1-1': 7.5, '1-2': 12, '1-3': 16, '1-4': 19, '3-1': 19, '3-2': 27, '3-3': 34, '3-4': 41, '6-1': 38, '6-2': 48, '6-3': 55, '6-4': 65, '12-1': 65, '12-2': 90, '12-3': 105, '12-4': 120 }, ...(db.settings.clientPay || {}) };
  { const ap = db.settings.app || {}; db.settings.app = { ...APP_DEF, ...ap, only: { ...APP_DEF.only, ...(ap.only || {}) }, history: Array.isArray(ap.history) ? ap.history : [] }; db.settings.app.file = fs.existsSync(APP_APK); }
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
  // Una sola vez (v130): los mensajes propios de los vendedores vuelven a ser los del superadministrador.
  // Los suyos se guardan aparte (templatesOld) por si acaso; pueden volver a personalizarlos cuando quieran.
  if (!db.settings.tplReset1) {
    for (const u of db.users) if (u.role !== 'super' && u.templates) { u.templatesOld = u.templates; delete u.templates; }
    db.settings.tplReset1 = true;
  }
  // Fecha en que cada cliente aceptó el bot de Telegram (para las cuentas enlazadas antes de guardarla, se saca del registro)
  if (db.clients.some((c) => c.tgChat && !c.tgAt)) {
    const when = new Map();
    for (const l of db.log || []) if (l.clientId && l.type === 'aviso' && /^Telegram enlazado para/.test(l.text || '') && !when.has(l.clientId)) when.set(l.clientId, l.ts);
    for (const c of db.clients) if (c.tgChat && !c.tgAt && when.has(c.id)) c.tgAt = when.get(c.id);
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
  if (server && server.kind === 'jellyfin') return jelly(server, method, p, body); // Jellyfin va por su propio camino; Emby sigue igual
  let res;
  try {
    // La clave va en la cabecera y también en la dirección (api_key): algunos proxys delante de Emby quitan las cabeceras
    const sep = p.includes('?') ? '&' : '?';
    res = await fetch(server.url + '/emby' + p + sep + 'api_key=' + encodeURIComponent(server.apiKey || ''), {
      method,
      headers: { 'X-Emby-Token': server.apiKey, 'X-Emby-Authorization': `MediaBrowser Client="Concha", Device="Panel", DeviceId="concha-panel", Version="1.0", Token="${server.apiKey || ''}"`, 'User-Agent': 'Mozilla/5.0 (Concha panel)', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
    const web = /<html|<!doctype|cloudflare|nginx|access denied/i.test(text);
    if ((res.status === 401 || res.status === 403) && web) msg = `Algo delante de "${server.name}" (un cortafuegos o Cloudflare) bloquea al panel antes de llegar a Emby. Usa en «Dirección para el panel» la IP con el puerto (http://IP:8096) o pide que dejen pasar la IP del panel.`;
    else if (res.status === 401 || res.status === 403) msg = `"${server.name}" ha rechazado la API key. Crea una nueva en Emby (Ajustes › Avanzado › Claves de API) y pégala aquí.`;
    else if (res.status === 404) msg = `Emby no encuentra ese usuario o recurso en "${server.name}".`;
    else msg = `Emby respondió con error ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
    const err = new Error(msg);
    err.embyStatus = res.status;
    throw err;
  }
  if (!text) return null;
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  // Rutas que siempre deben devolver una lista: si llega { Items: [...] } se saca la lista;
  // si llega una página web (un proxy delante de Emby), se avisa en vez de romper el panel.
  if (method === 'GET' && /^\/(Users|Sessions|Library\/VirtualFolders|Library\/SelectableMediaFolders)(\?|$)/.test(p) && !Array.isArray(data)) {
    if (data && Array.isArray(data.Items)) return data.Items;
    const err = new Error(`"${server.name}" no ha contestado como Emby. Revisa que la «Dirección para el panel» lleve directamente a Emby (mejor la IP con el puerto, por ejemplo http://IP:8096).`);
    err.embyStatus = 502;
    throw err;
  }
  return data;
}
/* ---------- Jellyfin ----------
 * Jellyfin nació de Emby y su API es casi igual. Aquí se traducen las pocas diferencias para que el resto del panel
 * (crear, renovar, caducar, reparar, monitor…) funcione igual sin tocar nada de lo que usa Emby:
 *  - sin el prefijo /emby y con la cabecera Authorization: MediaBrowser Token="…"
 *  - el límite de pantallas se llama MaxActiveSessions (en Emby, SimultaneousStreamLimit)
 *  - las bibliotecas se identifican por ItemId (en Emby, Guid)
 */
const JF_LISTS = /^\/(Users|Sessions|Library\/VirtualFolders|Library\/SelectableMediaFolders|Library\/MediaFolders)(\?|$)/;
function jfUserIn(u) { if (u && u.Policy && u.Policy.SimultaneousStreamLimit === undefined) u.Policy.SimultaneousStreamLimit = Number(u.Policy.MaxActiveSessions) || 0; return u; }
/* Pantallas en Jellyfin: su límite (MaxActiveSessions) cuenta los aparatos con la sesión abierta y solo se mira al entrar.
   Con el número justo, un cliente que reinstala la app o cambia de aparato sin cerrar sesión se queda fuera.
   Por eso se deja 1 aparato de margen al entrar; lo que se vea de más lo corta el control de pantallas del panel. */
const JF_MARGIN = 1;
/** ¿El límite que tiene el servidor es el que toca para esas pantallas? (en Jellyfin vale con margen o sin él, el de antes) */
function scrOk(s, pol, screens) { const v = Number(pol && pol.SimultaneousStreamLimit) || 0; return s && s.kind === 'jellyfin' ? v === screens + JF_MARGIN || v === screens : v === screens; }
/** Pantallas que equivalen al límite del servidor (en Jellyfin se descuenta el margen) */
const scrOf = (s, pol) => { const v = Number(pol && pol.SimultaneousStreamLimit) || 0; return s && s.kind === 'jellyfin' && v > 1 ? v - JF_MARGIN : v; };
async function jelly(server, method, p, body, raw) {
  // Jellyfin no tiene /Users/Query: se pide la lista entera y se da por páginas
  const uq = method === 'GET' && /^\/Users\/Query\?/.exec(p);
  if (uq) {
    const q = new URLSearchParams(p.split('?')[1]), start = Number(q.get('StartIndex')) || 0, lim = Number(q.get('Limit')) || 1000;
    const all = (await jelly(server, 'GET', '/Users')) || [];
    return { Items: all.slice(start, start + lim), TotalRecordCount: all.length };
  }
  // Contraseña: la ruta /Users/{id}/Password está «en retirada» en Jellyfin; si un día desaparece, se usa la nueva
  const pw = !raw && method === 'POST' && /^\/Users\/([^/?]+)\/Password$/.exec(p);
  if (pw) {
    try { return await jelly(server, 'POST', p, body, true); }
    catch (e) {
      if (e.embyStatus !== 404 && e.embyStatus !== 405) throw e;
      return jelly(server, 'POST', `/Users/Password?userId=${encodeURIComponent(pw[1])}`, body, true);
    }
  }
  let out = body;
  if (method === 'POST' && /^\/Users\/[^/]+\/Policy$/.test(p) && body) {
    out = { ...body };
    if (out.SimultaneousStreamLimit !== undefined) { const n = Number(out.SimultaneousStreamLimit) || 0; out.MaxActiveSessions = n > 0 ? n + JF_MARGIN : 0; delete out.SimultaneousStreamLimit; }
    delete out.AutoRemoteQuality; // ajuste que solo tiene Emby
    // Jellyfin exige estos dos campos al guardar la política: si faltan, se ponen los de por defecto
    if (!out.AuthenticationProviderId) out.AuthenticationProviderId = 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider';
    if (!out.PasswordResetProviderId) out.PasswordResetProviderId = 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider';
  }
  let res;
  const auth = `MediaBrowser Client="Concha", Device="Panel", DeviceId="concha-panel", Version="1.0", Token="${server.apiKey || ''}"`;
  try {
    res = await fetch(server.url + p, {
      method,
      headers: { Authorization: auth, 'X-Emby-Authorization': auth, 'X-Emby-Token': server.apiKey || '', 'User-Agent': 'Mozilla/5.0 (Concha panel)', Accept: 'application/json', ...(out ? { 'Content-Type': 'application/json' } : {}) },
      body: out ? JSON.stringify(out) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'no responde' : ((e.cause && e.cause.code) || 'sin conexión');
    const err = new Error(`No se pudo conectar con "${server.name}" (${why}). Revisa que Jellyfin esté encendido y la dirección sea correcta.`);
    err.embyStatus = 0;
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg;
    const web = /<html|<!doctype|cloudflare|nginx|access denied/i.test(text);
    if ((res.status === 401 || res.status === 403) && web) msg = `Algo delante de "${server.name}" (un cortafuegos o Cloudflare) bloquea al panel antes de llegar a Jellyfin. Usa en «Dirección para el panel» la IP con el puerto (http://IP:8096).`;
    else if (res.status === 401 || res.status === 403) msg = `"${server.name}" ha rechazado la API key. Crea una nueva en Jellyfin (Panel de control › Claves de API) y pégala aquí.`;
    else if (res.status === 404) msg = `Jellyfin no encuentra ese usuario o recurso en "${server.name}".`;
    else if (res.status === 400 && p === '/Users/New' && /already exists/i.test(text)) msg = `Ese nombre de usuario ya existe en "${server.name}". Elige otro.`;
    else if (res.status === 400 && p === '/Users/New' && /usernames can contain/i.test(text)) msg = 'Jellyfin no acepta ese nombre de usuario. Usa solo letras, números, guiones (-), guiones bajos (_), puntos (.) o arroba (@), sin espacios al principio ni al final.';
    else msg = `Jellyfin respondió con error ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
    const err = new Error(msg);
    err.embyStatus = res.status;
    throw err;
  }
  if (!text) return null;
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (method === 'GET' && JF_LISTS.test(p) && !Array.isArray(data)) {
    if (data && Array.isArray(data.Items)) data = data.Items;
    else { const err = new Error(`"${server.name}" no ha contestado como Jellyfin. Revisa que la «Dirección para el panel» lleve directamente a Jellyfin (mejor la IP con el puerto, por ejemplo http://IP:8096).`); err.embyStatus = 502; throw err; }
  }
  // Respuestas con la forma que espera el resto del panel
  if (method === 'GET' && /^\/Users(\/[^/?]+)?(\?|$)/.test(p)) { if (Array.isArray(data)) data.forEach(jfUserIn); else jfUserIn(data); }
  if (method === 'GET' && /^\/Library\/VirtualFolders/.test(p) && Array.isArray(data)) data.forEach((f) => { if (!f.Guid && f.ItemId) f.Guid = f.ItemId; });
  if (method === 'GET' && /^\/Sessions(\?|$)/.test(p) && Array.isArray(data)) data.forEach((x) => { const ti = x && x.TranscodingInfo; if (ti && typeof ti.TranscodeReasons === 'string') ti.TranscodeReasons = ti.TranscodeReasons.split(/\s*,\s*/).filter(Boolean); });
  if (method === 'POST' && p === '/Users/New') jfUserIn(data);
  return data;
}
/** Una sola vez: a las cuentas de Jellyfin que tenían el límite justo se les pone el margen de 1 aparato (solo ese ajuste) */
async function jfMarginOnce() {
  if (db.settings.jfMargin1 || !db.servers.some((x) => x.kind === 'jellyfin')) return;
  let done = 0, failed = 0;
  for (const c of db.clients) {
    const s = db.servers.find((x) => x.id === c.serverId);
    if (!s || s.kind !== 'jellyfin' || s.off || c.status !== 'active' || c.off || !(c.screens > 0)) continue;
    try {
      await lock(async () => { // leer-cambiar-escribir sin que nadie toque la cuenta a la vez
        if (c.status !== 'active' || c.off) return;
        const pol = await readPolicy(s, c.embyId);
        if ((Number(pol.MaxActiveSessions) || 0) !== c.screens) return; // ya tiene margen, o algo distinto que no se toca
        pol.SimultaneousStreamLimit = c.screens;
        await emby(s, 'POST', `/Users/${c.embyId}/Policy`, pol);
        done++;
      });
    } catch { failed++; }
  }
  if (failed) return; // se vuelve a intentar en el próximo arranque
  db.settings.jfMargin1 = true;
  if (done) addLog('servidor', null, `Jellyfin: margen de 1 aparato al entrar puesto en ${done} ${done === 1 ? 'cuenta' : 'cuentas'}`, null);
  saveDb();
}
/** Guardián de bibliotecas: cada 15 minutos mira en cada servidor si alguna cuenta ACTIVA del panel se ha quedado
    sin bibliotecas o desactivada (por otro programa, a mano en Emby…). Si es así, se las vuelve a poner sola y lo apunta. */
let libGuardBusy = false;
async function libGuard() {
  if (libGuardBusy) return;
  libGuardBusy = true;
  const fixed = [], failed = [];
  try {
    for (const s of db.servers) {
      const mine = db.clients.filter((c) => c.serverId === s.id && c.status === 'active' && !c.off);
      if (!mine.length) continue;
      let users;
      try { ({ users } = await embyAllUsers(s)); } catch { continue; } // servidor caído: ya avisa la vigilancia
      const byId = new Map(users.map((u) => [u.Id, u]));
      for (const c of mine) {
        const u = byId.get(c.embyId), pol = u && u.Policy;
        if (!pol) continue; // usuario borrado o sin datos: eso lo trata Reparar / Auditoría
        if (polHasLibs(pol) && !pol.IsDisabled) { c.libsOkAt = new Date().toISOString(); continue; }
        try {
          await lock(async () => {
            // dentro del cerrojo se vuelve a mirar todo: puede haber cambiado mientras tanto
            const valid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
            if (c.status !== 'active' || c.off || !valid || c.serverId !== s.id) return;
            if (c.quality && !packageReady(s, c.quality)) throw new Error(`el contenido ${QUALITIES[c.quality]} no está configurado en el servidor (Servidores › Contenido)`);
            const acc = c.quality ? s.packages[c.quality] : c.access;
            if (!acc || (!acc.all && !(acc.folders || []).length)) throw new Error('no tiene contenido asignado: elige Básico o 4K en la cuenta'); // no sabe qué ponerle
            const now = await readPolicy(s, c.embyId);
            if (polHasLibs(now) && !now.IsDisabled) return;
            const diag = await libDiag(s, c);
            await grantAccess(c);
            delete c.guardErr; c.libsOkAt = new Date().toISOString();
            addLog('reparada', c, `Se había quedado ${now.IsDisabled ? 'desactivada' : 'sin bibliotecas'} en ${srvKind(s)} estando activa: el panel lo ha corregido solo.${diag.length ? ' Pistas: ' + diag.join(' · ') : ''}`, null);
            fixed.push(`• ${c.panelName} (${s.name})${diag.length ? '\n   ' + diag.join('\n   ') : ''}`);
          });
        } catch (e) {
          console.error('Guardián de bibliotecas:', c.embyName, e.message);
          // Avisar una sola vez por cuenta y error (cada 15 minutos sería pesado)
          const key = 'g:' + e.message;
          if (c.guardErr !== key) {
            c.guardErr = key;
            addLog('error', c, `El guardián vio la cuenta sin bibliotecas o desactivada y no pudo corregirla: ${e.message}. Pulsa Reparar.`, null);
            failed.push(`${c.panelName} (${s.name}): ${e.message}`);
          }
        }
      }
    }
  } finally { libGuardBusy = false; }
  if (failed.length) {
    saveDb();
    notifyStaff('servers', `⚠️ ${failed.length === 1 ? 'Hay 1 cuenta activa' : `Hay ${failed.length} cuentas activas`} sin bibliotecas o desactivada${failed.length === 1 ? '' : 's'} que el panel NO ha podido arreglar. Entra y pulsa Reparar:\n${failed.slice(0, 15).join('\n')}${failed.length > 15 ? `\n… y ${failed.length - 15} más` : ''}\n${whenTxt()}`);
  }
  if (fixed.length) {
    saveDb();
    notifyStaff('servers', `🛠️ ${fixed.length === 1 ? '1 cuenta activa se había quedado' : fixed.length + ' cuentas activas se habían quedado'} sin bibliotecas en el servidor. El panel ${fixed.length === 1 ? 'la ha' : 'las ha'} arreglado solo.\nEl panel no las quitó: lo hizo algo de fuera. Pistas:\n${fixed.slice(0, 8).join('\n')}${fixed.length > 8 ? `\n… y ${fixed.length - 8} más (míralas en su Historial)` : ''}\n${whenTxt()}`);
  }
}
/** Pistas de QUIÉN pudo quitar las bibliotecas: lo último que hizo el panel, cuándo se vio bien por última vez,
    el registro de actividad del servidor y qué otros programas tienen clave de API en él. Nunca se muestran claves. */
async function libDiag(s, c) {
  const out = [];
  const last = db.log.find((l) => l.clientId === c.id && !['comprobada', 'reparada'].includes(l.type));
  if (last) out.push(`Último cambio en el panel: ${last.text.slice(0, 80)} (${new Date(last.ts).toLocaleString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${last.actor ? ', ' + last.actor : ''})`);
  if (c.libsOkAt) out.push(`El panel la vio bien por última vez: ${new Date(c.libsOkAt).toLocaleString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
  try {
    const since = new Date(Date.now() - 2 * 86400e3).toISOString();
    const r = await emby(s, 'GET', `/System/ActivityLog/Entries?StartIndex=0&Limit=300&MinDate=${encodeURIComponent(since)}`);
    const name = String(c.embyName || '').toLowerCase();
    const hits = ((r && r.Items) || []).filter((e) => `${e.Name || ''} ${e.ShortOverview || ''} ${e.Overview || ''}`.toLowerCase().includes(name)).slice(0, 3);
    for (const e of hits) out.push(`${srvKind(s)} apuntó: «${String(e.Name || e.ShortOverview || '').slice(0, 90)}» (${new Date(e.Date).toLocaleString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`);
  } catch { /* este servidor no da su registro */ }
  try {
    const k = await emby(s, 'GET', '/Auth/Keys');
    const others = ((k && k.Items) || []).filter((x) => x && x.AccessToken !== s.apiKey).map((x) => String(x.AppName || 'sin nombre').slice(0, 40));
    if (others.length) out.push(`⚠️ En «${s.name}» hay ${others.length === 1 ? 'otra clave de API' : others.length + ' claves de API más'} además de la del panel: ${[...new Set(others)].slice(0, 6).join(', ')}. Un programa con esa clave (otro panel, un script…) puede estar quitando bibliotecas.`);
  } catch { /* sin permiso para ver las claves */ }
  return out;
}
/** Comprobación al minuto: tras crear, renovar, demo, restaurar o activar, se mira en el servidor que la cuenta tiene
    sus bibliotecas y pantallas. Si algo no cuadra, se corrige en el momento, se apunta y se avisa. */
const libChecks = new Map(); // cuenta -> temporizador
function libCheckLater(c) {
  if (!c) return;
  clearTimeout(libChecks.get(c.id));
  const t = setTimeout(() => { libChecks.delete(c.id); libCheckNow(c.id).catch((e) => console.error('Comprobación al minuto:', e.message)); }, Number(process.env.LIBCHECK_MS) || 60000);
  if (t.unref) t.unref();
  libChecks.set(c.id, t);
}
async function libCheckNow(id) {
  let note = '';
  await lock(async () => {
    const c = db.clients.find((x) => x.id === id);
    if (!c || c.status !== 'active' || c.off) return;
    const valid = c.demo ? Date.now() < Date.parse(c.expiresAt) : diffDays(c.expires, today()) >= 0;
    const s = db.servers.find((x) => x.id === c.serverId);
    if (!valid || !s) return;
    let acc; try { acc = accessOf(c); } catch { return; }
    if (!acc.all && !(acc.folders || []).length) return;
    let pol;
    try { pol = await readPolicy(s, c.embyId); }
    catch (e) { addLog('error', c, `Comprobación al minuto: no se pudo leer la cuenta en ${srvKind(s)} (${e.message}). Pulsa Reparar si el cliente no ve nada.`, null); saveDb(); return; }
    const nf = (v) => String(v).toLowerCase().replace(/-/g, '');
    const want = new Set((acc.folders || []).map(nf)), has = (pol.EnabledFolders || []).map(nf);
    // Bien = las del paquete (o una parte, si alguna biblioteca ya no existe) y ninguna de más
    const libsOk = acc.all ? !!pol.EnableAllFolders : (!pol.EnableAllFolders && has.length > 0 && has.every((f) => want.has(f)));
    const scrOkNow = !(c.screens > 0) || scrOk(s, pol, c.screens);
    if (libsOk && !pol.IsDisabled && scrOkNow) { addLog('comprobada', c, 'Comprobado al minuto: bibliotecas y pantallas correctas ✓', null); saveDb(); return; }
    const what = [!libsOk && (has.length || pol.EnableAllFolders ? 'con bibliotecas que no eran las suyas' : 'sin bibliotecas'), pol.IsDisabled && 'desactivada', !scrOkNow && 'con las pantallas mal'].filter(Boolean).join(', ');
    const diag = await libDiag(s, c);
    try { await grantAccess(c); }
    catch (e) { addLog('error', c, `Comprobación al minuto: estaba ${what} y no se pudo corregir (${e.message}). Pulsa Reparar.`, null); saveDb(); note = `⚠️ ${c.panelName} (${s.name}): estaba ${what} y NO se pudo corregir. Pulsa Reparar.`; return; }
    addLog('reparada', c, `Comprobación al minuto: estaba ${what} en ${srvKind(s)}. Corregido ✓${diag.length ? ' Pistas: ' + diag.join(' · ') : ''}`, null);
    saveDb();
    note = `🛠️ ${c.panelName} (${s.name}): al minuto de crearla o renovarla estaba ${what}. El panel lo ha corregido solo.${diag.length ? '\nPistas:\n   ' + diag.join('\n   ') : ''}`;
  });
  if (note) notifyStaff('servers', `${note}\n${whenTxt()}`);
}
const srvKind = (s) => (s && s.kind === 'jellyfin' ? 'Jellyfin' : 'Emby');
/** Pestaña desde la que se pide algo «para todos» (Emby o Jellyfin). Sin pestaña, vale todo, como siempre */
const kindMatch = (kind, s) => !(kind === 'emby' || kind === 'jellyfin') || (s && s.kind === 'jellyfin' ? 'jellyfin' : 'emby') === kind;
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
  // Cada versión de Emby (o un proxy delante) puede contestar distinto: lista, { Items: [...] } o texto.
  // Se prueban varias rutas y se usa la primera que devuelva una lista de verdad.
  const asList = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.Items) ? v.Items : null);
  const paths = ['/Library/VirtualFolders', '/Library/VirtualFolders/Query', '/Library/SelectableMediaFolders', '/Library/MediaFolders'];
  let list = null, lastErr = null;
  for (const p of paths) {
    try { list = asList(await emby(server, 'GET', p)); }
    catch (e) { if (e.embyStatus === 401 || e.embyStatus === 403 || e.embyStatus === 0) throw e; lastErr = e; }
    if (list) break;
  }
  if (!list) throw lastErr || new HttpError(502, `"${server.name}" no devolvió la lista de bibliotecas. Revisa que la «Dirección para el panel» lleve directamente a Emby.`);
  return list.map((f) => ({ id: String(f.Guid || f.ItemId || f.Id || ''), name: f.Name || f.name || 'Biblioteca' })).filter((f) => f.id);
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
/** Lo que una cuenta TIENE de verdad en Emby: contenido (Básico o 4K, según las bibliotecas de los paquetes de Concha) y pantallas.
 * Sirve para importar cuentas de otro panel sin cambiarles nada. q = null si no se puede saber (p. ej. sin bibliotecas). */
function embyPlanOf(s, pol) {
  pol = pol || {};
  const lim = scrOf(s, pol);
  const screens = lim >= 3 ? 4 : lim === 2 ? 2 : lim === 1 ? 1 : 0;
  if (!polHasLibs(pol)) return { q: null, screens };
  const pk = s.packages || {}, B = pk.basico || { all: false, folders: [] }, K = pk.k4 || { all: false, folders: [] };
  const nf = (v) => String(v).toLowerCase().replace(/-/g, '');
  const has = new Set((pol.EnabledFolders || []).map(nf)), inB = new Set((B.folders || []).map(nf));
  let q;
  if (pol.EnableAllFolders) q = B.all && !K.all ? 'basico' : 'k4';
  else if (!K.all) q = (K.folders || []).map(nf).some((f) => !inB.has(f) && has.has(f)) ? 'k4' : 'basico';
  else q = B.all ? 'basico' : [...has].some((f) => !inB.has(f)) ? 'k4' : 'basico';
  return { q, screens };
}
async function readPolicy(s, embyId) { return (await emby(s, 'GET', `/Users/${embyId}`)).Policy || {}; }
/** Da acceso: activa la cuenta, le pone SIEMPRE las bibliotecas de su paquete y su limite de pantallas, y comprueba que Emby lo ha aplicado */
async function grantAccess(client) {
  // Desactivada a mano (por ejemplo, no ha pagado): nada la vuelve a activar salvo Activar, Renovar o Restaurar
  if (client.off) { await removeAccess(client, true); return; }
  const s = serverOf(client);
  const acc = accessOf(client);
  // Cuenta sin contenido (por ejemplo, importada de otro panel cuando ya no tenía bibliotecas): mejor avisar que dejarla vacía
  if (!acc.all && !(acc.folders || []).length) throw new HttpError(400, 'Esta cuenta no tiene contenido asignado. Elige Básico o 4K en «Contenido» y vuelve a intentarlo.');
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
const sessions = new Map(); // huella del token -> { userId, exp }
/* Las sesiones se guardan en data/sesiones.json (solo la huella SHA-256 de cada token, nunca el token):
   así, al actualizar o reiniciar el panel, nadie tiene que volver a entrar */
const SES_FILE = path.join(DATA_DIR, 'sesiones.json');
const tokHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
let sesTimer = null;
function saveSessions(now) {
  if (sesTimer) { clearTimeout(sesTimer); sesTimer = null; }
  const write = () => {
    sesTimer = null;
    try {
      const out = {}, t = Date.now();
      for (const [k, v] of sessions) if (v.exp > t) out[k] = v;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SES_FILE + '.tmp', JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(SES_FILE + '.tmp', SES_FILE);
    } catch (e) { console.error('No se pudieron guardar las sesiones:', e.message); }
  };
  if (now) write(); else sesTimer = setTimeout(write, 1500);
}
function loadSessions() {
  try {
    if (!fs.existsSync(SES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SES_FILE, 'utf8')), t = Date.now();
    for (const [k, v] of Object.entries(data || {})) if (/^[a-f0-9]{64}$/.test(k) && v && v.exp > t && v.userId != null) sessions.set(k, v);
  } catch (e) { console.error('No se pudieron leer las sesiones guardadas:', e.message); }
}
// cualquier alta o baja de sesión se guarda sola en el disco
{ const set = sessions.set.bind(sessions), del = sessions.delete.bind(sessions), clr = sessions.clear.bind(sessions);
  sessions.set = (k, v) => { const r = set(k, v); saveSessions(); return r; };
  sessions.delete = (k) => { const r = del(k); if (r) saveSessions(); return r; };
  sessions.clear = () => { clr(); saveSessions(); }; }
setInterval(() => { if (sessions.size) saveSessions(); }, 5 * 60000).unref(); // para guardar también la última actividad
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
  ['POST', /^\/api\/logs\/clear$/, 'reports'],
  ['POST', /^\/api\/shared\/clear$/, 'clients'],
  ['PUT', /^\/api\/servers\/\d+\/max$/, 'servers'],
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
  sessions.set(tokHash(token), { userId: user.id, exp: Date.now() + maxAge * 1000, sid: crypto.randomBytes(6).toString('hex'), created: Date.now(), seen: Date.now(),
    ip: req ? clientIp(req) : '', ua: req ? uaShort(req.headers['user-agent']) : '' });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`); // Secure cuando se entra por HTTPS
}
function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? tokHash(m[1]) : null; // en memoria y en disco solo se usa la huella
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
    if (u.role === 'super' ? pref !== false : (u.role === 'admin' && pref === true && (kind !== 'servers' || can(u, 'viewServers')) && (kind !== 'quality' || can(u, 'servers')) && (kind !== 'sabotage' || can(u, 'resellers')) && (kind !== 'vendorLogins' || can(u, 'resellers')))) notifyUser(u, text);
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
  if (!c || (vis && !vis.has(c.ownerId)) || jfHidden(me, db.servers.find((x) => x.id === c.serverId))) throw new HttpError(404, 'Esa cuenta ya no existe en el panel.');
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
  lastLogin: u.lastLogin || null, lastSeen: u.lastSeen || null, online: !!u.lastSeen && Date.now() - Date.parse(u.lastSeen) < 3 * 60000 && !(u.lastOut && u.lastOut >= u.lastSeen), renew: u.role === 'reseller' || u.role === 'sub' ? renewRate([u.id]) : null, debt: u.role === 'reseller' || u.role === 'sub' ? debtOf(u).amount : 0,
  creditPrice: u.creditPrice || 0, allowNegative: !!u.allowNegative, allowDemos: u.allowDemos !== false, serverIds: u.serverIds || [], platforms: kindsOf(u),
  canCreateSubs: u.canCreateSubs !== false, subCost: u.subCost || 0,
  twoFa: !!(u.totp && u.totp.on), tgLinked: !!u.tgChat, home: u.home || '',
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
/** Servidores que un vendedor puede ver: los que tiene asignados (si no tiene, los de su reseller)
 * y aquellos donde ya tenga alguna cuenta suya. El equipo (super y administradores) los ve todos. */
/** Qué puede vender cada usuario: Emby, Jellyfin o los dos. Lo decide el superadministrador en su perfil.
 *  Por defecto, solo Emby (como siempre). El superadministrador lo ve todo. Un subreseller sin ajuste propio usa el de su reseller. */
function kindsOf(me) {
  const lic = licKinds();
  if (!me || me.role === 'super') return lic;
  let k = Array.isArray(me.platforms) && me.platforms.length ? me.platforms : null;
  if (!k && me.parentId) { const p = db.users.find((x) => x.id === me.parentId); if (p && Array.isArray(p.platforms) && p.platforms.length) k = p.platforms; }
  const out = (k || ['emby']).filter((x) => lic.includes(x));
  return out.length ? out : lic; // en un panel alquilado solo de Jellyfin, los vendedores venden Jellyfin
}
/** Lo que incluye la licencia de este panel: Emby, Jellyfin o los dos (el panel principal, siempre los dos) */
const KINDS_ALL = ['emby', 'jellyfin'];
const kindsClean = (v) => (Array.isArray(v) ? KINDS_ALL.filter((k) => v.includes(k)) : []);
function licKinds() {
  if (!LIC_CLIENT) return KINDS_ALL;
  const k = kindsClean((db.licState || {}).platforms);
  return k.length ? k : KINDS_ALL;
}
const jfHidden = (me, s) => !!s && !kindsOf(me).includes(s.kind === 'jellyfin' ? 'jellyfin' : 'emby');
function serversFor(me) { return serversFor0(me).filter((s) => !jfHidden(me, s)); }
function serversFor0(me) {
  if (!me || isStaff(me)) return db.servers;
  let ids = Array.isArray(me.serverIds) && me.serverIds.length ? me.serverIds : null;
  if (!ids && me.parentId) { const p = db.users.find((x) => x.id === me.parentId); if (p && Array.isArray(p.serverIds) && p.serverIds.length) ids = p.serverIds; }
  if (!ids) return db.servers;
  const vis = visibleOwners(me), used = new Set(db.clients.filter((c) => c.status !== 'trash' && (!vis || vis.has(c.ownerId))).map((c) => c.serverId));
  return db.servers.filter((x) => ids.includes(x.id) || used.has(x.id));
}
function serverAllowed(u, s) { if (jfHidden(u, s)) return false; return isStaff(u) || !u.serverIds || !u.serverIds.length || u.serverIds.includes(s.id); }
/** Clientes que ocupan sitio en un servidor (todo menos la papelera; las demos también cuentan) */
const srvLoad = (s) => db.clients.filter((c) => c.serverId === s.id && c.status !== 'trash').length;
const srvMax = (s) => Math.max(0, Number(s.maxClients) || 0);
function assertRoom(s, n = 1) {
  const max = srvMax(s), used = srvLoad(s);
  if (max > 0 && used + n > max) throw new HttpError(400, `El servidor "${s.name}" está lleno: tiene ${used} de ${max} clientes. Elige otro servidor o sube su límite en Servidores › Editar.`);
}
function readMaxClients(v, cur) {
  if (v === undefined || v === null || v === '') return cur || 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, 'El máximo de clientes debe ser un número entero (0 = sin límite).');
  return n;
}
function assertServerAllowed(u, s) { assertRoom(s); if (s.off) throw new HttpError(400, `El servidor "${s.name}" está pausado: no admite cuentas nuevas ahora mismo.`); if (!serverAllowed(u, s)) throw new HttpError(403, `No tienes permiso para crear cuentas en "${s.name}".`); }
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
  if (body.platforms !== undefined && me.role === 'super') { // solo el superadministrador decide si vende Emby, Jellyfin o los dos
    const k = (Array.isArray(body.platforms) ? body.platforms : []).filter((x) => x === 'emby' || x === 'jellyfin');
    if (!k.length) throw new HttpError(400, 'Marca al menos Emby o Jellyfin.');
    if (k.length === 1 && k[0] === 'emby') delete u.platforms; else u.platforms = [...new Set(k)];
  }
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
  // Con servidores Jellyfin, además, las mismas cuentas separadas por Emby y por Jellyfin (para cada pestaña)
  if (db.servers.some((x) => x.kind === 'jellyfin')) {
    const kindOfClient = new Map(db.clients.map((c) => [c.id, (db.servers.find((x) => x.id === c.serverId) || {}).kind === 'jellyfin' ? 'jellyfin' : 'emby']));
    stats.byKind = {};
    for (const kind of ['emby', 'jellyfin']) {
      const st = { today: {}, month: {} }, bd = new Map();
      for (const k of ['alta', 'renovacion', 'demo']) { st.today[k] = [0, 0]; st.month[k] = [0, 0]; }
      for (let k = 0; k < 30; k++) bd.set(addDays(from, k), { d: addDays(from, k), alta: 0, renovacion: 0 });
      st.days = [...bd.values()];
      for (const l of db.log) {
        const d = localDate(new Date(l.ts));
        if (d < oldest) break;
        if (!st.month[l.type]) continue;
        if (vis && !((l.ownerId != null && vis.has(l.ownerId)) || l.actorId === me.id)) continue;
        if ((kindOfClient.get(l.clientId) || 'emby') !== kind) continue;
        if (l.type !== 'demo' && bd.has(d)) bd.get(d)[l.type]++;
        if (d.slice(0, 7) !== month) continue;
        const own = l.actorId === me.id;
        st.month[l.type][1]++; if (own) st.month[l.type][0]++;
        if (d === t) { st.today[l.type][1]++; if (own) st.today[l.type][0]++; }
      }
      stats.byKind[kind] = st;
    }
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
    myTemplates: tplLocked() ? {} : me.templates || {}, // con «mismos mensajes para todos» se guardan, pero no se usan
    myPayOffer: me.payOffer || null,
    salesEmail: salesEmail(),
    parentPayOffer: me.parentId ? payOfferFor(me.parentId) : null,
    tvMine: me.tvNotice || null,
    tvParent: (() => { const p = me.parentId ? db.users.find((x) => x.id === me.parentId) : null; return (p && p.tvNotice) || null; })(),
    parentTemplates: tplLocked() ? {} : (() => { const p = me.parentId ? db.users.find((x) => x.id === me.parentId) : null; return (p && p.templates) || {}; })(),
    licMaster: me.role === 'super' && !LIC_CLIENT,
    kinds: licKinds(),
    uiVer: indexFile().ver,
    panelMaster: !LIC_CLIENT, // el panel principal (no alquilado): solo aquí el equipo exporta los datos en claro
    expSalt: crypto.createHash('sha256').update(String(db.secret || '') + '|exp').digest('hex').slice(0, 24),
    licDue: me.role === 'super' && !LIC_CLIENT ? (db.licenses || []).filter((l) => !l.blocked && diffDays(l.until, today()) <= 7).length : 0,
    license: me.role === 'super' ? licStatus() : null,
    expDue: me.role === 'super' ? expDueCount() : 0,
    settings: { ...db.settings, notices: { ...db.settings.notices, telegram: { on: db.settings.notices.telegram.on, bot: db.settings.notices.telegram.bot, hasToken: !!db.settings.notices.telegram.token } },
      // La app de clientes: mientras el superadministrador no la publique, el resto del equipo no la ve
      app: me.role === 'super' || (db.settings.app || {}).public ? db.settings.app : { ...db.settings.app, file: false, tag: false, inMsg: false },
      clientPay: isStaff(me) ? db.settings.clientPay : { vendors: !!(db.settings.clientPay || {}).vendors } },
    servers: serversFor(me).map((s) => (seeServers
      ? { id: s.id, kind: s.kind === 'jellyfin' ? 'jellyfin' : 'emby', name: s.name, usable: !s.off, off: !!s.off, publicUrl: s.publicUrl || '', url: s.url, packages: s.packages || {}, keyLost: !!s.keyLost, ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') }, maxClients: srvMax(s), used: srvLoad(s), full: srvMax(s) > 0 && srvLoad(s) >= srvMax(s) }
      : { id: s.id, kind: s.kind === 'jellyfin' ? 'jellyfin' : 'emby', name: s.name, usable: serverAllowed(me, s) && !s.off, publicUrl: s.publicUrl || '', ready: { basico: packageReady(s, 'basico'), k4: packageReady(s, 'k4') }, full: srvMax(s) > 0 && srvLoad(s) >= srvMax(s) })),
    users, stats: seeClients ? stats : { today: Object.fromEntries(Object.keys(stats.today).map((k) => [k, [0, 0]])), month: Object.fromEntries(Object.keys(stats.month).map((k) => [k, [0, 0]])), days: stats.days.map((x) => ({ d: x.d, alta: 0, renovacion: 0 })) },
    clients: db.clients.filter((c) => seeClients && (!vis || vis.has(c.ownerId)) && !jfHidden(me, db.servers.find((x) => x.id === c.serverId))).map((c) => ({ ...c, tgChat: undefined, payKey: undefined, payLink: (isStaff(me) || c.ownerId === me.id) && siteBase() && cpEligible(c) ? cpLink(c) : '', tgLinked: !!c.tgChat, tgCode: tgCode(c) })),
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

const SALES_EMAIL = 'clickonline69@proton.me';
const salesEmail = () => (typeof db.settings.salesEmail === 'string' ? db.settings.salesEmail : SALES_EMAIL);
route('GET', '/api/state', null, ({ req }) => ({ uiVer: indexFile().ver, needsSetup: !db.users.length, authed: !!currentUser(req), brand: db.settings.brand, support: db.settings.support, license: licStatus(), salesEmail: salesEmail() }));
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
  if (typeof body.salesEmail === 'string') { const se = str(body.salesEmail, 120); if (se && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(se)) throw new HttpError(400, 'El correo de contacto no es válido.'); db.settings.salesEmail = se; }
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
  // Entradas de resellers y subresellers: al jefe (y a los admins que lo pidan) y, si es un subreseller, también a su reseller
  if (u.role === 'reseller' || u.role === 'sub') {
    const par = u.parentId ? db.users.find((x) => x.id === u.parentId) : null;
    const who = u.role === 'sub' ? `🟢 El subreseller ${u.name} (@${u.username})${par ? `, de ${par.name},` : ''}` : `🟢 El reseller ${u.name} (@${u.username})`;
    notifyStaff('vendorLogins', `${who} ha entrado en el panel.\n${dev} · IP ${ip}\n${whenTxt()}`);
    if (par && !par.disabled && (par.secAlerts || {}).vendorLogins !== false && par.role === 'reseller') notifyUser(par, `🟢 Tu subreseller ${u.name} (@${u.username}) ha entrado en el panel.\n${whenTxt()}`);
  }
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
  if (su) { addAccess(su, 'salida', req); su.lastOut = new Date().toISOString(); }
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

route('GET', '/api/data', '*', ({ me, req }) => { try { const b = panelBase(req); if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(b) && db.settings.siteBase !== b) db.settings.siteBase = b; } catch { /* nada */ } return publicData(me); });

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
  if (body.pauseStop && typeof body.pauseStop === 'object') g.pauseStop = { on: !!body.pauseStop.on, minutes: num(body.pauseStop.minutes, 5, 240, 'Minutos de pausa') };
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
  if (body.home !== undefined) { if (['resumen', 'cuentas'].includes(body.home)) me.home = body.home; else delete me.home; } // vacío = automática
  saveDb();
  return { ok: true };
}));
/* Registro de actividad completo, con los inicios de sesion */
/* «Vaciar» deja la pantalla en blanco desde ese momento. Los datos se quedan para las estadísticas, los ingresos
   y el historial de cada cuenta; se borran solos según Ajustes › Retención de datos. */
route('GET', '/api/logs', STAFF, () => { const from = db.settings.logClearedAt || ''; const L = from ? db.log.filter((l) => l.ts > from) : db.log; return { log: L.slice(0, 3000), total: L.length, clearedAt: from }; });
route('POST', '/api/logs/clear', STAFF, ({ me }) => lock(async () => {
  db.settings.logClearedAt = new Date().toISOString();
  addLog('ajustes', null, 'Registro de actividad vaciado', me);
  saveDb();
  return { ok: true };
}));
/* Historial de accesos. El superadministrador lo ve todo (también los intentos con usuarios que no existen).
   Un administrador ve los de resellers y subresellers y los suyos; un reseller, los suyos y los de sus subresellers. */
route('GET', '/api/access', ['super', 'admin', 'reseller'], ({ me }) => {
  let ok;
  if (me.role === 'super') ok = () => true;
  else if (me.role === 'admin') ok = (e) => e.userId === me.id || e.role === 'reseller' || e.role === 'sub';
  else { const mine = new Set([me.id, ...db.users.filter((u) => u.parentId === me.id).map((u) => u.id)]); ok = (e) => mine.has(e.userId); }
  return { access: db.access.filter(ok).slice(0, 5000), total: db.access.length };
});

route('POST', '/api/access/clear', SUPER, ({ me }) => lock(async () => {
  const n = db.access.length;
  db.access = [];
  addLog('ajustes', null, `Historial de accesos vaciado (${n})`, me);
  saveDb();
  return { ok: true, cleared: n };
}));

/* ---------- Avisos de vencimiento ---------- */
function tgCode(c) { return `c${c.id}_${crypto.createHmac('sha256', db.secret).update('tg' + c.id).digest('hex').slice(0, 10)}`; }
function leftWords(left) { return left <= 0 ? 'hoy' : left === 1 ? 'mañana' : `en ${left} días`; }
/** Rellena una plantilla con los datos de la cuenta (sin la contraseña) */
/** Plantilla que toca para las cuentas de un vendedor: la suya, si no la de su reseller, si no la del panel */
const MY_TPL_KEYS = ['created', 'demo', 'renewed', 'expiring', 'quality', 'followup', 'vendor'];
const tplLocked = () => db.settings.tplLock === true; // solo si el superadministrador lo activa en Plantillas
function tplFor(ownerId, key) {
  if (tplLocked()) return db.settings.templates[key] || DEFAULT_TEMPLATES[key] || '';
  let u = db.users.find((x) => x.id === ownerId), hops = 0;
  while (u && hops++ < 3) { const t = u.templates && u.templates[key]; if (t) return t; u = u.parentId ? db.users.find((x) => x.id === u.parentId) : null; }
  return db.settings.templates[key] || DEFAULT_TEMPLATES[key] || '';
}
function fillText(text, c) {
  const s = db.servers.find((x) => x.id === c.serverId) || {};
  const left = diffDays(c.expires, today());
  const vars = { nombre: c.panelName, usuario: c.embyName, servidor: s.name || '', direccion: s.publicUrl || '', vence: c.expires.split('-').reverse().join('/'),
    cuando: leftWords(left), dias: String(Math.max(0, left)), pantallas: c.screens ? String(c.screens) : 'sin límite', contenido: c.quality ? QUALITIES[c.quality] : '', 'contraseña': 'la que ya tienes' };
  // Vale {nombre} y también [nombre]; «fecha», «caducidad» y «cliente» se entienden como {vence} y {nombre}
  const alias = { contrasena: 'contraseña', 'dirección': 'direccion', fecha: 'vence', caducidad: 'vence', vencimiento: 'vence', cliente: 'nombre', user: 'usuario' };
  const out = String(text || '').replace(/\{([a-záéíóúñ_]+)\}|\[([a-záéíóúñ_]+)\]/gi, (m, a, b) => { let k = String(a || b).toLowerCase(); k = alias[k] || k; return vars[k] !== undefined ? vars[k] : m; });
  return s.kind === 'jellyfin' ? out.replace(/\bEmby\b/g, 'Jellyfin') : out; // cliente de Jellyfin: el mensaje habla de Jellyfin
}
const dueSoon = (c, days, t) => { if (c.demo || c.status !== 'active') return false; const left = diffDays(c.expires, t); return left >= 0 && left <= days; };
/* 1) Mensaje en la pantalla de Emby, cuando el cliente esta viendo.
 * Cada vendedor puede tener su propio aviso (dias, cada cuanto y texto); si no, el de su reseller; si no, el del panel */
const TV_EVERY = [1, 2, 3, 6, 12, 24];
function tvCfgFor(ownerId) {
  let u = db.users.find((x) => x.id === ownerId), hops = 0;
  while (u && hops++ < 3) { if (u.tvNotice) return u.tvNotice; u = u.parentId ? db.users.find((x) => x.id === u.parentId) : null; }
  return db.settings.notices.screen;
}
function tvDue(c, cfg, t) {
  if (!cfg || !cfg.on || c.demo || c.status !== 'active' || c.off) return false;
  const left = diffDays(c.expires, t);
  if (left < 0) return false;
  if (Array.isArray(cfg.list) && cfg.list.length) { if (!cfg.list.includes(left)) return false; }
  else if (left > (cfg.days || 5)) return false;
  const every = TV_EVERY.includes(cfg.every) ? cfg.every : 24;
  if (every >= 24) return c.screenNotice !== t; // una vez al dia
  return !c.screenNoticeAt || Date.now() - Date.parse(c.screenNoticeAt) >= every * 3600e3 - 60e3;
}
let noticing = false;
async function screenNotices() {
  if (noticing) return;
  const t = today();
  const cfgs = new Map();
  const cfgOf = (c) => { if (!cfgs.has(c.ownerId)) cfgs.set(c.ownerId, tvCfgFor(c.ownerId)); return cfgs.get(c.ownerId); };
  const due = db.clients.filter((c) => tvDue(c, cfgOf(c), t));
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
        if (!c || !tvDue(c, cfgOf(c), t) || x.SupportsRemoteControl === false) continue;
        try {
          await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: db.settings.brand.name || 'Aviso', Text: fillText(cfgOf(c).message || DEFAULT_NOTICES.screen.message, c), TimeoutMs: 12000 });
          c.screenNotice = t; c.screenNoticeAt = new Date().toISOString(); sent++;
        } catch (e) { /* esa app no admite mensajes: se probara en otra sesion */ }
      }
    }
    if (sent) await lock(async () => saveDb());
  } catch (e) { console.error('Error en los avisos en pantalla:', e.message); }
  finally { noticing = false; }
}
/* Aviso en la tele: el del panel (quien tiene el permiso de sistema) o el propio de cada vendedor */
function readTvCfg(body) {
  const list = Array.isArray(body.list) ? [...new Set(body.list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, b) => b - a).slice(0, 20) : [];
  const every = TV_EVERY.includes(Number(body.every)) ? Number(body.every) : 24;
  const message = str(body.message, 300);
  if (body.on && !list.length) throw new HttpError(400, 'Elige al menos un día para avisar.');
  if (body.on && !message) throw new HttpError(400, 'Escribe el mensaje que verá el cliente en la tele.');
  return { on: !!body.on, list, every, message: message || DEFAULT_NOTICES.screen.message };
}
route('PUT', '/api/tv-notice', '*', ({ me, body }) => lock(async () => {
  if (body.scope === 'panel') {
    if (!can(me, 'system')) throw new HttpError(403, 'Solo quien gestiona el panel puede cambiar el aviso general.');
    const cur = db.settings.notices.screen, n = readTvCfg(body);
    Object.assign(cur, n); cur.days = Math.max(1, Math.min(30, n.list[0] || cur.days || 5));
    addLog('ajustes', null, 'Aviso en la tele del panel cambiado', me);
  } else if (body.use === 'panel') { delete me.tvNotice; addLog('ajustes', null, `${me.username} usa el aviso en la tele del panel`, me); }
  else { me.tvNotice = readTvCfg(body); addLog('ajustes', null, `${me.username} cambió su aviso en la tele`, me); }
  saveDb();
  return { ok: true };
}));
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
            if (c.tgChat !== chat || !c.tgAt) c.tgAt = new Date().toISOString();
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
/* Precios y enlace de pago que cada vendedor añade a su aviso de caducidad por Telegram.
   Si un subreseller no tiene los suyos, se usan los de su reseller. */
function payOfferFor(ownerId) {
  let u = db.users.find((x) => x.id === ownerId), hops = 0;
  while (u && hops++ < 3) { if (u.payOffer) return u.payOffer.on ? u.payOffer : null; u = u.parentId ? db.users.find((x) => x.id === u.parentId) : null; }
  return null;
}
/** Mensaje de aviso de caducidad para Telegram: el texto, los precios y el botón de pago (si los hay) */
function expiringTg(c) {
  if (cpEligible(c) && cpScreens(c, cpCtx(c)).length && siteBase()) {
    const text = fillText(tplFor(c.ownerId, 'expiring'), c) + '\n\n💳 Puedes renovar tú mismo, al momento, con el botón de abajo.';
    return { chat_id: c.tgChat, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '💳 Pagar y renovar', url: cpLink(c) }]] } };
  }
  const off = payOfferFor(c.ownerId);
  let text = fillText(tplFor(c.ownerId, 'expiring'), c);
  if (off && off.prices) text += '\n\n' + fillText(off.prices, c);
  const msg = { chat_id: c.tgChat, text, disable_web_page_preview: true };
  if (off && off.url) msg.reply_markup = { inline_keyboard: [[{ text: off.button || '💳 Pagar y renovar', url: off.url }]] };
  return msg;
}
function readPayOffer(body) {
  const url = str(body.url, 300), prices = typeof body.prices === 'string' ? body.prices.replace(/\r\n/g, '\n').slice(0, 900).trim() : '';
  if (url && !/^(https?:\/\/|tg:\/\/)[^\s]+$/i.test(url)) throw new HttpError(400, 'El enlace de pago debe empezar por https:// (por ejemplo, https://paypal.me/tuusuario).');
  const on = !!body.on;
  if (on && !prices && !url) throw new HttpError(400, 'Escribe tus precios o pon un enlace de pago.');
  return { on, prices, url, button: str(body.button, 40) || '💳 Pagar y renovar' };
}
route('PUT', '/api/my-payoffer', '*', ({ me, body }) => lock(async () => {
  if (body.inherit) delete me.payOffer; else me.payOffer = readPayOffer(body);
  addLog('ajustes', null, `${me.username} cambió sus precios y enlace de pago de Telegram`, me);
  saveDb();
  return { ok: true };
}));
route('POST', '/api/my-payoffer/test', '*', async ({ me, body }) => {
  const cfg = db.settings.notices.telegram;
  if (!cfg.token) throw new HttpError(400, 'Todavía no hay bot de Telegram en el panel.');
  if (!me.tgChat) throw new HttpError(400, 'Enlaza primero tu Telegram en Ajustes › Seguridad para recibir la prueba.');
  const off = body && body.preview ? readPayOffer({ ...body, on: true }) : payOfferFor(me.id);
  const fake = { panelName: 'Cliente de prueba', embyName: 'cliente.prueba', serverId: (db.servers[0] || {}).id, expires: addDays(today(), 3), screens: 1, quality: 'basico', ownerId: me.id };
  let text = '🧪 PRUEBA · así lo recibirán tus clientes\n\n' + fillText(tplFor(me.id, 'expiring'), fake);
  if (off && off.prices) text += '\n\n' + fillText(off.prices, fake);
  const msg = { chat_id: me.tgChat, text, disable_web_page_preview: true };
  if (off && off.url) msg.reply_markup = { inline_keyboard: [[{ text: off.button || '💳 Pagar y renovar', url: off.url }]] };
  await tg('sendMessage', msg);
  return { ok: true };
});
/** Envia el aviso de vencimiento por Telegram, una vez por periodo y solo en horas de dia */
async function telegramNotices() {
  const cfg = db.settings.notices.telegram;
  const h = new Date().getHours();
  if (!cfg.on || !cfg.token || (!process.env.TG_ANYTIME && (h < 10 || h >= 21))) return;
  const t = today();
  const due = db.clients.filter((c) => c.tgChat && dueSoon(c, db.settings.notices.chat.days, t) && c.tgNoticeFor !== c.expires);
  for (const c of due.slice(0, 25)) {
    try {
      await tg('sendMessage', expiringTg(c));
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
    const nd = int(body.screen.days, 1, 30, cur.screen.days);
    if (nd !== cur.screen.days) delete cur.screen.list; // con «desde X días» vuelve a avisar todos los días hasta el vencimiento
    cur.screen.days = nd;
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
  await tg('sendMessage', { chat_id: c.tgChat, text: custom || fillText(tplFor(c.ownerId, 'quality'), c) });
  await lock(async () => { addLog('aviso', c, custom ? `Mensaje enviado por Telegram: ${custom.slice(0, 80)}` : 'Guía de calidad enviada por Telegram', me); saveDb(); });
  return { ok: true };
});
/* Mensaje directo al cliente por el bot de Telegram (con sus precios y botón de pago, si se quiere) */
route('POST', '/api/clients/:id/tg-msg', '*', async ({ me, params, body }) => {
  const c = clientFor(me, params.id), cfg = db.settings.notices.telegram;
  if (!cfg.token) throw new HttpError(400, 'El bot de Telegram no está configurado.');
  if (!c.tgChat) throw new HttpError(400, 'Este cliente no tiene Telegram enlazado. Mándale primero su enlace.');
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim().slice(0, 3000) : '';
  if (!text) throw new HttpError(400, 'Escribe el mensaje.');
  const msg = { chat_id: c.tgChat, text: fillText(text, c), disable_web_page_preview: true };
  const off = body.pay ? payOfferFor(c.ownerId) : null;
  if (off && off.prices) msg.text += '\n\n' + fillText(off.prices, c);
  if (off && off.url) msg.reply_markup = { inline_keyboard: [[{ text: off.button || '💳 Pagar y renovar', url: off.url }]] };
  try { await tg('sendMessage', msg); }
  catch (e) {
    if (/blocked|chat not found|deactivated/i.test(e.message)) { await lock(async () => { delete c.tgChat; addLog('aviso', c, 'Telegram desenlazado: el cliente bloqueó el bot', null); saveDb(); }); throw new HttpError(400, 'El cliente ha bloqueado el bot o borró el chat: ya no está enlazado.'); }
    throw e;
  }
  await lock(async () => { addLog('aviso', c, `Mensaje directo por Telegram: ${text.slice(0, 80)}`, me); saveDb(); });
  return { ok: true };
});
route('POST', '/api/clients/:id/tg-unlink', '*', ({ me, params }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (c.tgChat) { delete c.tgChat; addLog('aviso', c, 'Telegram desenlazado', me); saveDb(); }
  return { ok: true };
}));

/* Mis mensajes: cada usuario puede tener los suyos. Vacío = usar el de su reseller o el del panel */
route('PUT', '/api/my-templates', '*', ({ me, body }) => lock(async () => {
  if (tplLocked() && me.role !== 'super') throw new HttpError(403, 'El superadministrador ha puesto los mismos mensajes para todo el panel.');
  const next = {};
  for (const k of MY_TPL_KEYS) {
    const v = typeof body[k] === 'string' ? body[k].replace(/\r\n/g, '\n').slice(0, 2000).trim() : '';
    if (v) next[k] = v;
  }
  if (Object.keys(next).length) me.templates = next; else delete me.templates;
  addLog('ajustes', null, `${me.username} cambió sus plantillas de mensajes`, me);
  saveDb();
  return { ok: true };
}));
route('PUT', '/api/templates', SUPER, ({ body }) => lock(async () => {
  const next = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    const v = typeof body[k] === 'string' ? body[k].replace(/\r\n/g, '\n').slice(0, 2000).trim() : '';
    next[k] = v || DEFAULT_TEMPLATES[k]; // vacio = volver al texto original
  }
  db.settings.templates = next;
  if (body.lock !== undefined) db.settings.tplLock = !!body.lock;
  saveDb();
  return { ok: true };
}));

/* Servidores (solo superadministrador) */
route('POST', '/api/servers', SUPER, ({ me, body }) => lock(async () => {
  const s = { id: 0, name: str(body.name, 60), url: cleanUrl(body.url), publicUrl: str(body.publicUrl, 200), apiKey: str(body.apiKey, 200), packages: {}, maxClients: readMaxClients(body.maxClients, 0) };
  if (body.kind === 'jellyfin') s.kind = 'jellyfin'; // los servidores Emby no llevan marca: quedan exactamente igual que siempre
  if (!licKinds().includes(s.kind === 'jellyfin' ? 'jellyfin' : 'emby')) throw new HttpError(403, `Tu panel no incluye ${s.kind === 'jellyfin' ? 'Jellyfin' : 'Emby'}. Si lo quieres, pídelo a quien te alquila el panel.`);
  if (!s.name) throw new HttpError(400, 'Ponle un nombre al servidor.');
  if (!s.apiKey) throw new HttpError(400, 'Falta la API key.');
  const info = await emby(s, 'GET', '/System/Info');
  if (info && info.Id) s.embyServerId = String(info.Id).slice(0, 64);
  s.id = newId();
  db.servers.push(s);
  addLog('servidor', null, `Servidor "${s.name}" conectado (${srvKind(s)} ${info && info.Version ? info.Version : '?'})`, me);
  saveDb();
  return { ok: true, id: s.id };
}));
route('PUT', '/api/servers/:id', SUPER, ({ params, body }) => lock(async () => {
  const s = serverById(params.id);
  const next = { ...s, name: str(body.name, 60) || s.name, url: cleanUrl(body.url), publicUrl: body.publicUrl === undefined ? (s.publicUrl || '') : str(body.publicUrl, 200), apiKey: str(body.apiKey, 200) || s.apiKey, maxClients: readMaxClients(body.maxClients, s.maxClients) };
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
route('PUT', '/api/servers/:id/max', SUPER, ({ me, params, body }) => lock(async () => {
  const s = serverById(params.id), before = srvMax(s);
  s.maxClients = readMaxClients(body.maxClients, 0);
  if (before !== s.maxClients) addLog('servidor', null, `Límite de clientes de "${s.name}": ${s.maxClients || 'sin límite'}`, me);
  saveDb();
  return { ok: true, maxClients: s.maxClients, used: srvLoad(s) };
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
  const libs = Array.isArray(vf) ? vf.map((f) => ({ id: String(f.Guid || f.ItemId || f.Id || ''), item: String(f.ItemId || f.Id || ''), name: f.Name, type: f.CollectionType || '', paths: (f.Locations || []).length, locations: (f.Locations || []).slice(0, 40).map(String), refreshing: f.RefreshStatus === 'Active', progress: f.RefreshProgress != null ? Math.round(f.RefreshProgress) : null }))
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
    // al revés: cuentas del panel en este servidor que Emby ya no tiene
    const inEmby = new Set(users.map((u) => u.Id)), names = new Set(users.map((u) => String(u.Name).toLowerCase()));
    out.missing = db.clients.filter((c) => c.serverId === s.id && c.status !== 'trash' && !inEmby.has(c.embyId) && !names.has(String(c.embyName).toLowerCase()))
      .slice(0, 500).map((c) => ({ id: c.id, name: c.panelName, emby: c.embyName, email: c.email || '', owner: (db.users.find((u) => u.id === c.ownerId) || {}).name || '' }));
  }
  out.autoScan = s.autoScan || { on: false, hours: [], items: [] };
  return out;
});
/* Escanear bibliotecas: todas, o solo una */
route('POST', '/api/servers/:id/scan', STAFF, async ({ me, params, body }) => {
  const s = serverById(params.id), lib = str(body.item, 80);
  const many = Array.isArray(body.items) ? body.items.map((x) => str(String(x), 80)).filter((x) => /^[\w-]+$/.test(x)).slice(0, 60) : [];
  if (many.length) {
    for (const it of many) await emby(s, 'POST', `/Items/${it}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false`);
    await lock(async () => { addLog('servidor', null, `Escaneo de ${plural(many.length, 'biblioteca', 'bibliotecas')} en "${s.name}"`, me); saveDb(); });
    return { ok: true };
  }
  if (lib) {
    if (!/^[\w-]+$/.test(lib)) throw new HttpError(400, 'Biblioteca no válida.');
    await emby(s, 'POST', `/Items/${lib}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false`);
  } else await emby(s, 'POST', '/Library/Refresh');
  await lock(async () => { addLog('servidor', null, `Escaneo de ${lib ? 'la biblioteca «' + str(body.name, 60) + '»' : 'todas las bibliotecas'} en "${s.name}"`, me); saveDb(); });
  return { ok: true };
});
/* Escaneo automático: a las horas que elijas, todas las bibliotecas o solo algunas */
route('PUT', '/api/servers/:id/autoscan', STAFF, ({ me, params, body }) => lock(async () => {
  const s = serverById(params.id);
  const hours = [...new Set((Array.isArray(body.hours) ? body.hours : []).map(String).filter((h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h)))].sort().slice(0, 12);
  const items = (Array.isArray(body.items) ? body.items : []).map((x) => str(String(x), 80)).filter((x) => /^[\w-]+$/.test(x)).slice(0, 60);
  const on = !!body.on && hours.length > 0;
  s.autoScan = { on, hours, items };
  addLog('servidor', null, on ? `Escaneo automático en "${s.name}" a las ${hours.join(', ')} (${items.length ? plural(items.length, 'biblioteca', 'bibliotecas') : 'todas las bibliotecas'})` : `Escaneo automático apagado en "${s.name}"`, me);
  saveDb();
  return { ok: true, autoScan: s.autoScan };
}));
const autoScanDone = new Map();
async function autoScanTick() {
  const hm = new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });
  for (const s of db.servers) {
    const a = s.autoScan;
    if (!a || !a.on || !(a.hours || []).includes(hm)) continue;
    const key = `${today()} ${hm}`;
    if (autoScanDone.get(s.id) === key) continue;
    autoScanDone.set(s.id, key);
    try {
      if ((a.items || []).length) { for (const it of a.items) await emby(s, 'POST', `/Items/${it}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false`); }
      else await emby(s, 'POST', '/Library/Refresh');
      await lock(async () => { addLog('servidor', null, `Escaneo automático de las ${hm} en "${s.name}"`, null); saveDb(); });
    } catch (e) { console.error('Escaneo automático:', s.name, e.message); }
  }
}
setInterval(() => { autoScanTick().catch(() => {}); }, 30000).unref();
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
/* Recuerda cómo se tradujeron los códigos de otro panel (servidor, paquete, vendedor) */
route('PUT', '/api/import/map', STAFF, ({ body }) => lock(async () => {
  const cur = db.settings.importMap || {};
  for (const k of ['server', 'package', 'owner']) {
    if (!body[k] || typeof body[k] !== 'object') continue;
    cur[k] = cur[k] || {};
    for (const [v, to] of Object.entries(body[k]).slice(0, 300)) { const key = str(v, 120); if (key) cur[k][key] = str(String(to), 20); }
    const ks = Object.keys(cur[k]); if (ks.length > 500) for (const x of ks.slice(0, ks.length - 500)) delete cur[k][x];
  }
  db.settings.importMap = cur; saveDb();
  return { ok: true };
}));
/** Antes de importar: mira en Emby qué contenido y pantallas tiene cada usuario del archivo, para proponer qué es cada paquete */
route('POST', '/api/import/probe', STAFF, async ({ me, body }) => {
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5000);
  const norm = (v) => str(String(v == null ? '' : v), 300).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/emby$/, '');
  const list = serversFor(me), cache = new Map(), errors = [];
  const usersOf = async (s) => {
    if (!cache.has(s.id)) { let m = new Map(); try { m = new Map(((await emby(s, 'GET', '/Users')) || []).map((u) => [String(u.Name).toLowerCase(), u])); } catch (e) { errors.push(e.message); } cache.set(s.id, m); }
    return cache.get(s.id);
  };
  const out = [];
  for (const r of rows) {
    const name = String((r && r.username) || '').trim().toLowerCase();
    const want = norm(r && r.server);
    const named = want ? list.find((x) => [x.name, x.url, x.publicUrl].some((v) => v && norm(v) === want)) : null;
    const cand = named ? [named] : [...list].sort((a, b) => (b.id === Number(body.serverId)) - (a.id === Number(body.serverId)));
    let hit = null;
    for (const s of cand) {
      const eu = name ? (await usersOf(s)).get(name) : null;
      if (!eu) continue;
      const inPanel = db.clients.some((c) => c.serverId === s.id && (c.embyId === eu.Id || c.embyName.toLowerCase() === name));
      let pol = eu.Policy;
      if (!pol && !inPanel) { try { pol = await readPolicy(s, eu.Id); } catch { pol = null; } }
      const pl = embyPlanOf(s, pol);
      hit = { found: true, inPanel, q: pl.q, screens: pl.screens, server: s.id };
      if (!inPanel) break;
    }
    out.push(hit || { found: false });
  }
  return { rows: out, errors: [...new Set(errors)] };
});
route('POST', '/api/import/rows', STAFF, ({ me, body }) => lock(async () => {
  if (isStaff(me) && paysCredits(me)) throw new HttpError(403, 'Tienes el sistema de créditos activado: la importación la hace el superadministrador.');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'No hay filas que importar.');
  if (rows.length > 100) throw new HttpError(400, 'Envía como mucho 100 filas cada vez.');
  const dry = !!body.dry, create = !!body.create, fixOwner = !!body.fixOwner, fromEmby = body.fromEmby !== false;
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
      let screens = n >= 3 ? 4 : n === 2 ? 2 : 1;
      let quality = /4k|uhd|2160/i.test(String(r.package || '')) ? 'k4' : 'basico';
      const users = await embyUsers(s);
      const eu = users.get(embyName.toLowerCase());
      // La cuenta ya existe en Emby: se copia lo que tiene allí (bibliotecas y pantallas), que es lo que le puso el panel antiguo
      let copied = '';
      const inPanel = db.clients.some((c) => c.serverId === s.id && ((eu && c.embyId === eu.Id) || c.embyName.toLowerCase() === embyName.toLowerCase()));
      if (fromEmby && eu && !inPanel) {
        let pol = eu.Policy;
        if (!pol) { try { pol = await readPolicy(s, eu.Id); } catch { pol = null; } }
        const pl = embyPlanOf(s, pol);
        if (pl.q && !r.pkgFixed && packageReady(s, pl.q)) { quality = pl.q; copied = 'contenido'; } // si el código del paquete es conocido, manda el archivo
        if (pl.screens) { screens = pl.screens; copied = copied ? 'contenido y pantallas' : 'pantallas'; }
      }
      if (!packageReady(s, quality)) throw new HttpError(400, `El contenido ${QUALITIES[quality]} aún no está configurado en ${s.name}.`);
      const have = db.clients.find((c) => c.serverId === s.id && ((eu && c.embyId === eu.Id) || c.embyName.toLowerCase() === embyName.toLowerCase()));
      if (have) {
        if (!fixOwner) { res.status = 'skip'; res.text = 'Ya está en el panel'; continue; }
        const fx = [];
        const wantQ = String(r.package || '').trim() ? quality : null, wantS = r.scrSet ? screens : null;
        if (namedOwner && have.ownerId !== namedOwner.id) fx.push(['owner', `vendedor ${(db.users.find((u) => u.id === have.ownerId) || {}).name || '?'} → ${namedOwner.name}`]);
        if (wantQ && have.quality !== wantQ) fx.push(['q', `paquete ${have.quality ? QUALITIES[have.quality] : 'propio'} → ${QUALITIES[wantQ]}`]);
        if (wantS && have.screens !== wantS) fx.push(['s', `pantallas ${have.screens || '?'} → ${wantS}`]);
        if (!fx.length) { res.status = 'skip'; res.text = 'Ya está en el panel y ya coincide con el archivo'; continue; }
        const txt = fx.map((x) => x[1]).join(', ');
        if (dry) { res.status = 'ok'; res.text = `Ya está en el panel: se corregirá ${txt}`; continue; }
        const before = { ownerId: have.ownerId, quality: have.quality, screens: have.screens };
        for (const [k] of fx) { if (k === 'owner') have.ownerId = namedOwner.id; if (k === 'q') have.quality = wantQ; if (k === 's') have.screens = wantS; }
        if (fx.some((x) => x[0] !== 'owner')) { try { await applyState(have); } catch (e) { Object.assign(have, before); throw e; } }
        addLog('edicion', have, `Corregida al importar: ${txt}`, me);
        res.status = 'ok'; res.text = `Corregida: ${txt}`; done++; continue;
      }
      if (eu && eu.Policy && eu.Policy.IsAdministrator) { res.status = 'skip'; res.text = 'Es un administrador de Emby: no se gestiona'; continue; }
      const expired = diffDays(r.expires, today()) < 0;
      const password = typeof r.password === 'string' ? r.password : r.password == null ? '' : String(r.password);
      if (!eu && !create) throw new HttpError(400, `No existe en ${s.name}. Marca «Crear en Emby las que falten» para crearla.`);
      if (!eu && expired) { res.status = 'skip'; res.text = 'Ya caducada y no existe en Emby: no se crea'; continue; }
      if (!eu && password.length < 4) throw new HttpError(400, 'No existe en Emby y no trae contraseña (mínimo 4 caracteres) para crearla.');
      const what = `${owner.name}, ${s.name}, ${screens} ${screens === 1 ? 'pantalla' : 'pantallas'}, ${QUALITIES[quality]}, vence el ${r.expires}${copied ? ` (${copied} ${copied === 'contenido' ? 'copiado' : copied === 'pantallas' ? 'copiadas' : 'copiados'} de Emby)` : ''}`;
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
    screens: plan.screens, quality: plan.quality, lastMonths: plan.months,
    ...readContact(body, null), paid: body.paid !== false,
  };
  await createInEmby(c, password);
  c.password = password;
  db.clients.push(c);
  const what = `${plan.months} ${plan.months === 1 ? 'mes' : 'meses'}, ${plan.screens} ${plan.screens === 1 ? 'pantalla' : 'pantallas'}, ${QUALITIES[plan.quality]}`;
  spend(me, cost, `Alta de ${c.embyName} (${what})`);
  if (cost > 0) c.charges = [{ ts: new Date().toISOString(), userId: me.id, credits: cost, from: c.createdAt, to: c.expires, kind: 'alta' }];
  addLog('alta', c, `Alta: ${what}. Vence el ${c.expires}` + (cost ? `. ${cost} ${cost === 1 ? 'crédito' : 'créditos'}` : ''), me);
  libCheckLater(c);
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
  libCheckLater(c);
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
  if (!isStaff(me) && body.expires !== undefined && body.expires !== c.expires) throw new HttpError(403, 'La fecha de caducidad no se puede cambiar a mano. Usa «Renovar».');
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
  const before = { expires: c.expires, status: c.status, screens: c.screens, quality: c.quality, demo: c.demo, expiresAt: c.expiresAt, off: c.off, lastMonths: c.lastMonths };
  c.expires = addMonths(base, plan.months);
  c.screens = plan.screens; c.quality = plan.quality; c.lastMonths = plan.months; c.demo = false; delete c.expiresAt; delete c.off; delete c.offBy; // renovar la vuelve a activar
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
  libCheckLater(c);
  saveDb();
  return { ok: true, expires: c.expires };
}));

/* Cambiar pantallas. Quien paga créditos paga la diferencia de precio para el tiempo que le queda; bajar no devuelve nada */
function screensCost(c, n) {
  const old = c.screens || 1;
  if (n <= old) return 0;
  const days = Math.max(1, diffDays(c.expires, today()) + 1);
  const cols = Object.keys(db.settings.prices).map(Number).filter((m) => m > 0).sort((a, b) => a - b);
  const col = cols.find((m) => m * 30 >= days) || cols[cols.length - 1];
  return Math.max(0, price(col, n) - price(col, old));
}
route('POST', '/api/clients/:id/screens', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  const n = Number(body.screens);
  if (!SCREENS.includes(n)) throw new HttpError(400, 'Elige 1, 2 o 4 pantallas.');
  if (c.status === 'trash') throw new HttpError(400, 'Está en la papelera: restáurala o renuévala antes.');
  if (c.demo) throw new HttpError(400, 'Es una demo: conviértela en cuenta para elegir sus pantallas.');
  if (n === c.screens) return { ok: true, cost: 0 };
  const pays = paysCredits(me), valid = diffDays(c.expires, today()) >= 0;
  if (pays && !valid) throw new HttpError(400, 'Está caducada: al renovarla eliges las pantallas.');
  const cost = pays ? screensCost(c, n) : 0;
  if (body.preview) return { ok: true, cost };
  if (body.expect !== undefined && Number(body.expect) !== cost) throw new HttpError(409, `El precio ha cambiado: ahora son ${cost} ${cost === 1 ? 'crédito' : 'créditos'}. Vuelve a intentarlo.`);
  ensureCredits(me, cost);
  const old = c.screens || 1;
  c.screens = n;
  if (c.status === 'active' && valid && !c.off) { try { await grantAccess(c); } catch (e) { c.screens = old; throw e; } }
  const what = `${old} → ${n} ${n === 1 ? 'pantalla' : 'pantallas'}`;
  spend(me, cost, `Pantallas de ${c.embyName} (${what})`);
  if (cost > 0) c.charges = [...(c.charges || []), { ts: new Date().toISOString(), userId: me.id, credits: cost, from: today(), to: c.expires, kind: 'pantallas' }].slice(-24);
  addLog('edicion', c, `Pantallas cambiadas: ${what}` + (cost ? `. ${cost} ${cost === 1 ? 'crédito' : 'créditos'}` : ''), me);
  saveDb();
  return { ok: true, cost };
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
    libCheckLater(c);
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
  assertRoom(serverOf(c));
  const wasOff = c.off; delete c.off; delete c.offBy;
  try { await grantAccess(c); } catch (e) { if (wasOff) c.off = wasOff; throw e; }
  c.status = 'active';
  delete c.trashedAt; delete c.trashReason;
  addLog('restaurada', c, 'Restaurada desde la papelera', me);
  libCheckLater(c);
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
 * Regla: lo pagado en la última hora se devuelve entero; de lo demás, la parte del tiempo que no se ha usado.
 * Cada crédito vuelve a quien lo pagó. */
const REFUND_FULL_MS = 3600000; // v95: solo la primera hora se devuelve entero (antes 24 h: se podía regalar un día gratis y recuperar el crédito)
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
    if (now - Date.parse(ch.ts) < REFUND_FULL_MS) { back = ch.credits; why = 'pagado hace menos de 1 hora: se devuelve entero'; }
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
  say(true, `El servidor "${s.name}" responde (${srvKind(s)} ${(info && info.Version) || '?'}).`);
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
    if (c.screens > 0) say(!before || scrOk(s, before, c.screens), `Pantallas a la vez: ${c.screens}${before && !scrOk(s, before, c.screens) ? ' (corregido)' : ''}.`);
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
  if (c.serverId !== to.id && c.status !== 'trash') assertRoom(to);
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
route('POST', '/api/clients/:id/move', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  const to = serverById(body.serverId);
  if (!isStaff(me)) { // resellers y subresellers: solo a los servidores que tienen asignados, y no cuentas en la papelera
    if (!serverAllowed(me, to)) throw new HttpError(403, `No tienes permiso para usar el servidor "${to.name}".`);
    if (to.off) throw new HttpError(400, `El servidor "${to.name}" está pausado ahora mismo.`);
    if (c.status === 'trash') throw new HttpError(400, 'Está en la papelera: renuévala antes de cambiarla de servidor.');
  }
  const warning = await moveClient(me, c, to, typeof body.password === 'string' ? body.password : '');
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

/* Acción masiva: cambiar el número de pantallas (no cambia la fecha ni gasta créditos) */
route('POST', '/api/bulk/screens', STAFF, ({ me, body }) => lock(async () => {
  const list = bulkClients(me, body);
  const n = Number(body.screens);
  if (!SCREENS.includes(n)) throw new HttpError(400, 'Elige 1, 2 o 4 pantallas.');
  let moved = 0, skipped = 0;
  const failed = [];
  for (const c of list) {
    if (c.screens === n || c.status === 'trash') { skipped++; continue; }
    const was = c.screens;
    c.screens = n;
    try { await applyState(c); moved++; addLog('edicion', c, `Pantallas cambiadas en bloque: ${was || 'sin límite'} → ${n}`, me); }
    catch (e) { c.screens = was; failed.push({ name: c.panelName, emby: c.embyName, error: e.message }); }
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
      if (!known.has(u.Id)) out.notInPanel.push({ k: `np:${s.id}:${u.Id}`, sig: '1', server: s.name, serverId: s.id, embyId: u.Id, name: u.Name, disabled: !!pol.IsDisabled,
        libs: !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0, seen: vd(u.LastActivityDate), created: vd(u.DateCreated) });
    }
    out.servers.push({ id: s.id, name: s.name, emby: (users || []).length - admins, panel: mine.length, admins });
    for (const c of mine) {
      out.checked++;
      const row = { id: c.id, server: s.name, panelName: c.panelName, embyName: c.embyName, owner: names.get(c.ownerId) || '' };
      const u = byId.get(c.embyId);
      if (!u) { out.notInEmby.push({ ...row, k: `ne:${c.id}`, sig: '1' }); continue; }
      const pol = u.Policy || {};
      const hasLibs = !!pol.EnableAllFolders || (pol.EnabledFolders || []).length > 0;
      const problems = [];
      if (c.off && c.status !== 'trash') {
        if (!pol.IsDisabled) problems.push('la desactivaste en el panel, pero en Emby sigue activada');
        else if (hasLibs) problems.push('la desactivaste en el panel, pero en Emby conserva bibliotecas');
      } else if (c.status === 'active') {
        if (pol.IsDisabled) problems.push('en el panel está activa, pero en Emby está desactivada');
        else if (!hasLibs) problems.push('en el panel está activa, pero en Emby no tiene bibliotecas');
        if (c.screens > 0 && !scrOk(s, pol, c.screens)) problems.push(`tiene ${c.screens} ${c.screens === 1 ? 'pantalla' : 'pantallas'} en el panel y ${scrOf(s, pol) || 'sin límite'} en ${srvKind(s)}`);
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
      if (problems.length) out.mismatch.push({ ...row, problems, k: `mm:${c.id}`, sig: problems.join('|') });
    }
  }
  // Avisos que se vaciaron: no vuelven a salir salvo que cambien
  const hide = db.auditHide || {}, keep = (x) => hide[x.k] !== x.sig;
  const before = out.notInPanel.length + out.notInEmby.length + out.mismatch.length;
  out.notInPanel = out.notInPanel.filter(keep); out.notInEmby = out.notInEmby.filter(keep); out.mismatch = out.mismatch.filter(keep);
  out.hidden = before - (out.notInPanel.length + out.notInEmby.length + out.mismatch.length);
  return out;
});
route('POST', '/api/audit/hide', STAFF, ({ me, body }) => lock(async () => {
  if (!db.auditHide || typeof db.auditHide !== 'object') db.auditHide = {};
  const items = Array.isArray(body.items) ? body.items.slice(0, 20000) : [];
  for (const it of items) if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[1] === 'string') db.auditHide[it[0].slice(0, 120)] = it[1].slice(0, 2000);
  addLog('ajustes', null, `Auditoría vaciada (${items.length} ${items.length === 1 ? 'aviso' : 'avisos'})`, me);
  saveDb();
  return { ok: true };
}));
route('POST', '/api/audit/unhide', STAFF, ({ me }) => lock(async () => {
  db.auditHide = {};
  addLog('ajustes', null, 'Auditoría: vuelven a mostrarse los avisos ocultos', me);
  saveDb();
  return { ok: true };
}));

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
/* Importar resellers y subresellers desde Excel o CSV.
   Columnas: usuario, nombre, tipo (reseller / subreseller), reseller (usuario del que depende un subreseller), créditos, contraseña.
   Si no trae contraseña se inventa una; al entrar la primera vez tendrán que cambiarla. Con «check» solo se comprueba. */
const VEN_ROLE = (v) => { const t = String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, ''); return /^(sub|subreseller|subrevendedor|subvendedor)$/.test(t) ? 'sub' : /^(reseller|revendedor|vendedor|res|r)?$/.test(t) ? 'reseller' : ''; };
route('POST', '/api/users/import', STAFF, ({ me, body }) => lock(async () => {
  needPerm(me, 'resellers');
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  if (!rows.length) throw new HttpError(400, 'El archivo no trae ningún vendedor.');
  const check = !!body.check, out = { created: [], skipped: [], willCreate: 0 };
  const taken = new Set(db.users.map((u) => u.username)), batch = new Map(); // usuario -> rol, de este mismo archivo
  // Primero los resellers, después los subresellers (así su reseller ya existe)
  const norm = rows.map((r, i) => ({ i: i + 2, r, role: VEN_ROLE(r.role) })).sort((a, b) => (a.role === 'sub') - (b.role === 'sub'));
  for (const { i, r, role } of norm) {
    const fail = (error) => out.skipped.push({ row: i, username: String(r.username || ''), error });
    let username;
    try { username = readUsername(r.username); } catch (e) { fail(e.message); continue; }
    if (!role) { fail('El tipo debe ser «reseller» o «subreseller».'); continue; }
    if (taken.has(username)) { fail('Ese usuario ya existe en el panel.'); continue; }
    let parentId = null, parentName = '';
    if (role === 'sub') {
      const pn = String(r.parent || '').trim().toLowerCase();
      if (!pn) { fail('Un subreseller necesita la columna «reseller» con el usuario del que depende.'); continue; }
      const p = db.users.find((u) => u.username === pn || u.name.toLowerCase() === pn);
      if (p) { if (p.role !== 'reseller') { fail(`«${pn}» no es un reseller.`); continue; } parentId = p.id; parentName = p.name; }
      else if (batch.get(pn) === 'reseller') { parentName = pn; }
      else { fail(`No encuentro el reseller «${pn}». Créalo antes o ponlo en el mismo archivo.`); continue; }
    }
    const credits = Math.max(0, Math.floor(Number(String(r.credits || '0').replace(',', '.')) || 0));
    if (credits > 100000) { fail('Demasiados créditos.'); continue; }
    let password = String(r.password || '').trim();
    if (password && password.length < 8) { fail('La contraseña debe tener al menos 8 caracteres (o déjala vacía y se inventa una).'); continue; }
    taken.add(username); batch.set(username, role);
    if (check) { out.willCreate++; continue; }
    if (!password) password = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + crypto.randomInt(10, 99);
    if (role === 'sub' && !parentId) { const p = db.users.find((u) => u.username === parentName); parentId = p.id; parentName = p.name; }
    const u = { id: newId(), username, name: str(r.name, 60) || username, role, parentId, credits: 0, disabled: false, createdAt: today(), mustPw: true };
    setPassword(u, password);
    db.users.push(u);
    if (credits) { u.credits = credits; addLedger(u, credits, 'Saldo inicial (importado)', me, 'ajuste'); }
    out.created.push({ username, name: u.name, role, parent: parentName, credits, password });
  }
  if (!check && out.created.length) { addLog('usuario', null, `Importados ${out.created.length} ${out.created.length === 1 ? 'vendedor' : 'vendedores'} desde archivo`, me); saveDb(); }
  return out;
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
  for (const s of serversFor(me)) {
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
    const price = Number(String(p.price == null ? '' : p.price).replace(',', '.')) || 0;
    if (price < 0 || price > 1000000) throw new HttpError(400, 'El precio de un paquete no es válido.');
    packs.push(price > 0 ? { name, credits, price: Math.round(price * 100) / 100 } : { name, credits });
  }
  db.settings.creditPacks = packs;
  saveDb();
  return { ok: true };
}));
/* Precio general del crédito y precios por cantidad (tramos) para las compras online */
route('PUT', '/api/price-tiers', SUPER, ({ me, body }) => lock(async () => {
  const num = (v) => Number(String(v == null ? '' : v).replace(',', '.'));
  const tiers = [];
  for (const t of Array.isArray(body.tiers) ? body.tiers.slice(0, 8) : []) {
    const from = num(t && t.from), price = num(t && t.price);
    if (!from && !price) continue;
    if (!Number.isInteger(from) || from < 1 || from > 100000) throw new HttpError(400, 'En cada tramo, «desde» debe ser un número entero de créditos (1 o más).');
    if (!(price > 0) || price > 100000) throw new HttpError(400, 'En cada tramo pon un precio por crédito mayor que 0.');
    if (tiers.some((x) => x.from === from)) throw new HttpError(400, `Hay dos tramos que empiezan en ${from}.`);
    tiers.push({ from, price: Math.round(price * 100) / 100 });
  }
  tiers.sort((a, b) => a.from - b.from);
  if (tiers.length && tiers[0].from !== 1) throw new HttpError(400, 'El primer tramo debe empezar en 1 crédito.');
  db.settings.priceTiers = tiers;
  if (body.price !== undefined) { const g = num(body.price); if (!(g >= 0) || g > 100000) throw new HttpError(400, 'El precio general no es válido.'); db.settings.creditPrice = Math.round(g * 100) / 100; }
  addLog('ajustes', null, tiers.length ? `Precios por cantidad: ${tiers.map((t) => `desde ${t.from} → ${t.price}`).join(' · ')}` : 'Precios por cantidad quitados', me);
  saveDb();
  return { ok: true };
}));

/* ---------- Alertas: transcodificacion y sesiones excedidas ---------- */
const recent = new Map(); // clave -> momento del ultimo aviso, para no repetir el mismo
async function stopSession(s, x, text) {
  await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: 'Aviso', Text: text, TimeoutMs: 10000 }).catch(() => {});
  await emby(s, 'POST', `/Sessions/${x.Id}/Playing/Stop`, {});
}
/** Último recurso cuando un aparato no obedece a «Detener»: se borra el aparato en Emby y su sesión se cierra.
    El cliente tendrá que volver a entrar con su usuario y contraseña. */
async function logoutDevice(s, x) {
  if (!x.DeviceId) throw new Error('sin aparato');
  await emby(s, 'POST', `/Sessions/${x.Id}/Message`, { Header: 'Aviso', Text: 'Has superado el número de pantallas de tu cuenta. Se ha cerrado la sesión en este aparato.', TimeoutMs: 10000 }).catch(() => {});
  await emby(s, 'DELETE', `/Devices?Id=${encodeURIComponent(x.DeviceId)}`);
}
const stoppedAt = new Map(); // reproduccion detenida por exceso de pantallas -> cuando (para ver si de verdad se ha parado)
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
          if (recent.has(key) && now - recent.get(key) < (cfg.sessions.stop ? 25000 : 30 * 60000)) continue;
          recent.set(key, now);
          let action = 'Solo aviso';
          if (cfg.sessions.stop) {
            // por defecto se detienen las que llevan menos tiempo reproduciendo; tambien se puede lo contrario, o todas
            const pol = cfg.sessions.policy, dir = pol === 'oldest' ? -1 : 1;
            const extra = [...live].sort((a, b) => dir * (((a.PlayState || {}).PositionTicks || 0) - ((b.PlayState || {}).PositionTicks || 0))).slice(0, pol === 'all' ? live.length : live.length - c.screens);
            let ok = 0, out = 0, fail = 0;
            for (const sk of [...stoppedAt.keys()]) if (now - stoppedAt.get(sk) > 10 * 60000) stoppedAt.delete(sk);
            for (const x of extra) {
              const sk = `${s.id}:${x.Id}`;
              // Ya se le dijo que parase y sigue reproduciendo, o el aparato no admite que se le pare desde fuera: se cierra su sesión
              const stubborn = (stoppedAt.has(sk) && now - stoppedAt.get(sk) < 5 * 60000) || x.SupportsRemoteControl === false;
              if (stubborn && cfg.sessions.logout !== false) { try { await logoutDevice(s, x); out++; stoppedAt.delete(sk); continue; } catch (e) { /* se intenta detener */ } }
              try { await stopSession(s, x, cfg.sessions.message); ok++; stoppedAt.set(sk, now); }
              catch (e) {
                if (cfg.sessions.logout !== false) { try { await logoutDevice(s, x); out++; continue; } catch { /* nada */ } }
                fail++;
              }
            }
            const parts2 = [];
            if (ok) parts2.push(`${ok} ${ok === 1 ? 'reproducción detenida' : 'reproducciones detenidas'}`);
            if (out) parts2.push(`${out} ${out === 1 ? 'aparato desconectado (no obedecía)' : 'aparatos desconectados (no obedecían)'}`);
            if (fail) parts2.push(`${fail} sin poder detener`);
            action = parts2.length ? parts2.join(' · ') : 'No se pudo detener';
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
    if (k === 'sessions' && b.logout !== undefined) cur[k].logout = !!b.logout;
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
  await Promise.all(serversFor(me).map(async (s) => {
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
        out.push({ server: s.name, clientId: byEmby.get(x.UserId) || null, user: x.UserName || '', device: x.DeviceName || '', app: x.Client || '', title, paused: !!ps.IsPaused, method: ps.PlayMethod || '', position: ps.PositionTicks || 0, duration: it.RunTimeTicks || 0, trVideo: !!x.TranscodingInfo && x.TranscodingInfo.IsVideoDirect === false, trAudio: !!x.TranscodingInfo && x.TranscodingInfo.IsAudioDirect === false });
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
  for (const s of serversFor(me)) {
    if (only && s.id !== only) continue;
    if (!kindMatch(body.tab, s)) continue;
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
  // Todos los servidores (antes ponía serversFor(me), y aquí no hay «me»: daba error y no vigilaba nada)
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
        h.lastUp = new Date().toISOString(); h.lastMins = mins;
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
route('GET', '/api/health', '*', ({ me }) => ({ servers: serversFor(me).map((s) => { const h = health.get(s.id); return { id: s.id, name: s.name, kind: s.kind === 'jellyfin' ? 'jellyfin' : 'emby', ok: h ? !h.down : null, since: h && h.down ? h.since : null, lastUp: (h && h.lastUp) || null, lastMins: (h && h.lastMins) || 0, checked: h ? h.checked : null, version: h ? h.version || '' : '', ms: h ? h.ms || 0 : 0 }; }) }));

/* ---------- Estadísticas de uso: el panel apunta cada minuto lo que se está viendo ---------- */
const PLAY_MS = Number(process.env.PLAY_MS) || 60000;
const seenToday = { day: '', keys: new Set() };
const multiStreak = new Map(); // cuentas vistas en varios aparatos en la revisión anterior
/* Pausas largas: si una reproducción de un cliente del panel lleva en pausa más de X minutos, se cierra
   (con un mensaje en su pantalla). Así no se quedan conversiones de vídeo abiertas gastando el servidor. */
const pausedSince = new Map(); // "servidor:sesión" -> { at, item }
async function pauseCheck(s, list, byEmby) {
  const cfg = db.settings.pauseStop || { on: true, minutes: 15 };
  const seen = new Set(), now = Date.now(), lim = (Number(cfg.minutes) || 15) * 60000;
  for (const x of list) {
    if (!x || !x.NowPlayingItem) continue;
    const key = s.id + ':' + x.Id, item = String(x.NowPlayingItem.Id || '');
    seen.add(key);
    if (!(x.PlayState || {}).IsPaused) { pausedSince.delete(key); continue; }
    const p = pausedSince.get(key);
    if (!p || p.item !== item) { pausedSince.set(key, { at: now, item }); continue; }
    if (!cfg.on || now - p.at < lim) continue;
    const c = byEmby.get(x.UserId);
    if (!c) continue; // solo cuentas del panel: administradores y usuarios ajenos no se tocan
    p.at = now; // si la app no obedece, se vuelve a intentar pasado otro rato, no cada minuto
    const mins = Math.round(lim / 60000);
    try {
      await stopSession(s, x, `Tu reproducción llevaba más de ${mins} minutos en pausa y se ha cerrado para liberar el servidor. Puedes volver a darle a reproducir cuando quieras: seguirá donde lo dejaste.`);
      await lock(async () => { addLog('monitor', c, `Pausa de más de ${mins} min cerrada: «${sessionTitle(x).slice(0, 60)}» en ${x.DeviceName || 'un aparato'}`, null); saveDb(); });
    } catch (e) { console.error('Pausas largas:', e.message); }
  }
  for (const k of [...pausedSince.keys()]) if (k.startsWith(s.id + ':') && !seen.has(k)) pausedSince.delete(k);
}
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
    const multiNow = new Map(); // cuenta -> aparatos viendo a la vez en esta revisión
    for (const s of db.servers) {
      let list;
      try { list = await emby(s, 'GET', '/Sessions'); } catch { continue; }
      const byEmby = new Map(db.clients.filter((c) => c.serverId === s.id).map((c) => [c.embyId, c]));
      const playing = new Map(); // cuenta -> aparatos reproduciendo ahora mismo
      // Solo cuenta lo que se está viendo de verdad: una película en pausa en otro aparato no suma
      for (const x of list || []) if (x.NowPlayingItem && !(x.PlayState || {}).IsPaused && byEmby.has(x.UserId)) { const c = byEmby.get(x.UserId); if (!playing.has(c)) playing.set(c, new Set()); playing.get(c).add(x.DeviceId || x.Id); }
      for (const [c, devs] of playing) if (devs.size > 1) multiNow.set(c.id, devs.size);
      await pauseCheck(s, list || [], byEmby);
      await appOnlyCheck(s, list || [], byEmby);
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
    // «A la vez» solo cuenta si se ve en 2 revisiones seguidas (unos 2 minutos): así no salta al cambiar de aparato
    for (const [id, n] of multiNow) { const prev = multiStreak.get(id); if (prev) recordPeak({ id }, Math.min(n, prev)); }
    multiStreak.clear(); for (const [id, n] of multiNow) multiStreak.set(id, n);
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
    if (conn._peaks) for (const k of Object.keys(conn._peaks)) { conn._peaks[k] = conn._peaks[k].filter((r) => Date.parse(r[0]) >= lim); if (!conn._peaks[k].length || !db.clients.some((c) => String(c.id) === k)) delete conn._peaks[k]; }
    for (const k of Object.keys(conn)) { if (k === '_peaks') continue; conn[k] = conn[k].filter((r) => Date.parse(r[1]) >= lim).slice(-150); if (!conn[k].length || !db.clients.some((c) => String(c.id) === k)) delete conn[k]; }
    fs.writeFileSync(CONN_FILE + '.tmp', JSON.stringify(conn)); fs.renameSync(CONN_FILE + '.tmp', CONN_FILE);
    connDirty = false; connSaved = Date.now();
  } catch (e) { console.error('Conexiones:', e.message); }
}
/** Momentos en que una cuenta reproducía en varios aparatos A LA VEZ (visto en Emby en el mismo minuto) */
function recordPeak(c, n) {
  const all = connLoad(), pk = all._peaks || (all._peaks = {}), list = pk[c.id] || (pk[c.id] = []);
  const last = list[list.length - 1], nowIso = new Date().toISOString();
  if (last && Date.now() - Date.parse(last[0]) < 10 * 60000 && last[2] >= 0) { last[0] = nowIso; if (n > last[1]) last[1] = n; last[2]++; }
  else list.push([nowIso, n, 2]); // 2 = ya visto en dos revisiones seguidas
  if (list.length > 100) pk[c.id] = list.slice(-100);
  connDirty = true;
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
  // «Borrar y empezar de cero»: lo anterior a esa fecha ya no cuenta para el detector (el historial de conexiones se conserva)
  const lim = Math.max(Date.now() - days * 86400000, Date.parse(c.shareReset || '') || 0), rows = (connLoad()[c.id] || []).filter((r) => Date.parse(r[1]) >= lim);
  const devs = new Map(), zones = new Set();
  for (const r of rows) { devs.set(r[5], { name: r[2], app: r[3], last: r[1] }); if (r[4]) zones.add(ipZone(r[4])); }
  // Aparatos a la vez: solo cuenta cuando Emby los ve REPRODUCIENDO en el mismo minuto.
  // (Antes se contaban también apps abiertas sin ver nada o el cambio de un aparato a otro, y daba avisos falsos.)
  let maxAt = Math.min(1, rows.filter((r) => r[6]).length);
  // Solo momentos vistos al menos en 2 revisiones (los de un solo instante solían ser un cambio de aparato)
  for (const p of ((connLoad()._peaks || {})[c.id] || [])) if (Date.parse(p[0]) >= lim && (p[2] || 0) >= 2 && p[1] > maxAt) maxAt = p[1];
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
route('POST', '/api/shared/clear', '*', ({ me, body }) => lock(async () => {
  const vis = visibleOwners(me), now = new Date().toISOString();
  const list = db.clients.filter((c) => c.status !== 'trash' && (!vis || vis.has(c.ownerId)) && (body.id ? c.id === Number(body.id) : true));
  let n = 0;
  for (const c of list) { if (body.id || shareInfo(c).level !== 'no') { c.shareReset = now; n++; } }
  shareCache.clear();
  if (n) addLog('ajustes', null, body.id ? `Cuentas compartidas: borrados los datos de ${list[0] ? list[0].panelName : 'una cuenta'}` : `Cuentas compartidas: lista vaciada (${n})`, me);
  saveDb();
  return { ok: true, cleared: n };
}));
route('GET', '/api/shared', '*', ({ me }) => {
  const vis = visibleOwners(me);
  const list = db.clients.filter((c) => c.status !== 'trash' && !c.demo && (!vis || vis.has(c.ownerId)))
    .map((c) => ({ id: c.id, ...shareInfo(c) })).filter((x) => x.level !== 'no')
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'alto' ? -1 : 1) || b.devices - a.devices);
  return { list, since: (() => { let min = null; for (const v of Object.values(connLoad())) if (Array.isArray(v)) for (const r of v) if (!min || r[0] < min) min = r[0]; return min; })() };
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
  list: fuVisible(me).map(({ tgChat, ...f }) => ({ ...f, tgLinked: !!tgChat, text: fillText(tplFor(f.ownerId, 'followup'), { panelName: f.name, embyName: f.emby, serverId: f.serverId, expires: today(), screens: 0, quality: null }) })),
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
/* Borrar demos del seguimiento cuando se quiera: se borra la demo terminada (de Emby y del panel) y desaparece de la lista.
   Si la demo se convirtió en cuenta, la cuenta NO se toca: solo se quita de esta lista. */
async function fuDelete(me, f) {
  const c = db.clients.find((x) => x.id === f.clientId);
  let removed = false;
  if (c && c.demo && c.status === 'trash') {
    await deleteEmbyUser(c);
    db.clients = db.clients.filter((x) => x !== c);
    addLog('eliminada', c, 'Demo borrada desde Seguimiento de demos', me);
    removed = true;
  }
  db.followups = db.followups.filter((x) => x !== f);
  return removed;
}
route('POST', '/api/followups/:id/delete', '*', ({ me, params }) => lock(async () => {
  const f = fuVisible(me).find((x) => x.id === params.id);
  if (!f) throw new HttpError(404, 'Ese seguimiento ya no existe.');
  const removed = await fuDelete(me, f);
  saveDb();
  return { ok: true, removed };
}));
route('POST', '/api/followups-delete', '*', ({ me, body }) => lock(async () => {
  const which = body.tab === 'done' ? (f) => f.status !== 'pending' : (f) => f.status === 'pending';
  let n = 0, failed = 0;
  for (const f of fuVisible(me).filter(which)) { try { await fuDelete(me, f); n++; } catch { failed++; } }
  saveDb();
  return { ok: true, n, failed };
}));
route('POST', '/api/followups/:id/telegram', '*', async ({ me, params, body }) => {
  const f = fuVisible(me).find((x) => x.id === params.id);
  if (!f) throw new HttpError(404, 'Ese seguimiento ya no existe.');
  if (!f.tgChat) throw new HttpError(400, 'Este cliente no tenía Telegram enlazado. Escríbele por WhatsApp o copia el mensaje.');
  const text = (typeof body.text === 'string' && body.text.trim()) ? body.text.trim().slice(0, 1500) : fillText(tplFor(f.ownerId, 'followup'), { panelName: f.name, embyName: f.emby, serverId: f.serverId, expires: today(), screens: 0, quality: null });
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
    && (!Number(body.serverId) || c.serverId === Number(body.serverId)) && (!Number(body.ownerId) || c.ownerId === Number(body.ownerId))
    && kindMatch(body.tab, db.servers.find((x) => x.id === c.serverId)));
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
/* Precio del crédito. Orden: el precio propio del vendedor; si no tiene, los tramos por cantidad
   (por ejemplo, de 1 a 99 créditos a 3 € y desde 100 a 2,50 €); si no hay tramos, el precio general. */
const priceTiers = () => (Array.isArray(db.settings.priceTiers) ? db.settings.priceTiers : []).filter((t) => t && t.from >= 1 && t.price > 0).sort((a, b) => a.from - b.from);
function unitPrice(u, credits) {
  if (u && Number(u.creditPrice) > 0) return Number(u.creditPrice);
  const tiers = priceTiers();
  if (tiers.length) { let t = tiers[0]; for (const x of tiers) if (credits >= x.from) t = x; return Number(t.price); }
  return Number(db.settings.creditPrice || 0);
}
/** Valor de un crédito para saldos y deudas (sin cantidad: el precio normal, el del primer tramo) */
const buyerPrice = (u) => Number(u.creditPrice || db.settings.creditPrice || (priceTiers()[0] || {}).price || 0);
/** Lo que cuesta comprar X créditos (o un paquete con precio fijo) */
const buyAmount = (u, credits, pack) => Math.round((pack && Number(pack.price) > 0 ? Number(pack.price) : credits * unitPrice(u, credits)) * 100) / 100;
const canBuy = (u) => (u.role === 'reseller' || u.role === 'sub') && !u.disabled;
function panelBase(req) {
  const fixed = (db.settings.brand.url || '').replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
async function stripeCall(method, p, form, keyOverride) {
  const key = keyOverride || db.payCfg.stripe.key;
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
  const out = { canBuy: canBuy(me), methods, price, currency: cur, min: c.min, own: Number(me.creditPrice) > 0, tiers: Number(me.creditPrice) > 0 ? [] : priceTiers(), packs: (db.settings.creditPacks || []).map((p, i) => ({ i, name: p.name, credits: p.credits, fixed: Number(p.price) > 0, amount: buyAmount(me, p.credits, p) })), orders: mine };
  if (me.role === 'super') {
    out.cfg = { stripe: { on: c.stripe.on, hasKey: !!c.stripe.key, test: /^sk_test_/.test(c.stripe.key), hasWh: !!c.stripe.whsec }, nowpay: { on: c.nowpay.on, hasKey: !!c.nowpay.key, hasIpn: !!c.nowpay.ipn }, min: c.min };
    out.all = db.orders.filter((o) => o.kind !== 'client').slice(0, 100).map(pubOrder);
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
  let credits, packName = '', packObj = null;
  if (body.pack !== undefined && body.pack !== null && body.pack !== '') { const p = packs[Number(body.pack)]; if (!p) throw new HttpError(400, 'Ese paquete ya no existe.'); credits = p.credits; packName = p.name; packObj = p; }
  else { credits = Number(body.credits); if (!Number.isInteger(credits) || credits < c.min || credits > 100000) throw new HttpError(400, `Elige entre ${c.min} y 100000 créditos.`); }
  const cur = (db.settings.currency || 'EUR').toUpperCase();
  const amount = buyAmount(me, credits, packObj);
  if (!(amount > 0)) throw new HttpError(400, 'Tu precio por crédito no está configurado. Avisa al administrador.');
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
  if (!o || o.kind === 'client' || (o.userId !== me.id && me.role !== 'super')) throw new HttpError(404, 'Ese pedido no existe.');
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
  const um = /^\/api\/pay\/stripe\/webhook\/u(\d+)$/.exec(pathname);
  if (pathname === '/api/pay/stripe/webhook' || um) {
    const vu = um ? db.users.find((u) => u.id === Number(um[1])) : null;
    if (um && !vu) return bad(404, 'no');
    const wh = um ? (vu.clientPay || {}).whsec : db.payCfg.stripe.whsec;
    if (!wh) return bad(400, 'webhook sin configurar');
    const sig = String(req.headers['stripe-signature'] || ''), t = (/t=(\d+)/.exec(sig) || [])[1], v1s = [...sig.matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1]);
    if (!t || !v1s.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return bad(400, 'firma');
    const expect = crypto.createHmac('sha256', wh).update(`${t}.${raw}`).digest('hex');
    if (!v1s.some((v) => v.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)))) return bad(400, 'firma');
    let ev; try { ev = JSON.parse(raw); } catch { return bad(400, 'json'); }
    const ss = ev.data && ev.data.object;
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      const o = db.orders.find((x) => x.method === 'stripe' && x.extId === (ss && ss.id) && (um ? x.vendorId === vu.id : !x.vendorId));
      if (o && ss.payment_status === 'paid' && ss.amount_total === Math.round(o.amount * 100) && String(ss.currency).toUpperCase() === o.currency) await lock(async () => { if (o.kind === 'client' ? await cpPaid(o, 'aviso de Stripe') : markPaid(o, 'aviso de Stripe')) saveDb(); });
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

/* ======================================================================
   Cobro a clientes con Stripe: el cliente abre su enlace (/pagar/…), elige meses, paga con tarjeta
   y el panel le renueva la cuenta solo. Se activa en Ajustes › Cobro a clientes.
   ====================================================================== */
const cpCfg = () => db.settings.clientPay || { on: false, prices: {} };
const siteBase = () => (db.settings.brand.url || db.settings.siteBase || (db.settings.app || {}).base || '').replace(/\/+$/, '');
let payKeySave = false;
function payKeyOf(c) {
  if (c.payKey) return c.payKey;
  c.payKey = crypto.randomBytes(9).toString('hex');
  // la llave nueva se guarda enseguida, para que el enlace que ya se ha enviado siga valiendo tras reiniciar
  if (!payKeySave) { payKeySave = true; setTimeout(() => { payKeySave = false; lock(async () => saveDb()).catch(() => {}); }, 200); }
  return c.payKey;
}
const cpLink = (c) => `${siteBase()}/pagar/${c.id}-${payKeyOf(c)}`;
/* Quién cobra cada cuenta:
   - las del superadministrador y sus administradores: con la configuración y el Stripe del superadministrador
   - las de un reseller o subreseller: con SUS precios y SU propio Stripe (el dinero le llega a él y se le descuentan
     los créditos de la renovación), solo si el superadministrador lo ha permitido para los vendedores */
function cpCtx(c) {
  if (!c || c.demo) return null;
  const o = db.users.find((u) => u.id === c.ownerId);
  if (!o || o.role === 'super' || o.role === 'admin') {
    const cfg = cpCfg();
    return cfg.on && db.payCfg.stripe.on && db.payCfg.stripe.key ? { cfg, key: db.payCfg.stripe.key, vendor: null } : null;
  }
  const v = o.clientPay;
  if (!cpCfg().vendors || o.disabled || !v || !v.on || !v.key) return null;
  return { cfg: v, key: v.key, vendor: o };
}
const cpEligible = (c) => !!cpCtx(c);
function cpOptions(c, ctx, scr) {
  const pr = ((ctx || cpCtx(c) || {}).cfg || {}).prices || {}, sc = scr || c.screens || 1;
  return [1, 3, 6, 12].map((m) => ({ m, sc, price: Number(pr[`${m}-${sc}`]) || 0 })).filter((x) => x.price >= 0.5);
}
/** Pantallas que el cliente puede elegir al pagar: las que tienen algún precio (y, si es de un vendedor, las que tienen precio en créditos) */
function cpScreens(c, ctx) {
  const ok = (sc) => { if (!ctx || !ctx.vendor) return true; try { costFor(ctx.vendor, 1, sc); return true; } catch { return false; } };
  return [1, 2, 3, 4].filter((sc) => cpOptions(c, ctx, sc).length && ok(sc));
}
const cpReady = () => true; // cada cuenta lo decide cpCtx
const orderKey = (o) => { if (!o.vendorId) return db.payCfg.stripe.key; const u = db.users.find((x) => x.id === o.vendorId); return u && u.clientPay && u.clientPay.key; };
/** Pago de un cliente confirmado: se renueva su cuenta una sola vez */
async function cpPaid(o, via) {
  if (o.status === 'paid') return false;
  const c = db.clients.find((x) => x.id === o.clientId);
  o.status = 'paid'; o.paidAt = new Date().toISOString();
  if (!c) { o.note = 'La cuenta ya no existe'; notifyStaff('payments', `⚠️ Pago de cliente recibido (${o.amount.toFixed(2)} ${o.currency}) pero la cuenta ya no existe. Pedido ${o.id}.`); return true; }
  const t = today(), base = !c.demo && diffDays(c.expires, t) >= 0 ? c.expires : t, prev = c.expires;
  const oldScr = c.screens;
  c.expires = addMonths(base, o.months); c.lastMonths = o.months; c.demo = false; c.status = 'active'; c.paid = true;
  if (o.screens && [1, 2, 3, 4].includes(o.screens)) c.screens = o.screens; // eligió otras pantallas al pagar
  delete c.expiresAt; delete c.off; delete c.offBy; delete c.trashedAt; delete c.trashReason;
  try { await grantAccess(c); delete c.lastError; }
  catch (e) { c.lastError = e.message; notifyStaff('payments', `⚠️ ${c.panelName} ha pagado y la fecha ya está renovada, pero Emby dio un error al dar acceso: ${e.message}. El vigilante lo volverá a intentar.`); }
  const what = `${o.months} ${o.months === 1 ? 'mes' : 'meses'}, ${c.screens || 1} ${c.screens === 1 ? 'pantalla' : 'pantallas'}${oldScr && oldScr !== c.screens ? ` (antes ${oldScr})` : ''}`;
  const vend = o.vendorId ? db.users.find((u) => u.id === o.vendorId) : null;
  if (vend) { // la renovación le cuesta sus créditos, como si la hiciera él (aunque se quede en negativo: el cliente ya ha pagado)
    const cost = costFor(vend, o.months, c.screens || 1);
    spend(vend, cost, `Renovación pagada online por el cliente: ${c.embyName} (${what})`);
    if (cost > 0) c.charges = [...(c.charges || []), { ts: new Date().toISOString(), userId: vend.id, credits: cost, from: base, to: c.expires, kind: 'renovacion' }].slice(-24);
    notifyUser(vend, `💳 Tu cliente ${c.panelName} ha pagado ${o.amount.toFixed(2)} ${o.currency} y su cuenta se ha renovado sola hasta el ${c.expires.split('-').reverse().join('/')}.${cost ? `\nSe han descontado ${cost} créditos. Saldo: ${vend.credits}.` : ''}${vend.credits < 0 ? '\n⚠️ Tu saldo está en negativo: pide una recarga.' : ''}`);
  }
  addLog('renovacion', c, `Renovada pagando online (${what}): ${o.amount.toFixed(2)} ${o.currency}. Vence el ${c.expires}`, null);
  addLog('cobro', c, `Cobro online de ${c.panelName}: ${o.amount.toFixed(2)} ${o.currency} con tarjeta (pedido ${o.id}${via ? ', ' + via : ''})`, null);
  o.expiresBefore = prev; o.expiresAfter = c.expires;
  libCheckLater(c);
  if (!vend) notifyStaff('payments', `💳 ${c.panelName} (@${c.embyName}) ha pagado ${o.amount.toFixed(2)} ${o.currency} y su cuenta se ha renovado sola.\n${what} · vence el ${c.expires.split('-').reverse().join('/')}\n${whenTxt()}`);
  if (c.tgChat) tg('sendMessage', { chat_id: c.tgChat, text: `✅ Pago recibido. ¡Gracias, ${c.panelName}!\n\nTu cuenta está renovada hasta el ${c.expires.split('-').reverse().join('/')}. No tienes que hacer nada más.` }).catch(() => {});
  return true;
}
const H = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function cpPage(res, code, title, body) {
  const brand = H(db.settings.brand.name || 'Panel');
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${H(title)} · ${brand}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#eef4f8;background:radial-gradient(70% 60% at 10% 0%,#0e4a6b,transparent),radial-gradient(60% 60% at 100% 100%,#4c1d95,transparent),#060b18;display:grid;place-items:center;padding:18px}
.card{width:min(460px,100%);padding:26px 22px;border-radius:24px;background:rgba(10,16,30,.78);border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 70px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:24px}.sub{margin:0 0 18px;color:#9fb6c2;font-size:14.5px;line-height:1.45}.brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#7dd3fc;margin-bottom:12px;font-weight:800}
.op{display:flex;align-items:center;gap:12px;width:100%;margin:0 0 10px;padding:14px 16px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:inherit;cursor:pointer;text-align:left}
.op:hover{border-color:#a78bfa;background:rgba(167,139,250,.12)}.op b{font-size:16px}.op small{display:block;color:#9fb6c2;font-size:12.5px}.op .p{margin-left:auto;font-size:20px;font-weight:900;white-space:nowrap}
.op.best{border-color:#f472b6;background:linear-gradient(120deg,rgba(14,165,233,.16),rgba(236,72,153,.16))}.tag{display:inline-block;margin-left:6px;font-size:10.5px;font-weight:900;padding:2px 7px;border-radius:99px;background:#ec4899;color:#fff;vertical-align:2px}
.lbl{margin:14px 0 8px;font-size:13px;font-weight:800;color:#cfe0ea}.tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:8px}
.tab{display:flex;flex-direction:column;align-items:center;padding:10px 6px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;text-decoration:none}.tab b{font-size:20px}.tab small{font-size:11px;color:#9fb6c2;text-align:center}
.tab.on{border:0;background:linear-gradient(135deg,#0ea5e9,#8b5cf6,#ec4899);box-shadow:0 8px 20px rgba(139,92,246,.35)}.tab.on small{color:#fff}
.note{margin:10px 0 0;padding:10px 12px;border-radius:12px;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.35);font-size:13.5px;color:#fde68a}
.big{font-size:56px;text-align:center;margin:4px 0 8px}.ok{color:#4ade80}.foot{margin-top:16px;font-size:12px;color:#7f93a1;text-align:center;line-height:1.5}</style>
<body><main class="card"><div class="brand">${brand}</div>${body}</main></body></html>`);
}
function cpFind(token) {
  const m = /^(\d+)-([0-9a-f]{18})$/.exec(String(token || ''));
  if (!m) return null;
  const c = db.clients.find((x) => x.id === Number(m[1]));
  if (!c || !c.payKey || c.payKey.length !== m[2].length || !crypto.timingSafeEqual(Buffer.from(c.payKey), Buffer.from(m[2]))) return null;
  return c;
}
/** Las páginas públicas /pagar/… (sin sesión: el enlace secreto de cada cliente es la llave) */
async function cpRoute(req, res, pathname) {
  const m = /^\/pagar\/([\w-]+)(\/checkout)?$/.exec(pathname);
  const c = m && cpFind(m[1]);
  const fmtD = (d) => d.split('-').reverse().join('/');
  if (!c) return cpPage(res, 404, 'Enlace no válido', '<h1>Enlace no válido</h1><p class="sub">Este enlace de pago no existe o ha cambiado. Pídele uno nuevo a tu proveedor.</p>');
  const ctx = cpCtx(c);
  const q0 = new URL(req.url, 'http://x').searchParams;
  if (!ctx && !q0.get('o')) return cpPage(res, 200, 'Pago no disponible', `<h1>Hola, ${H(c.panelName)}</h1><p class="sub">El pago online no está disponible ahora mismo. Habla con tu proveedor para renovar.</p>`);
  const opts = ctx ? cpOptions(c, ctx) : [], cur = (db.settings.currency || 'EUR').toUpperCase(), money = (n) => n.toLocaleString('es-ES', { style: 'currency', currency: cur });
  if (m[2] && req.method === 'POST') {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 2000) break; chunks.push(ch); }
    const fp = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const months = Number(fp.get('m')), scr = Number(fp.get('s')) || c.screens || 1;
    const op = cpScreens(c, ctx).includes(scr) ? cpOptions(c, ctx, scr).find((x) => x.m === months) : null;
    if (!op) return cpPage(res, 400, 'Opción no válida', '<h1>Esa opción ya no está</h1><p class="sub">Vuelve atrás y elige otra.</p>');
    const open = db.orders.filter((o) => o.clientId === c.id && o.status === 'pending' && Date.now() - Date.parse(o.created) < 3600000);
    if (ctx.vendor) { const cost = costFor(ctx.vendor, months, scr); if (cost > ctx.vendor.credits && !ctx.vendor.allowNegative) { notifyUser(ctx.vendor, `⚠️ Tu cliente ${c.panelName} ha intentado pagar su renovación online, pero no tienes créditos suficientes (hacen falta ${cost}, tienes ${ctx.vendor.credits}). Recarga para que pueda pagar.`); return cpPage(res, 200, 'Pago no disponible', '<h1>Ahora mismo no se puede</h1><p class="sub">El pago online no está disponible en este momento. Inténtalo más tarde o habla con tu proveedor.</p>'); } }
    if (open.length >= 5) return cpPage(res, 429, 'Espera un poco', '<h1>Espera un momento</h1><p class="sub">Tienes varios pagos sin terminar. Prueba de nuevo en un rato.</p>');
    const o = { id: 'C' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase(), kind: 'client', clientId: c.id, vendorId: ctx.vendor ? ctx.vendor.id : null, userId: null, user: c.panelName, credits: 0, months, screens: scr, amount: op.price, currency: cur, method: 'stripe', status: 'pending', created: new Date().toISOString(), pack: `${months} ${months === 1 ? 'mes' : 'meses'} · ${scr} ${scr === 1 ? 'pantalla' : 'pantallas'}` };
    const base = siteBase() || panelBase(req), back = `${base}/pagar/${c.id}-${c.payKey}?o=${o.id}`;
    let ss;
    try {
      ss = await stripeCall('POST', '/v1/checkout/sessions', {
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': cur.toLowerCase(), 'line_items[0][price_data][unit_amount]': String(Math.round(op.price * 100)),
        'line_items[0][price_data][product_data][name]': `${String(ctx.cfg.desc || 'Suscripción').slice(0, 60)} · ${months} ${months === 1 ? 'mes' : 'meses'} · ${scr} ${scr === 1 ? 'pantalla' : 'pantallas'}`,
        client_reference_id: o.id, 'metadata[order]': o.id, 'metadata[client]': String(c.id), success_url: back, cancel_url: `${base}/pagar/${c.id}-${c.payKey}?cancelado=1`,
      }, ctx.key);
    } catch (e) { console.error('Cobro a clientes:', e.message); return cpPage(res, 502, 'Error', '<h1>No se pudo abrir el pago</h1><p class="sub">Inténtalo de nuevo en un momento. Si sigue fallando, avisa a tu proveedor.</p>'); }
    o.extId = ss.id; o.url = ss.url;
    await lock(async () => { db.orders.unshift(o); if (db.orders.length > 3000) db.orders.length = 3000; saveDb(); });
    res.writeHead(303, { Location: ss.url, 'Cache-Control': 'no-store' }); return res.end();
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const oid = q.get('o');
  if (oid) {
    const o = db.orders.find((x) => x.id === oid && x.clientId === c.id);
    if (o && o.status === 'pending' && o.extId) {
      try {
        const ss = await stripeCall('GET', `/v1/checkout/sessions/${encodeURIComponent(o.extId)}`, null, orderKey(o));
        if (ss.payment_status === 'paid' && ss.amount_total === Math.round(o.amount * 100) && String(ss.currency).toUpperCase() === o.currency) await lock(async () => { if (await cpPaid(o, 'comprobado al volver')) saveDb(); });
      } catch { /* se mira otra vez al recargar */ }
    }
    if (o && o.status === 'paid') return cpPage(res, 200, 'Pago recibido', `<div class="big">✅</div><h1 class="ok">¡Pago recibido!</h1><p class="sub">Gracias, ${H(c.panelName)}. Tu cuenta está renovada hasta el <b>${H(fmtD(c.expires))}</b>. No tienes que hacer nada más: sigue viendo como siempre.</p>`);
    if (o) return cpPage(res, 200, 'Comprobando', `<div class="big">⏳</div><h1>Comprobando tu pago…</h1><p class="sub">Puede tardar unos segundos. Si ya has pagado, esta página se actualizará sola.</p><meta http-equiv="refresh" content="4">`);
  }
  const left = diffDays(c.expires, today());
  const state = left < 0 ? `Tu cuenta venció el <b>${H(fmtD(c.expires))}</b>. Al pagar vuelve a funcionar al momento.` : left === 0 ? `Tu cuenta vence <b>hoy</b>. Al pagar se suma a tu fecha.` : `Tu cuenta vence el <b>${H(fmtD(c.expires))}</b> (en ${left} ${left === 1 ? 'día' : 'días'}). Lo que pagues se suma a esa fecha.`;
  const scrs = cpScreens(c, ctx), cur0 = c.screens || 1;
  let sel = Number(q.get('s')) || cur0; if (!scrs.includes(sel)) sel = scrs.includes(cur0) ? cur0 : scrs[0];
  const sopts = sel ? cpOptions(c, ctx, sel) : [];
  const best = sopts.length > 1 ? sopts.reduce((a, b) => (b.price / b.m < a.price / a.m ? b : a)) : null;
  const MT = { 1: '1 mes', 3: '3 meses', 6: '6 meses', 12: '1 año' };
  const tabs = scrs.length > 1 ? `<p class="lbl">¿Cuántas pantallas a la vez?</p><div class="tabs">${scrs.map((n) => `<a class="tab${n === sel ? ' on' : ''}" href="/pagar/${c.id}-${H(c.payKey)}?s=${n}"><b>${n}</b><small>${n === 1 ? 'pantalla' : 'pantallas'}${n === cur0 ? ' · la tuya' : ''}</small></a>`).join('')}</div>` : '';
  const change = sel && sel !== cur0 ? `<p class="note">Al pagar, tu cuenta pasa de ${cur0} a <b>${sel} ${sel === 1 ? 'pantalla' : 'pantallas'}</b>.</p>` : '';
  const list = sopts.length ? `<p class="lbl">¿Cuánto tiempo?</p><input type="hidden" name="s" value="${sel}">` + sopts.map((x) => `<button class="op${best && x === best && x.m > 1 ? ' best' : ''}" name="m" value="${x.m}"><span><b>${MT[x.m]}${best && x === best && x.m > 1 ? '<span class="tag">MEJOR PRECIO</span>' : ''}</b><small>${sel} ${sel === 1 ? 'pantalla' : 'pantallas'}${x.m > 1 ? ' · ' + money(x.price / x.m) + ' al mes' : ''}</small></span><span class="p">${money(x.price)}</span></button>`).join('')
    : '<p class="sub">Todavía no hay precios para tu plan. Habla con tu proveedor.</p>';
  return cpPage(res, 200, 'Renovar', `<h1>Hola, ${H(c.panelName)} 👋</h1><p class="sub">${state}</p>${q.get('cancelado') ? '<p class="sub" style="color:#fbbf24">No se ha cobrado nada. Puedes elegir otra vez cuando quieras.</p>' : ''}
    ${tabs}${change}<form method="post" action="/pagar/${c.id}-${H(c.payKey)}/checkout">${list}</form><p class="foot">🔒 Pago seguro con tarjeta, Apple Pay o Google Pay a través de Stripe.<br>Tu cuenta se renueva sola en cuanto se confirma el pago.</p>`);
}
/* Cobro a clientes de cada reseller o subreseller: sus precios y su propio Stripe */
const VEND_ROLES = ['reseller', 'sub'];
const myCp = (me) => (me.clientPay = { on: false, desc: 'Suscripción', prices: {}, key: '', whsec: '', ...(me.clientPay || {}) });
route('GET', '/api/my-client-pay', VEND_ROLES, ({ me, req }) => {
  const v = myCp(me);
  return { allowed: !!cpCfg().vendors, cfg: { on: v.on, desc: v.desc, prices: v.prices, hasKey: !!v.key, test: /^sk_test_/.test(v.key || ''), hasWh: !!v.whsec },
    webhook: `${siteBase() || panelBase(req)}/api/pay/stripe/webhook/u${me.id}`, cost: Object.fromEntries([1, 3, 6, 12].flatMap((m) => [1, 2, 4].map((sc) => [`${m}-${sc}`, costFor(me, m, sc)]))),
    orders: db.orders.filter((o) => o.kind === 'client' && o.vendorId === me.id).slice(0, 40).map((o) => ({ id: o.id, user: o.user, months: o.months, amount: o.amount, currency: o.currency, status: o.status, created: o.created, paidAt: o.paidAt || null, after: o.expiresAfter || '' })) };
});
route('PUT', '/api/my-client-pay', VEND_ROLES, async ({ me, body }) => {
  if (!cpCfg().vendors) throw new HttpError(403, 'El cobro a clientes todavía no está disponible para vendedores.');
  const v = myCp(me);
  const k = str(body.key, 200), w = str(body.whsec, 200);
  if (k) {
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(k)) throw new HttpError(400, 'La clave de Stripe debe empezar por sk_live_ (o sk_test_ para pruebas).');
    try { await stripeCall('GET', '/v1/balance', null, k); } catch (e) { throw new HttpError(400, 'Stripe no acepta esa clave: ' + e.message); }
  }
  return lock(async () => {
    if (k) v.key = k;
    if (w) { if (!/^whsec_[A-Za-z0-9]{10,}$/.test(w)) throw new HttpError(400, 'El secreto del webhook empieza por whsec_'); v.whsec = w; }
    if (body.removeKey) { v.key = ''; v.whsec = ''; v.on = false; }
    if (body.desc !== undefined) v.desc = str(body.desc, 60).trim() || 'Suscripción';
    if (body.prices && typeof body.prices === 'object') {
      const out = {};
      for (const m of [1, 3, 6, 12]) for (const sc of [1, 2, 3, 4]) { const x = Math.round(Number(String(body.prices[`${m}-${sc}`] || '').replace(',', '.')) * 100) / 100; if (x >= 0.5 && x <= 10000) out[`${m}-${sc}`] = x; }
      v.prices = out;
    }
    if (body.on !== undefined) { if (body.on && !v.key) throw new HttpError(400, 'Primero pega la clave secreta de tu Stripe.'); v.on = !!body.on; }
    addLog('ajustes', null, `${me.name}: cobro a sus clientes ${v.on ? 'activado' : 'desactivado'}`, me);
    saveDb();
    return { ok: true };
  });
});

route('PUT', '/api/client-pay', SUPER, ({ me, body }) => lock(async () => {
  const c = db.settings.clientPay;
  if (body.on !== undefined) { if (body.on && !(db.payCfg.stripe.on && db.payCfg.stripe.key)) throw new HttpError(400, 'Primero activa Stripe en Ajustes › Pagos online.'); c.on = !!body.on; }
  if (body.desc !== undefined) c.desc = str(body.desc, 60).trim() || 'Suscripción';
  if (body.vendors !== undefined) c.vendors = !!body.vendors;
  if (body.prices && typeof body.prices === 'object') {
    const out = {};
    for (const m of [1, 3, 6, 12]) for (const sc of [1, 2, 3, 4]) { const v = Math.round(Number(String(body.prices[`${m}-${sc}`] || '').replace(',', '.')) * 100) / 100; if (v >= 0.5 && v <= 10000) out[`${m}-${sc}`] = v; }
    c.prices = out;
  }
  addLog('ajustes', null, `Cobro a clientes: ${c.on ? 'activado' : 'desactivado'}${c.vendors ? ' · permitido a los vendedores' : ''}`, me);
  saveDb();
  return { ok: true, clientPay: c };
}));
route('GET', '/api/client-pay', SUPER, () => ({ cfg: cpCfg(), stripe: { on: !!(db.payCfg.stripe.on && db.payCfg.stripe.key), wh: !!db.payCfg.stripe.whsec }, base: siteBase(),
  orders: db.orders.filter((o) => o.kind === 'client').slice(0, 60).map((o) => ({ id: o.id, clientId: o.clientId, user: o.user, months: o.months, amount: o.amount, currency: o.currency, status: o.status, created: o.created, paidAt: o.paidAt || null, after: o.expiresAfter || '' })) }));

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
    alerts: { login: al.login !== false, credits: me.role === 'super' ? al.credits !== false : false, sabotage: me.role === 'super' ? al.sabotage !== false : al.sabotage === true, daily: me.role === 'super' ? al.daily !== false : al.daily === true, quality: me.role === 'super' ? al.quality !== false : al.quality === true, servers: me.role === 'super' ? al.servers !== false : al.servers === true, staffLogins: me.role === 'super' ? al.staffLogins !== false : false, vendorLogins: me.role === 'super' || me.role === 'reseller' ? al.vendorLogins !== false : al.vendorLogins === true, backup: me.role === 'super' ? al.backup !== false : false, payments: me.role === 'super' ? al.payments !== false : false },
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
  for (const k of ['login', 'servers', 'staffLogins', 'vendorLogins', 'backup', 'payments', 'quality', 'sabotage', 'daily', 'credits']) if (typeof body[k] === 'boolean') al[k] = body[k];
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
  await Promise.all(serversFor(me).map(async (s) => {
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
          user: x.UserName || '', client: c ? c.panelName : '', clientId: c ? c.id : null, demo: !!(c && c.demo), ownerId: c ? c.ownerId : null,
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
      // Jellyfin no lleva el prefijo /emby y la clave va en la cabecera Authorization
      const jf = s.kind === 'jellyfin';
      r = await fetch(`${s.url}${jf ? '' : '/emby'}/Items/${params.item}/Images/Primary?maxHeight=330&quality=80`, { headers: jf ? { Authorization: `MediaBrowser Client="Concha", Device="Panel", DeviceId="concha-panel", Version="1.0", Token="${s.apiKey || ''}"` } : { 'X-Emby-Token': s.apiKey }, signal: AbortSignal.timeout(15000) });
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
/* Avisos de «Atención» que se han descartado: vuelven a salir solo si aparece algo nuevo */
const attnSig = (a) => a.reasons.map((r) => r.k).sort().join(',');
const riskSig = (r) => r.reasons.join('|');
const attnHidden = (u, a) => { const h = (db.attnHide || {})[u.id]; return !!h && h.a === attnSig(a); };
const riskHidden = (u, r) => { const h = (db.attnHide || {})[u.id]; return !!h && h.r === riskSig(r); };
route('POST', '/api/team/clear', ['super', 'admin', 'reseller'], ({ me, body }) => lock(async () => {
  if (!db.attnHide || typeof db.attnHide !== 'object') db.attnHide = {};
  const vis = teamVisible(me), only = body.id ? Number(body.id) : 0, kind = body.kind || 'all';
  let n = 0;
  for (const u of vis) {
    if (only && u.id !== only) continue;
    const h = db.attnHide[u.id] || {};
    if (kind === 'all' || kind === 'attention') { const a = vendorAttention(u); if (a.reasons.length) { h.a = attnSig(a); n++; } }
    if (kind === 'all' || kind === 'risk') { const r = accessRisk(u); if (r.level !== 'no') { h.r = riskSig(r); n++; } }
    db.attnHide[u.id] = h;
  }
  if ((kind === 'all' || kind === 'incidents') && (me.role === 'super' || (me.role === 'admin' && can(me, 'resellers')))) {
    const ids = new Set(vis.map((u) => u.id)), before = db.incidents.length;
    db.incidents = db.incidents.filter((x) => !(ids.has(x.userId) && (!only || x.userId === only) && (!body.incident || x.id === body.incident)));
    n += before - db.incidents.length;
  }
  addLog('ajustes', null, `Atención del equipo: ${n} ${n === 1 ? 'aviso descartado' : 'avisos descartados'}`, me);
  saveDb();
  return { ok: true, cleared: n };
}));
route('GET', '/api/team', ['super', 'admin', 'reseller'], ({ me }) => {
  const team = teamVisible(me).filter((u) => !u.disabled);
  const attention = team.filter((u) => u.role !== 'admin').map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, ...vendorAttention(u) })).filter((x) => x.reasons.length && !attnHidden(x, x));
  const suspicious = team.map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, ...accessRisk(u) })).filter((x) => x.level !== 'no' && !riskHidden(x, x));
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
  return team.filter((u) => { if (u.role === 'admin') return false; const a = vendorAttention(u); return a.reasons.length && !attnHidden(u, a); }).length
    + team.filter((u) => { const r = accessRisk(u); return r.level !== 'no' && !riskHidden(u, r); }).length
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
   Gastos (solo superadministrador): calendario de pagos, contabilidad
   y avisos por Telegram antes del día de pago. No toca nada de Emby.
   ====================================================================== */
const EXP_CATS = ['servidor', 'contenido', 'dominio', 'software', 'otro'];
const EXP_EVERY = [0, 1, 3, 6, 12]; // 0 = una sola vez
function expCfg() { db.settings.expenses = { remind: 3, tg: true, ...(db.settings.expenses || {}) }; return db.settings.expenses; }
function expList() { if (!Array.isArray(db.expenses)) db.expenses = []; return db.expenses; }
function expFind(id) { const e = expList().find((x) => x.id === Number(id)); if (!e) throw new HttpError(404, 'Ese gasto ya no existe.'); return e; }
const r2 = (n) => Math.round(n * 100) / 100;
function expAmount(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, 'El importe no es válido.'); return r2(n); }
/** Siguiente fecha de pago respetando el día original (31 → 28/30 → vuelve a 31) */
function expNext(e, from) {
  const n = addMonths(from, e.every);
  const { y, m } = parts(n), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(e.day || parts(from).d, last))}`;
}
function expRead(body, e) {
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Ponle un nombre al gasto.');
  const due = String(body.due || '');
  if (!isDate(due)) throw new HttpError(400, 'Elige el día de pago.');
  const every = Number(body.every);
  if (!EXP_EVERY.includes(every)) throw new HttpError(400, 'Elige cada cuánto se paga.');
  const cat = EXP_CATS.includes(body.cat) ? body.cat : 'otro';
  return { ...(e || {}), name, amount: expAmount(body.amount), cat, every, due, day: parts(due).d, notes: str(body.notes, 300), method: str(body.method, 30) };
}
/** Lo ingresado en un mes: créditos vendidos a vendedores (misma cuenta que el Informe de ingresos) */
function incomeByMonth(months) {
  const out = Object.fromEntries(months.map((m) => [m, 0]));
  const staffIds = new Set(db.users.filter((u) => isStaff(u)).map((u) => u.id));
  const price = (u) => (u && u.creditPrice) || db.settings.creditPrice || 0;
  for (const l of db.ledger) {
    const m = localDate(new Date(l.ts)).slice(0, 7);
    if (!(m in out) || l.kind !== 'credito' || !(l.delta > 0) || !(l.byId == null || staffIds.has(l.byId))) continue;
    const u = db.users.find((x) => x.id === l.userId);
    if (!u || isStaff(u)) continue;
    out[m] += l.paid ? l.paid.amount : l.delta * price(u);
  }
  for (const m of months) out[m] = r2(out[m]);
  return out;
}
function expView() {
  const t = today(), cfg = expCfg(), list = expList();
  const months = []; for (let i = 11; i >= 0; i--) months.push(addMonths(t.slice(0, 7) + '-01', -i).slice(0, 7));
  const paid = Object.fromEntries(months.map((m) => [m, 0]));
  const year = t.slice(0, 4), byCat = {};
  let yearTotal = 0;
  for (const e of list) for (const p of e.payments || []) {
    const m = p.at.slice(0, 7);
    if (m in paid) paid[m] += p.amount;
    if (p.at.slice(0, 4) === year) { yearTotal += p.amount; byCat[e.cat] = (byCat[e.cat] || 0) + p.amount; }
  }
  const inc = incomeByMonth(months);
  return {
    today: t, remind: cfg.remind, tg: cfg.tg !== false, currency: db.settings.currency || 'EUR',
    bot: !!db.settings.notices.telegram.token, cats: EXP_CATS,
    list: list.map((e) => ({ ...e, left: e.done ? null : diffDays(e.due, t) })),
    months: months.map((m) => ({ m, paid: r2(paid[m]), income: inc[m] })),
    year: { y: year, total: r2(yearTotal), byCat: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, r2(v)])) },
  };
}
const expDueCount = () => { const t = today(), d = expCfg().remind || 0; return expList().filter((e) => !e.done && diffDays(e.due, t) <= Math.max(d, 0)).length; };

route('GET', '/api/expenses', SUPER, () => expView());
route('POST', '/api/expenses', SUPER, ({ me, body }) => lock(async () => {
  const e = { id: newId(), ...expRead(body), payments: [], done: false, sent: {}, createdAt: today() };
  expList().push(e);
  addLog('ajustes', null, `Gasto apuntado: ${e.name} (${money2(e.amount)})`, me);
  saveDb();
  return { ok: true, expense: e };
}));
route('PUT', '/api/expenses/cfg', SUPER, ({ body }) => lock(async () => {
  const cfg = expCfg(), d = Number(body.remind);
  if (![0, 1, 2, 3, 5, 7].includes(d)) throw new HttpError(400, 'Elige con cuántos días de antelación avisar.');
  cfg.remind = d; cfg.tg = !!body.tg;
  saveDb();
  return { ok: true };
}));
route('PUT', '/api/expenses/:id', SUPER, ({ me, params, body }) => lock(async () => {
  const e = expFind(params.id), before = e.due;
  Object.assign(e, expRead(body, e));
  if (e.due !== before) { e.sent = {}; if (e.done) e.done = false; }
  addLog('ajustes', null, `Gasto cambiado: ${e.name}`, me);
  saveDb();
  return { ok: true, expense: e };
}));
route('POST', '/api/expenses/:id/pay', SUPER, ({ me, params, body }) => lock(async () => {
  const e = expFind(params.id);
  if (e.done) throw new HttpError(400, 'Este gasto ya está pagado.');
  const at = isDate(body.at) ? body.at : today();
  const amount = body.amount == null || body.amount === '' ? e.amount : expAmount(body.amount);
  e.payments = e.payments || [];
  e.payments.push({ due: e.due, at, amount, method: str(body.method, 30) || e.method || '', ts: new Date().toISOString() });
  if (e.payments.length > 240) e.payments = e.payments.slice(-240);
  if (e.every) e.due = expNext(e, e.due); else e.done = true;
  e.sent = {};
  addLog('ajustes', null, `Gasto pagado: ${e.name} (${money2(amount)})`, me);
  saveDb();
  return { ok: true, expense: e };
}));
route('POST', '/api/expenses/:id/unpay', SUPER, ({ me, params }) => lock(async () => {
  const e = expFind(params.id), p = (e.payments || []).pop();
  if (!p) throw new HttpError(400, 'Este gasto no tiene pagos que deshacer.');
  e.due = p.due; e.done = false; e.sent = {};
  addLog('ajustes', null, `Pago deshecho: ${e.name}`, me);
  saveDb();
  return { ok: true, expense: e };
}));
route('DELETE', '/api/expenses/:id', SUPER, ({ me, params }) => lock(async () => {
  const e = expFind(params.id);
  db.expenses = expList().filter((x) => x !== e);
  addLog('ajustes', null, `Gasto borrado: ${e.name}`, me);
  saveDb();
  return { ok: true };
}));
/** Una vez al día (desde las 9:00): avisa por Telegram de los pagos que se acercan, de los de hoy y de los atrasados */
let expLastDay = null;
function expDaily() {
  const cfg = expCfg(), t = today();
  if (cfg.tg === false || expLastDay === t) return;
  const h = Number(new Date().toLocaleString('en-GB', { timeZone: process.env.TZ || 'Europe/Madrid', hour: '2-digit', hour12: false }));
  if (!process.env.DAILY_ANYTIME && h < 9) return;
  expLastDay = t;
  const soon = [], now = [], late = [];
  for (const e of expList()) {
    if (e.done) continue;
    const left = diffDays(e.due, t); e.sent = e.sent || {};
    if (left < 0 && e.sent.late !== e.due) { late.push(e); e.sent.late = e.due; }
    else if (left === 0 && e.sent.day !== e.due) { now.push(e); e.sent.day = e.due; }
    else if (left > 0 && cfg.remind > 0 && left <= cfg.remind && e.sent.before !== e.due) { soon.push(e); e.sent.before = e.due; }
  }
  if (!soon.length && !now.length && !late.length) return;
  const line = (e, extra) => `• ${e.name}: ${money2(e.amount)}${extra ? ' · ' + extra : ''}`;
  const fd = (s) => { const { d, m } = parts(s); return `${d}/${pad(m)}`; };
  const out = ['🧾 Gastos del panel', ''];
  if (late.length) out.push('🔴 Sin pagar, se pasó la fecha:', ...late.map((e) => line(e, 'era el ' + fd(e.due))), '');
  if (now.length) out.push('🟠 Hoy toca pagar:', ...now.map((e) => line(e)), '');
  if (soon.length) out.push('🗓️ Próximos pagos:', ...soon.map((e) => line(e, `el ${fd(e.due)} (${diffDays(e.due, t) === 1 ? 'mañana' : 'en ' + diffDays(e.due, t) + ' días'})`)), '');
  out.push('Márcalos como pagados en Panel › Gastos.');
  for (const u of db.users) if (u.role === 'super' && !u.disabled) notifyUser(u, out.join('\n'));
  lock(async () => saveDb()).catch(() => {});
}


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
    const raw0 = fs.readFileSync(INDEX_FILE);
    // Huella de esta versión de la pantalla: si el navegador tiene una copia vieja guardada, se da cuenta y se recarga solo
    const ver = crypto.createHash('sha1').update(raw0).digest('hex').slice(0, 12);
    const raw = Buffer.from(raw0.toString('utf8').replace("'__UI_VER__'", `'${ver}'`), 'utf8');
    indexCache = { mtime, raw, gz: zlib.gzipSync(raw, { level: 9 }), ver };
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
  if (L.disk >= 90) agentAlert(s, d, 'disk', `💾 El disco del servidor «${s.name}» está al ${L.disk}%. Si se llena, ${srvKind(s)} puede dejar de funcionar.`, 6 * 3600e3);
  if (recent.length === 5 && recent.every((x) => x.cpu >= 90)) agentAlert(s, d, 'cpu', `🔥 El procesador de «${s.name}» lleva 5 minutos por encima del 90%. Puede que haya demasiadas conversiones de vídeo a la vez.`);
  if (recent.length === 5 && recent.every((x) => x.mem >= 92)) agentAlert(s, d, 'mem', `🧠 La memoria de «${s.name}» lleva 5 minutos por encima del 92%.`);
  // El agente busca Emby y también Jellyfin (desde su versión 4); los agentes viejos solo sabían buscar Emby
  if (!L.emby && d.prevEmby !== false && !(s.kind === 'jellyfin' && Number(L.ver) < 4)) agentAlert(s, d, 'emby', `⚠️ En «${s.name}» no se encuentra ${srvKind(s)} funcionando. Revisa el servidor.`, 3600e3);
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
  if pgrep -f -i 'EmbyServer|emby-server|embyserver|jellyfin' >/dev/null 2>&1; then EMBY=true; else EMBY=false; fi
  set -- $MEM
  JSON="{\"cpu\":$CPU,\"mem\":$1,\"memTotal\":$2,\"load\":$LOAD,\"cores\":$CORES,\"up\":$UP,\"down\":$DOWN,\"uptime\":$UPT,\"emby\":$EMBY,\"disks\":[$DISKS],\"host\":\"$HOST\",\"os\":\"$OS\",\"ver\":\"4\"}"
  RESP=$(curl -fsS -m 20 -X POST -H 'Content-Type: application/json' -H "X-Agent-Token: $TOKEN" --data "$JSON" "$PANEL/api/agent/report" 2>/dev/null || true)
  # Única orden que acepta: reiniciar la máquina, pedida por el superadministrador desde el panel
  case "$RESP" in
    *'"cmd":"reboot"'*) logger -t panel-agente "Reinicio del VPS pedido desde el panel"; sleep 3; systemctl reboot ;;
    *'"cmd":"restart-emby"'*) logger -t panel-agente "Reinicio de Emby pedido desde el panel"
      if systemctl list-units --all --type=service 2>/dev/null | grep -q 'emby-server'; then systemctl restart emby-server
      elif systemctl list-units --all --type=service 2>/dev/null | grep -q 'jellyfin'; then systemctl restart jellyfin
      elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qiE 'emby|jellyfin'; then docker restart $(docker ps -a --format '{{.Names}}' | grep -iE 'emby|jellyfin' | head -n1)
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
  return { ...rest, platforms: kindsClean(l.platforms).length ? kindsClean(l.platforms) : KINDS_ALL, left, state, online: !!l.lastCheck && Date.now() - Date.parse(l.lastCheck) < 3 * 3600e3 };
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
  if (body.platforms !== undefined) { const k = kindsClean(body.platforms); if (!k.length) throw new HttpError(400, 'Elige Emby, Jellyfin o los dos.'); l.platforms = k; }
  if (body.until !== undefined) { const d = str(body.until, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'La fecha no es válida.'); l.until = d; }
}
route('GET', '/api/licenses', SUPER, () => { licGuard(); return { list: db.licenses.map(licView), contact: db.settings.licContact, grace: LIC_GRACE, today: today() }; });
route('POST', '/api/licenses', SUPER, ({ me, body }) => lock(async () => {
  licGuard();
  const months = Math.round(Number(body.months));
  if (!(months >= 0 && months <= 36)) throw new HttpError(400, 'Los meses no son válidos.');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start || '')) ? body.start : today();
  const token = licToken(), id = (db.licenses.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  const l = { id, name: '', url: '', contact: '', notes: '', price: 0, platforms: ['emby'], start, until: months ? addMonths(start, months) : addDays(start, 0), blocked: false, payments: [], createdAt: new Date().toISOString(), tokenHash: licHash(token) };
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
/** Resumen (solo números y nombres de servidores, sin datos de clientes) que un panel alquilado manda al principal */
function licStatsOut() {
  const live = db.clients.filter((c) => c.status !== 'trash');
  const kind = (s) => (s.kind === 'jellyfin' ? 'jellyfin' : 'emby');
  return {
    servers: db.servers.slice(0, 30).map((s) => ({ name: String(s.name || '').slice(0, 40), kind: kind(s), off: !!s.off })),
    active: live.filter((c) => !c.demo && c.status === 'active').length,
    expired: live.filter((c) => !c.demo && c.status !== 'active').length,
    demos: live.filter((c) => c.demo && c.status === 'active').length,
    vendors: db.users.filter((u) => u.role === 'reseller' || u.role === 'sub').length,
    admins: db.users.filter((u) => u.role === 'admin').length,
    newMonth: db.log.filter((l) => l.type === 'alta' && String(l.ts).slice(0, 7) === today().slice(0, 7)).length,
  };
}
function licStatsIn(x) {
  if (!x || typeof x !== 'object') return null;
  const n = (v) => Math.max(0, Math.min(1e6, Math.round(Number(v) || 0)));
  return {
    servers: (Array.isArray(x.servers) ? x.servers : []).slice(0, 30).map((s) => ({ name: str(String((s && s.name) || ''), 40), kind: s && s.kind === 'jellyfin' ? 'jellyfin' : 'emby', off: !!(s && s.off) })),
    active: n(x.active), expired: n(x.expired), demos: n(x.demos), vendors: n(x.vendors), admins: n(x.admins), newMonth: n(x.newMonth), at: new Date().toISOString(),
  };
}
route('POST', '/api/license/check', null, ({ req, body }) => {
  const ip = clientIp(req);
  if (LIC_CLIENT) throw new HttpError(404, 'No encontrado.');
  if (ipBlocked(ip)) throw new HttpError(429, 'Demasiados intentos. Espera un rato.');
  const tk = String(req.headers['x-license-token'] || '');
  const l = tk.length > 10 && tk.length < 100 ? db.licenses.find((x) => x.tokenHash === licHash(tk)) : null;
  if (!l) { ipFail(ip); throw new HttpError(404, 'Clave de licencia no válida.'); }
  const first = !l.lastCheck;
  l.lastCheck = new Date().toISOString(); l.lastIp = ip.slice(0, 45);
  const st = licStatsIn(body && body.stats); if (st) l.stats = st;
  if (first || !l._saved || Date.now() - l._saved > 3600e3) { l._saved = Date.now(); saveDb(); }
  return { ok: true, name: l.name, until: l.until, blocked: !!l.blocked, platforms: kindsClean(l.platforms).length ? kindsClean(l.platforms) : KINDS_ALL, grace: LIC_GRACE, contact: db.settings.licContact || '', today: today() };
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
  const base = { contact: st.contact || '', until: st.until || null, lastOk: st.lastOk || null, kinds: licKinds() };
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
    const r = await fetch(LIC_SERVER + '/api/license/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-License-Token': LIC_TOKEN }, body: JSON.stringify({ stats: licStatsOut() }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    const before = licStatus();
    if (r.ok && j.ok && /^\d{4}-\d{2}-\d{2}$/.test(String(j.until))) {
      if (kindsClean(j.platforms).length) db.licState.platforms = kindsClean(j.platforms);
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

/* ======================================================================
   App propia para los clientes (el .apk): se sube en Ajustes › App de clientes y se descarga en /app.
   El archivo se guarda aparte (data/app/app.apk), no dentro de la base de datos ni de las copias.
   ====================================================================== */
const appCfg = () => db.settings.app || APP_DEF;
const appLink = () => `${(db.settings.brand.url || appCfg().base || '').replace(/\/+$/, '')}/app`;
/** ¿Esta sesión de Emby/Jellyfin es de nuestra app? (por el nombre que manda la app) */
function isMyApp(client) {
  const want = String(appCfg().client || appCfg().name || '').trim().toLowerCase();
  return !!want && String(client || '').trim().toLowerCase().includes(want);
}
/* Lee el nombre del paquete y la versión del .apk sin programas externos: el .apk es un zip y dentro está
   AndroidManifest.xml en formato binario de Android */
function apkInfo(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no es un zip');
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  let man = null;
  for (let k = 0; k < n && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (name === 'AndroidManifest.xml') {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
      man = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data); break;
    }
    p += 46 + nl + el + cl;
  }
  if (!man || man.readUInt16LE(0) !== 0x0003) throw new Error('sin AndroidManifest');
  let strs = [], o = 8;
  const out = {};
  while (o + 8 <= man.length) {
    const type = man.readUInt16LE(o), hsz = man.readUInt16LE(o + 2), size = man.readUInt32LE(o + 4);
    if (!size) break;
    if (type === 0x0001) {
      const cnt = man.readUInt32LE(o + 8), utf8 = !!(man.readUInt32LE(o + 16) & 0x100), sstart = o + man.readUInt32LE(o + 20);
      strs = [];
      for (let i = 0; i < cnt; i++) {
        let q = sstart + man.readUInt32LE(o + hsz + i * 4);
        if (utf8) { let l = man[q++]; if (l & 0x80) q++; l = man[q++]; if (l & 0x80) l = ((l & 0x7f) << 8) | man[q++]; strs.push(man.toString('utf8', q, q + l)); }
        else { let l = man.readUInt16LE(q); q += 2; if (l & 0x8000) { l = ((l & 0x7fff) << 16) | man.readUInt16LE(q); q += 2; } strs.push(man.toString('utf16le', q, q + l * 2)); }
      }
    } else if (type === 0x0102) {
      const ext = o + 16, el = strs[man.readUInt32LE(ext + 4)], aStart = man.readUInt16LE(ext + 8), aSize = man.readUInt16LE(ext + 10), aCount = man.readUInt16LE(ext + 12);
      if (el === 'manifest') {
        for (let i = 0; i < aCount; i++) {
          const a = ext + aStart + i * aSize, an = strs[man.readUInt32LE(a + 4)], raw = man.readInt32LE(a + 8), dt = man[a + 15], data = man.readUInt32LE(a + 16);
          const val = raw >= 0 ? strs[raw] : dt === 0x03 ? strs[data] : data;
          if (an === 'package' || an === 'versionName' || an === 'versionCode') out[an] = val;
        }
        break;
      }
    }
    o += size;
  }
  return { pkg: String(out.package || ''), version: String(out.versionName || ''), code: Number(out.versionCode) || 0 };
}
const canApp = (me) => me && me.role === 'super';
/** Subida del .apk: llega tal cual (no en JSON) y se guarda por trozos, sin cargarlo entero en memoria */
async function appUpload(req, res) {
  const me = currentUser(req);
  if (!me) return send(res, 401, { error: 'Inicia sesión.' });
  if (!canApp(me)) return send(res, 403, { error: 'Solo el superadministrador puede subir la app.' });
  if (req.headers['x-app-upload'] !== '1') return send(res, 400, { error: 'Subida no válida.' });
  const len = Number(req.headers['content-length'] || 0);
  if (len > APP_MAX) return send(res, 413, { error: 'El archivo es demasiado grande (máximo 400 MB).' });
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = path.join(APP_DIR, `subida-${Date.now()}.tmp`);
  try {
    await new Promise((resolve, reject) => {
      let size = 0; const ws = fs.createWriteStream(tmp);
      req.on('data', (ch) => { size += ch.length; if (size > APP_MAX) { reject(new HttpError(413, 'El archivo es demasiado grande (máximo 400 MB).')); req.destroy(); } });
      req.on('error', reject); req.on('aborted', () => reject(new HttpError(400, 'La subida se cortó. Vuelve a intentarlo.')));
      ws.on('error', reject); ws.on('finish', resolve);
      req.pipe(ws);
    });
    let info;
    try { info = apkInfo(tmp); } catch { throw new HttpError(400, 'Ese archivo no parece una app de Android (.apk).'); }
    const st = fs.statSync(tmp);
    const r = await lock(async () => {
      const a = db.settings.app, before = a.version;
      fs.renameSync(tmp, APP_APK);
      Object.assign(a, { pkg: info.pkg, version: info.version, code: info.code, size: st.size, at: new Date().toISOString(), file: true });
      const base = String(req.headers['x-base'] || ''); if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(base)) a.base = base;
      const fname = String(req.headers['x-file-name'] || '').replace(/[^\w.\- ]/g, '').slice(0, 80);
      a.history = [{ version: info.version, code: info.code, at: a.at, by: me.name || me.username, size: st.size, file: fname }, ...(a.history || [])].slice(0, 15);
      addLog('ajustes', null, `App de clientes subida: ${a.name} ${info.version || ''}${before && before !== info.version ? ` (antes ${before})` : ''}`, me);
      saveDb();
      return { ok: true, app: a, newer: !!before && before !== info.version };
    });
    return send(res, 200, r);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ya no está */ }
    return send(res, e.status || 500, { error: e.status ? e.message : 'No se pudo guardar el archivo.' });
  }
}
let appDlDirty = 0;
/** Descarga pública: /app (y /app/loquesea.apk). Admite descargas por partes (Downloader de Fire Stick) */
function appDownload(req, res, pathname) {
  if (pathname === '/app/version.json') {
    const a = appCfg();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ name: a.name, version: a.version, code: a.code, package: a.pkg, size: a.size, date: a.at, url: '/app' }));
  }
  const a = appCfg();
  if (!a.file || !fs.existsSync(APP_APK)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1a23;color:#e9f1f4;font-family:system-ui,sans-serif;text-align:center;padding:24px"><div><div style="font-size:48px">📲</div><h1 style="font-size:20px">La app todavía no está disponible</h1><p style="color:#8fa9b5">Pídele el enlace a tu proveedor.</p></div>');
  }
  const size = fs.statSync(APP_APK).size;
  const fname = `${String(a.name || 'app').replace(/[^\w.-]+/g, '-')}${a.version ? '-' + String(a.version).replace(/[^\w.-]+/g, '') : ''}.apk`;
  const head = { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': `attachment; filename="${fname}"`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let from = 0, to = size - 1, code = 200;
  if (m) {
    from = m[1] === '' ? Math.max(0, size - Number(m[2] || 0)) : Number(m[1]); to = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (from > to || from >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206; head['Content-Range'] = `bytes ${from}-${to}/${size}`;
  }
  head['Content-Length'] = to - from + 1;
  res.writeHead(code, head);
  if (req.method === 'HEAD') return res.end();
  if (from === 0) { a.downloads = (a.downloads || 0) + 1; if (++appDlDirty >= 1) { appDlDirty = 0; lock(async () => saveDb()).catch(() => {}); } }
  fs.createReadStream(APP_APK, { start: from, end: to }).pipe(res);
}
/* «Solo mi app»: si un cliente del panel reproduce con otra app, se corta y se le dice cuál usar.
   Se activa y desactiva en Ajustes › App de clientes. Los aparatos de Apple pueden quedar permitidos (la app es solo para Android) */
const APPLE_RE = /iphone|ipad|ipod|apple ?tv|tvos|\bios\b|for ios|infuse|swiftfin|macos|mac os|safari/i;
const appWarned = new Map(); // "servidor:sesión" -> momento del último aviso
async function appOnlyCheck(s, list, byEmby) {
  const a = appCfg(), o = a.only || {};
  if (!o.on || !(a.client || a.name)) return;
  const allow = String(o.allow || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const now = Date.now();
  for (const x of list) {
    if (!x || !x.NowPlayingItem) continue;
    const c = byEmby.get(x.UserId);
    if (!c || c.appFree) continue; // solo cuentas del panel; las marcadas como libres no se tocan
    const cl = String(x.Client || ''), all = `${cl} ${x.DeviceName || ''}`;
    if (isMyApp(cl)) continue;
    if (o.apple !== false && APPLE_RE.test(all)) continue;
    if (allow.some((w) => all.toLowerCase().includes(w))) continue;
    const key = s.id + ':' + x.Id;
    if (now - (appWarned.get(key) || 0) < 50000) continue;
    appWarned.set(key, now);
    const text = String(o.message || APP_DEF.only.message).replace(/\{app\}/g, a.name || 'oficial').replace(/\{link\}/g, appLink()).replace(/\{nombre\}/g, c.panelName || '');
    try {
      await stopSession(s, x, text);
      await lock(async () => { addLog('monitor', c, `Reproducción cortada: usaba otra app (${cl || 'desconocida'} en ${x.DeviceName || 'un aparato'})`, null); saveDb(); });
    } catch (e) { console.error('Solo mi app:', e.message); }
  }
  if (appWarned.size > 2000) for (const [k, t] of appWarned) if (now - t > 3600000) appWarned.delete(k);
}
route('PUT', '/api/app-settings', SUPER, ({ me, body }) => lock(async () => {
  const a = db.settings.app, o = body.only || {};
  const name = str(body.name, 40).trim(), client = str(body.client, 60).trim();
  if (body.name !== undefined) a.name = name || 'SERVICLUB';
  if (body.client !== undefined) a.client = client || a.name;
  if (body.inMsg !== undefined) a.inMsg = !!body.inMsg;
  if (body.tag !== undefined) a.tag = !!body.tag;
  if (body.public !== undefined) a.public = !!body.public;
  if (body.dlCode !== undefined) a.dlCode = String(body.dlCode || '').replace(/\D/g, '').slice(0, 12);
  if (typeof body.base === 'string' && /^https?:\/\/[\w.-]+(:\d+)?$/.test(body.base)) a.base = body.base;
  if (o.on !== undefined) a.only.on = !!o.on;
  if (o.apple !== undefined) a.only.apple = !!o.apple;
  if (o.allow !== undefined) a.only.allow = str(o.allow, 300);
  if (o.message !== undefined) a.only.message = str(o.message, 400).trim() || APP_DEF.only.message;
  addLog('ajustes', null, `App de clientes: ${body.public !== undefined ? (a.public ? 'visible para el equipo' : 'oculta para el equipo') : o.on !== undefined ? (a.only.on ? '«Solo mi app» activado' : '«Solo mi app» desactivado') : 'ajustes cambiados'}`, me);
  saveDb();
  return { ok: true, app: a };
}));
route('POST', '/api/app-delete', SUPER, ({ me }) => lock(async () => {
  try { fs.unlinkSync(APP_APK); } catch { /* no estaba */ }
  Object.assign(db.settings.app, { file: false, size: 0 });
  db.settings.app.only.on = false; // sin app para descargar, no tiene sentido obligar a usarla
  addLog('ajustes', null, 'App de clientes quitada del panel', me);
  saveDb();
  return { ok: true };
}));
route('POST', '/api/clients/:id/app-free', '*', ({ me, params, body }) => lock(async () => {
  const c = clientFor(me, params.id);
  if (body.free) c.appFree = true; else delete c.appFree;
  addLog('edicion', c, body.free ? 'Puede usar cualquier app' : 'Debe usar la app oficial', me);
  saveDb();
  return { ok: true };
}));

/* ======================================================================
   App para el móvil (se instala desde el navegador): iconos, manifiesto y service worker
   ====================================================================== */
const APP_ICONS = {
  '/icon-192.png': Buffer.from('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', 'base64'),
  '/icon-512.png': Buffer.from('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', 'base64'),
  '/icon-maskable.png': Buffer.from('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', 'base64'),
  '/apple-touch-icon.png': Buffer.from('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', 'base64'),
};
function appManifest() {
  const b = db.settings.brand || {}, name = (b.name || 'Panel').slice(0, 40);
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#0b1a23';
  return JSON.stringify({
    name, short_name: name.slice(0, 12), description: 'Gestión de cuentas', lang: 'es', dir: 'ltr',
    start_url: '/?app=1', scope: '/', id: '/', display: 'standalone', orientation: 'any',
    background_color: '#0b1a23', theme_color: color,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}
// Sin guardar nada en caché: siempre la versión nueva del panel. Si no hay internet, una página sencilla que lo explica
const APP_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1a23;color:#e9f1f4;font-family:system-ui,sans-serif;text-align:center;padding:24px"><div><div style="font-size:52px">📡</div><h1 style="font-size:20px">Sin conexión</h1><p style="color:#8fa9b5">Revisa el wifi o los datos y vuelve a intentarlo.</p><button onclick="location.reload()" style="margin-top:10px;padding:12px 22px;border:0;border-radius:14px;color:#fff;font-weight:700;font-size:15px;background:linear-gradient(90deg,#0ea5e9,#8b5cf6,#ec4899)">Reintentar</button></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});`;
function appFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (APP_ICONS[pathname]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : APP_ICONS[pathname]); return true; }
  if (pathname === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : appManifest()); return true; }
  if (pathname === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : APP_SW); return true; }
  return false;
}

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
    if (appFile(req, res, pathname)) return;
    if (pathname.startsWith('/pagar/') && (req.method === 'GET' || req.method === 'POST')) return await cpRoute(req, res, pathname);
    if (req.method === 'POST' && pathname === '/api/app-upload') return await appUpload(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/app(\/|\.apk$|$)/.test(pathname) && (pathname === '/app' || pathname === '/app/' || pathname === '/app.apk' || pathname === '/app/version.json' || /^\/app\/[\w.-]+\.apk$/.test(pathname))) return appDownload(req, res, pathname);
    if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'No encontrado.' });
    if (req.method === 'POST' && (pathname === '/api/pay/stripe/webhook' || /^\/api\/pay\/stripe\/webhook\/u\d+$/.test(pathname) || pathname === '/api/pay/nowpayments/ipn')) return await payWebhook(req, res, pathname);
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
loadSessions();
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
server.requestTimeout = 30 * 60000; // subir la app (.apk) desde una conexión lenta puede tardar varios minutos
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Panel de cuentas Emby en marcha');
  console.log(`  Abre en el navegador:  http://localhost:${PORT}`);
  console.log('  Deja esta ventana abierta. Para parar el panel, cierrala.');
  console.log('');
  const live = () => !licLocked(); // en pausa el panel no toca nada de Emby: las cuentas se quedan como estaban
  setTimeout(() => { if (live()) jfMarginOnce().catch((e) => console.error('Margen Jellyfin:', e.message)); }, 60000);
  const guardLoop = () => { (live() ? libGuard() : Promise.resolve()).catch((e) => console.error('Guardián de bibliotecas:', e.message)).finally(() => setTimeout(guardLoop, Number(process.env.GUARD_MS) || 15 * 60000)); };
  setTimeout(guardLoop, Number(process.env.GUARD_FIRST_MS) || 3 * 60000);
  if (live()) runLifecycle();
  let ticks = 0;
  setInterval(() => { if (++ticks % 60 === 0) { backupDb(); lock(async () => pruneRecords()).catch(() => {}); } if (live()) runLifecycle(); }, CHECK_EVERY_MS);
  if (LIC_CLIENT) { const lLoop = () => { licCheck().finally(() => { const s = licStatus(); setTimeout(lLoop, Number(process.env.LICENSE_MS) || (s && s.state !== 'ok' ? 5 * 60000 : 3600e3)); }); }; setTimeout(lLoop, 2000); }
  // Al apagar (Redeploy en Coolify) se guarda lo pendiente del historial de conexiones
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { saveSessions(true); } catch { /* nada */ } try { saveConn(true); } catch { /* nada */ } try { saveAgents(true); } catch { /* nada */ } process.exit(0); });
  const dLoop = () => { try { licDaily(); } catch (e) { console.error('Licencias:', e.message); } if (live()) try { vpayDaily(); } catch (e) { console.error('Cobros:', e.message); } if (live()) try { dailySummary(); } catch (e) { console.error('Resumen diario:', e.message); } try { expDaily(); } catch (e) { console.error('Gastos:', e.message); } setTimeout(dLoop, Number(process.env.DAILY_MS) || 60000); };
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
  const watchLoop = () => { (live() ? watchServers() : Promise.resolve()).catch((e) => console.error('Vigilancia de servidores:', e.message)).finally(() => setTimeout(watchLoop, Number(process.env.WATCH_MS) || 60000)); };
  setTimeout(watchLoop, 5000);
  setInterval(() => live() && telegramPoll(), Number(process.env.TG_POLL_MS) || 5000); // mensajes que llegan al bot de Telegram
});
