// MyVloggingStudio — desktop shell
// Serves the editor and local media through a private app:// origin (so the canvas can read video frames),
// converts footage browsers can't decode (HEVC, 10-bit, D-Log, odd audio) to an H.264 editing copy,
// and exports frame by frame through FFmpeg so 2K/4K never drop frames.

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const unpack = p => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const FFMPEG = unpack(require('ffmpeg-static'));
const FFPROBE = unpack(require('ffprobe-static').path);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};

function serveFile(file, req) {
  let st;
  try { st = fs.statSync(file); if (!st.isFile()) throw 0; } catch { return new Response('No encontrado', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const size = st.size;
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200, headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) }
  });
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 640,
    backgroundColor: '#0d0f14', title: 'MyVloggingStudio', icon: path.join(__dirname, 'ui', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadURL('app://local/index.html');
  // if the editor page crashes (for example, out of memory), stop FFmpeg, note why and reopen it;
  // the page then offers the automatic copy of the project
  win.webContents.on('render-process-gone', (_e, d) => {
    logCrash('render-process-gone ' + JSON.stringify(d));
    killChildren();
    if (d.reason === 'clean-exit') return;
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.loadURL('app://local/index.html?recuperar=1'); } catch {} }, 800);
  });
  win.webContents.on('unresponsive', () => logCrash('unresponsive'));
  // external preview window (second monitor)
  const extDisplay = () => { const cur = screen.getDisplayMatching(win.getBounds()); return screen.getAllDisplays().find(d => d.id !== cur.id) || null; };
  win.webContents.setWindowOpenHandler(({ frameName }) => {
    if (frameName !== 'tijera-preview') return { action: 'deny' };
    const ext = extDisplay();
    const b = ext ? ext.bounds : { width: 1280, height: 760 };
    return { action: 'allow', overrideBrowserWindowOptions: {
      ...(ext ? { x: b.x, y: b.y } : {}), width: b.width, height: b.height, frame: !ext, fullscreen: !!ext,
      backgroundColor: '#000000', autoHideMenuBar: true, title: 'MyVloggingStudio · Vista previa', webPreferences: { backgroundThrottling: false } } };
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName !== 'tijera-preview') return;
    child.setMenuBarVisibility(false);
    const ext = extDisplay();
    if (ext) { child.setBounds(ext.bounds); child.setFullScreen(true); }
  });
  win.on('closed', () => app.quit());
  win.on('close', e => {
    // if the editor page has crashed it cannot answer, so let the window close
    if (win.__dirtyChecked || win.webContents.isCrashed()) return;
    e.preventDefault();
    win.webContents.send('want-close');
  });
}

// keep using the old data folder (converted copies, settings) after the rename
try { const old = path.join(app.getPath('appData'), 'Tijera Studio'); if (fs.existsSync(old)) app.setPath('userData', old); } catch (e) {}

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    if (u.pathname === '/media') return serveFile(u.searchParams.get('p') || '', req);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(__dirname, 'ui', rel));
    if (!file.startsWith(path.join(__dirname, 'ui'))) return new Response('No', { status: 403 });
    return serveFile(file, req);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu', label: 'Edición' },
    { label: 'Ver', submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] }
  ]));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
// never leave FFmpeg running in the background after the app closes
function killChildren() {
  const kill = p => { try { p && p.kill('SIGKILL'); } catch {} };
  if (job) { kill(job.p); job = null; }
  for (const r of readers.values()) kill(r.p);
  for (const r of grays.values()) kill(r.p);
  readers.clear(); grays.clear();
}
app.on('will-quit', () => {
  killChildren();
  for (const p of procs.values()) { try { p.kill('SIGKILL'); } catch {} }
});
function logCrash(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'errores.log'), new Date().toISOString() + ' ' + msg + ' mem=' + JSON.stringify(process.getSystemMemoryInfo()) + '\n'); } catch {}
}

/* ---------- automatic copy of the project, so a crash or power cut loses almost nothing ---------- */
const autosaveFile = () => path.join(app.getPath('userData'), 'autoguardado.mvs');
ipcMain.handle('autosave-write', (_e, json) => {
  try { const f = autosaveFile(), tmp = f + '.tmp'; fs.writeFileSync(tmp, json, 'utf8'); fs.renameSync(tmp, f); return true; } catch { return false; }
});
ipcMain.handle('autosave-clear', () => { try { fs.unlinkSync(autosaveFile()); } catch {} return true; });
ipcMain.handle('autosave-check', async (_e, afterCrash) => {
  let data, when;
  try { data = fs.readFileSync(autosaveFile(), 'utf8'); when = fs.statSync(autosaveFile()).mtime; } catch { return null; }
  let name = 'Mi video'; try { name = JSON.parse(data).name || name; } catch { return null; }
  const hora = when.toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const r = await dialog.showMessageBox(win, { type: afterCrash ? 'warning' : 'question', buttons: ['Recuperar', 'Descartar'], defaultId: 0, cancelId: 0, noLink: true, title: 'MyVloggingStudio',
    message: afterCrash ? 'El editor se cerró por un error, pero tu proyecto está a salvo.' : 'Encontré cambios sin guardar de la última vez.',
    detail: `"${name}", guardado automáticamente el ${hora}. ¿Lo recuperás?` });
  if (r.response === 1) { try { fs.unlinkSync(autosaveFile()); } catch {} return null; }
  return data;
});

ipcMain.on('close-ok', () => { if (win) { win.__dirtyChecked = true; win.close(); } });

/* ---------- probing & conversion ---------- */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.slice(-800) || 'exit ' + code)));
  });
}

ipcMain.handle('probe', async (_e, file) => {
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    const j = JSON.parse(out);
    const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    return {
      duration: parseFloat(j.format && j.format.duration) || (v && parseFloat(v.duration)) || (a && parseFloat(a.duration)) || 0,
      v: v ? { codec: v.codec_name, pix_fmt: v.pix_fmt || '', width: v.width, height: v.height, transfer: v.color_transfer || '' } : null,
      a: a ? { codec: a.codec_name } : null,
      created: (j.format && j.format.tags && j.format.tags.creation_time) || (v && v.tags && v.tags.creation_time) || null,
      mtime: (() => { try { return fs.statSync(file).mtimeMs; } catch { return null; } })()
    };
  } catch (e) { return null; }
});

const cacheDir = () => { const d = path.join(app.getPath('userData'), 'conversiones'); fs.mkdirSync(d, { recursive: true }); return d; };
const running = new Map();   // out path -> promise
const procs = new Map();     // source file -> child process

function proxyArgs(kind, file, tmp, hw) {
  if (kind === 'image') return ['-y', '-i', file, '-frames:v', '1', tmp];
  if (kind === 'audio') return ['-y', '-i', file, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats', tmp];
  // lightweight 720p editing copy; the export always reads the original file
  return ['-y', ...(hw ? ['-hwaccel', 'auto'] : []), '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='if(gte(iw,ih),-2,720)':'if(gte(iw,ih),720,-2)':out_color_matrix=bt709:out_range=tv,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '23', '-g', '15', '-bf', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
}
function runProxy(e, file, kind, duration, out, tmp, hw) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, proxyArgs(kind, file, tmp, hw), { windowsHide: true });
    procs.set(file, p);
    let err = '', lastSent = 0;
    p.stdout.on('data', d => {
      const m = /out_time_(?:us|ms)=(\d+)/g; let x, last = null;
      while ((x = m.exec(String(d)))) last = x[1];
      const now = Date.now();
      if (last && duration > 0 && now - lastSent > 400) { lastSent = now; e.sender.send('proxy-progress', file, Math.min(0.995, parseInt(last, 10) / 1e6 / duration)); }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-1500); });
    p.on('error', reject);
    p.on('close', code => {
      procs.delete(file);
      if (code === 0) { fs.renameSync(tmp, out); resolve(out); }
      else { try { fs.unlinkSync(tmp); } catch {} reject(new Error(p.__cancelled ? 'cancelado' : err)); }
    });
  });
}
ipcMain.handle('proxy', async (e, file, kind, duration) => {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs + '|v4').digest('hex').slice(0, 16);
  const ext = kind === 'audio' ? '.m4a' : kind === 'image' ? '.png' : '.mp4';
  const out = path.join(cacheDir(), key + ext);
  if (fs.existsSync(out)) return out;
  if (running.has(out)) return running.get(out);
  const tmp = out + '.part' + ext;
  const job = (async () => {
    try { return await runProxy(e, file, kind, duration, out, tmp, kind === 'video'); }
    catch (err) {
      if (kind !== 'video' || String(err.message) === 'cancelado') throw err;
      return await runProxy(e, file, kind, duration, out, tmp, false); // retry without hardware decoding
    }
  })();
  running.set(out, job);
  try { return await job; } finally { running.delete(out); }
});
ipcMain.handle('proxy-cancel', (_e, file) => { const p = procs.get(file); if (p) { p.__cancelled = true; p.kill(); } });

/* ---------- export frame reader: decodes the ORIGINAL file for full quality ---------- */
const readers = new Map();
ipcMain.handle('reader-open', (_e, id, o) => {
  const M = Math.max(o.w, o.h), hq = o.quality === 'maxima';
  const args = ['-v', 'error', '-hwaccel', 'auto', '-ss', o.in.toFixed(4), '-t', (o.out - o.in + 0.5).toFixed(4), '-i', o.path, '-an', '-sn', '-dn',
    '-vf', `setpts=(PTS-STARTPTS)/${o.speed},fps=${o.fps},scale='min(iw,${M})':'min(ih,${M})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic:out_color_matrix=bt601:out_range=full,format=${hq ? 'yuvj444p' : 'yuvj420p'}`,
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', hq ? '1' : '2', '-'];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  const r = { p, buf: Buffer.alloc(0), frames: [], ended: false, waiters: [] };
  const wake = () => { const w = r.waiters.splice(0); w.forEach(f => f()); };
  p.stdout.on('data', d => {
    r.buf = r.buf.length ? Buffer.concat([r.buf, d]) : d;
    for (;;) {
      if (r.buf.length < 4) break;
      let s = r.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (s < 0) { r.buf = Buffer.alloc(0); break; }
      const eoi = r.buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
      if (eoi < 0) { if (s > 0) r.buf = r.buf.subarray(s); break; }
      r.frames.push(Buffer.from(r.buf.subarray(s, eoi + 2)));
      r.buf = r.buf.subarray(eoi + 2);
    }
    if (r.frames.length > 6) p.stdout.pause();
    wake();
  });
  p.stderr.on('data', () => {});
  p.on('error', () => { r.ended = true; wake(); });
  p.on('close', () => { r.ended = true; wake(); });
  readers.set(id, r);
  return true;
});
ipcMain.handle('reader-next', async (_e, id) => {
  const r = readers.get(id); if (!r) return null;
  while (!r.frames.length && !r.ended) await new Promise(f => r.waiters.push(f));
  const f = r.frames.shift() || null;
  if (r.frames.length < 3 && r.p.stdout.isPaused()) r.p.stdout.resume();
  return f;
});
/* ---------- grayscale frames for object tracking ---------- */
const grays = new Map();
ipcMain.handle('gray-open', (_e, id, o) => {
  const args = ['-v', 'error', '-ss', o.in.toFixed(4), '-t', (o.out - o.in).toFixed(4), '-i', o.path, '-an', '-sn', '-dn',
    '-vf', `setpts=(PTS-STARTPTS)/${o.speed},fps=${o.fps},scale=${o.w}:${o.h}:flags=area,format=gbrp`, '-f', 'rawvideo', '-'];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  const size = o.w * o.h * 3;
  const r = { p, buf: Buffer.alloc(0), frames: [], ended: false, waiters: [], size };
  const wake = () => { const w = r.waiters.splice(0); w.forEach(f => f()); };
  p.stdout.on('data', d => {
    r.buf = r.buf.length ? Buffer.concat([r.buf, d]) : d;
    while (r.buf.length >= size) { r.frames.push(Buffer.from(r.buf.subarray(0, size))); r.buf = r.buf.subarray(size); }
    if (r.frames.length > 12) p.stdout.pause();
    wake();
  });
  p.stderr.on('data', () => {});
  p.on('error', () => { r.ended = true; wake(); });
  p.on('close', () => { r.ended = true; wake(); });
  grays.set(id, r);
  return true;
});
ipcMain.handle('gray-next', async (_e, id) => {
  const r = grays.get(id); if (!r) return null;
  while (!r.frames.length && !r.ended) await new Promise(f => r.waiters.push(f));
  const f = r.frames.shift() || null;
  if (r.frames.length < 4 && r.p.stdout.isPaused()) r.p.stdout.resume();
  return f;
});
ipcMain.handle('gray-close', (_e, id) => { const r = grays.get(id); if (r) { try { r.p.kill(); } catch {} grays.delete(id); } });
ipcMain.handle('reader-close', (_e, id) => { const r = readers.get(id); if (r) { try { r.p.kill(); } catch {} readers.delete(id); } });

/* ---------- dialogs & files ---------- */
const MEDIA_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'insv', 'lrf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'];
ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importar medios', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Videos, fotos y audio', extensions: MEDIA_EXT }, { name: 'Todos', extensions: ['*'] }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('save-video-dialog', async (_e, name) => {
  const r = await dialog.showSaveDialog(win, { title: 'Exportar video', defaultPath: path.join(app.getPath('videos'), name + '.mp4'), filters: [{ name: 'Video MP4', extensions: ['mp4'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('save-project', async (_e, json, current, name) => {
  let file = current;
  if (!file) {
    const r = await dialog.showSaveDialog(win, { title: 'Guardar proyecto', defaultPath: path.join(app.getPath('documents'), name + '.mvs'), filters: [{ name: 'Proyecto de MyVloggingStudio', extensions: ['mvs', 'tijera'] }] });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, json, 'utf8');
  return file;
});
ipcMain.handle('open-project', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Abrir proyecto', properties: ['openFile'], filters: [{ name: 'Proyecto de MyVloggingStudio', extensions: ['mvs', 'tijera'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], data: fs.readFileSync(r.filePaths[0], 'utf8') };
});
ipcMain.handle('freeze-frame', async (_e, file, t) => {
  const d = path.join(app.getPath('userData'), 'fotogramas'); fs.mkdirSync(d, { recursive: true });
  const key = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
  const out = path.join(d, `${key}_${Math.round(t * 1000)}.png`);
  if (fs.existsSync(out)) return out;
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgb24', out]);
  return out;
});
ipcMain.handle('display-count', () => screen.getAllDisplays().length);
ipcMain.handle('waveform', (_e, file, perSec) => new Promise(resolve => {
  const rate = 4000, bucket = Math.max(1, Math.round(rate / perSec));
  const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { windowsHide: true });
  const peaks = []; let cur = 0, n = 0, carry = null;
  p.stdout.on('data', d => {
    if (carry) { d = Buffer.concat([carry, d]); carry = null; }
    const len = d.length - (d.length % 2);
    if (len < d.length) carry = d.subarray(len);
    for (let i = 0; i < len; i += 2) { const v = Math.abs(d.readInt16LE(i)); if (v > cur) cur = v; if (++n === bucket) { peaks.push(Math.min(255, Math.round(Math.sqrt(cur / 32768) * 255))); cur = 0; n = 0; } }
  });
  p.on('error', () => resolve(null));
  p.on('close', () => resolve(peaks.length ? Uint8Array.from(peaks) : null));
}));
ipcMain.handle('exists', (_e, p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('confirm-discard', async () => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Guardar', 'No guardar', 'Cancelar'], defaultId: 0, cancelId: 2, title: 'MyVloggingStudio', message: '¿Guardar los cambios del proyecto?', detail: 'Si no los guardás, se pierden.' });
  return ['save', 'discard', 'cancel'][r.response];
});

/* ---------- export ---------- */
function tempoChain(s) {
  const out = [];
  while (s > 2.0001) { out.push(2); s /= 2; }
  while (s < 0.4999) { out.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push(+s.toFixed(5));
  return out;
}
function buildAudio(segs, total) {
  // one input per piece (seeked), so two pieces of the same file never share a decoder — sharing one makes FFmpeg stall
  const inputs = [], parts = [], labels = [];
  segs.forEach((s, i) => {
    const len = s.out - s.in;
    inputs.push('-ss', Math.max(0, s.in).toFixed(4), '-t', (len + 0.25).toFixed(4), '-i', s.path);
    const k = i + 1;
    const d = len / s.speed;
    let f = `[${k}:a:0]asetpts=PTS-STARTPTS,atrim=end=${len.toFixed(4)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
    for (const t of tempoChain(s.speed)) f += `,atempo=${t}`;
    f += `,volume=${s.volume.toFixed(3)}`;
    if (s.fadeIn > 0) f += `,afade=t=in:st=0:d=${s.fadeIn.toFixed(3)}`;
    if (s.fadeOut > 0) f += `,afade=t=out:st=${Math.max(0, d - s.fadeOut).toFixed(3)}:d=${s.fadeOut.toFixed(3)}`;
    const ms = Math.round(s.start * 1000);
    if (ms > 0) f += `,adelay=delays=${ms}:all=1`;
    parts.push(f + `[a${i}]`); labels.push(`[a${i}]`);
  });
  let graph;
  if (!segs.length) graph = `anullsrc=r=48000:cl=stereo,atrim=end=${total.toFixed(4)}[aout]`;
  else graph = parts.join(';') + `;${labels.join('')}amix=inputs=${segs.length}:normalize=0:dropout_transition=0,apad,atrim=end=${total.toFixed(4)}[aout]`;
  return { inputs, graph };
}

let job = null;
ipcMain.handle('export-start', (_e, o) => {
  const { inputs, graph } = buildAudio(o.segs, o.total);
  const Q = { alta: { crf: 18, b: '256k' }, muyalta: { crf: 15, b: '320k' }, maxima: { crf: 12, b: '320k' } }[o.quality] || { crf: 15, b: '320k' };
  const big = o.h * o.w > 2560 * 1440;
  const preset = o.quality === 'maxima' ? 'medium' : big ? 'faster' : 'medium';
  const vin = o.raw ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.w}x${o.h}`, '-framerate', String(o.fps), '-i', '-']
                    : ['-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', 'mjpeg', '-i', '-'];
  const args = ['-y', ...vin, ...inputs,
    '-filter_complex', `[0:v]scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p[vout];${graph}`, '-map', '[vout]', '-map', '[aout]',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', preset, '-crf', String(Q.crf), '-r', String(o.fps),
    '-c:a', 'aac', '-b:a', Q.b, '-t', o.total.toFixed(4), '-movflags', '+faststart', o.out];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  job = { p, err: '', out: o.out, total: o.total, done: new Promise(r => p.on('close', code => r(code))) };
  p.stderr.on('data', d => { job && (job.err = (job.err + d).slice(-3000)); });
  p.stdin.on('error', () => {});
  return true;
});
ipcMain.handle('export-frame', async (_e, buf) => {
  if (!job || job.p.exitCode !== null) return false;
  const ok = job.p.stdin.write(Buffer.from(buf));
  if (!ok) await new Promise(r => job.p.stdin.once('drain', r));
  return true;
});
ipcMain.handle('export-end', async () => {
  if (!job) return { ok: false, error: 'Sin exportación' };
  job.p.stdin.end();
  const code = await job.done;
  let size = 0; try { size = fs.statSync(job.out).size; } catch {}
  const r = { ok: code === 0, path: job.out, size, mbps: job.total > 0 ? size * 8 / job.total / 1e6 : 0, error: code === 0 ? '' : job.err.slice(-600) };
  job = null;
  return r;
});
ipcMain.handle('export-cancel', async () => {
  if (!job) return;
  const out = job.out;
  try { job.p.stdin.destroy(); job.p.kill('SIGKILL'); } catch {}
  await job.done; job = null;
  try { fs.unlinkSync(out); } catch {}
});
