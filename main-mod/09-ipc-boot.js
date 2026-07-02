// ---------------------------------------------------------------------------
// Finalize / Organize — point at the Compressed folder, match files to their
// stored records, embed XMP, write a Resolve CSV, and file them into folders.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// IN-APP COMPRESSION — actually compress the Uncompressed intake clips with the
// bundled ffmpeg into the Compressed folder (so the app's "Compress" promise is
// real, not a handoff). Per-file H.264/H.265 transcode with live progress, skip
// of already-done outputs, cancellation, and partial-file cleanup.
// ---------------------------------------------------------------------------
const COMPRESS_PRESETS = {
  balanced:  { codec: 'h264', crf: 23, preset: 'medium', scale: '1080', audio: 'aac' },
  smaller:   { codec: 'h265', crf: 28, preset: 'medium', scale: '1080', audio: 'aac' },
  hq:        { codec: 'h264', crf: 20, preset: 'slow',   scale: 'source', audio: 'aac' },
};
function compressSettings(s) {
  const base = COMPRESS_PRESETS[(s && s.preset) || 'balanced'] || COMPRESS_PRESETS.balanced;
  return { ...base, ...(s && s.overrides ? s.overrides : {}), skipExisting: !(s && s.skipExisting === false) };
}
function buildCompressArgs(src, out, s) {
  const a = ['-y', '-i', src];
  if (s.scale && s.scale !== 'source') a.push('-vf', `scale=-2:${s.scale}`);
  if (s.codec === 'h265') a.push('-c:v', 'libx265', '-tag:v', 'hvc1', '-crf', String(s.crf ?? 28));
  else a.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(s.crf ?? 23));
  a.push('-preset', s.preset || 'medium');
  if (s.audio === 'copy') a.push('-c:a', 'copy'); else a.push('-c:a', 'aac', '-b:a', '160k');
  a.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
  return a;
}
function ffmpegLastError(err) {
  const lines = String(err || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}
let compressProc = null;
let compressAborted = false;
ipcMain.handle('compress:cancel', () => { compressAborted = true; if (compressProc) treeKill(compressProc); return true; });
ipcMain.handle('compress:defaults', () => {
  let outDir = config.finalizeSource || '';
  if (!outDir && config.intakeFolder) outDir = config.intakeFolder.replace(/01 - Uncompressed[\\/]?$/i, '02 - Compressed');
  return { intake: config.intakeFolder || '', outDir, presets: Object.keys(COMPRESS_PRESETS), mode: config.compressMode || 'external' };
});
ipcMain.handle('compress:list', async (_e, dir) => {
  const d = dir || config.intakeFolder;
  if (!d) return { ok: false, error: 'No source folder' };
  try { return { ok: true, dir: d, files: await listVideosShallow(d) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('compress:run', async (evt, payload) => {
  const { files, outDir } = payload || {};
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'No files to compress' };
  const out = outDir || config.finalizeSource;
  if (!out) return { ok: false, error: 'No output (Compressed) folder set' };
  try { await ensureDir(out); } catch (e) { return { ok: false, error: `Cannot create output folder: ${e.message}` }; }
  const s = compressSettings(payload && payload.settings);
  compressAborted = false;
  const results = [];
  const produced = new Set();   // output paths created THIS run, to avoid collisions
  const send = (p) => { try { evt.sender.send('compress:progress', p); } catch { /* ignore */ } };
  for (let i = 0; i < files.length; i += 1) {
    if (compressAborted) break;
    const f = files[i];
    const src = f.sourcePath || f.src || f.path;
    if (!src) { results.push({ name: f.name, ok: false, error: 'No source path' }); continue; }
    const base = path.basename(f.name || src).replace(/\.[^.]+$/, '');
    let outPath = path.join(out, `${base}.mp4`);
    if (pathsEqual(outPath, src)) outPath = path.join(out, `${base}_compressed.mp4`);
    // Two source clips that share a stem but differ in container (clip.mov + clip.mp4)
    // would map to the same output — disambiguate so neither is lost/overwritten. Keyed
    // case-insensitively so Clip.mp4/clip.mp4 collide on Windows (they're one file).
    let cn = 1;
    while (produced.has(pathKey(outPath))) { outPath = path.join(out, `${base} (${cn}).mp4`); cn += 1; }
    produced.add(pathKey(outPath));
    let inBytes = 0; try { inBytes = (await fsp.stat(src)).size; } catch { /* ignore */ }
    let durationSec = 0; try { durationSec = (await probeMeta(src)).durationSec || 0; } catch { /* ignore */ }
    if (s.skipExisting) { try { const st = await fsp.stat(outPath); if (st.size > 0) { results.push({ name: f.name, ok: true, skipped: true, outPath, inBytes, outBytes: st.size }); send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'skipped' }); continue; } } catch { /* not there */ } }
    send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'starting', inBytes });
    const args = buildCompressArgs(src, outPath, s);
    // eslint-disable-next-line no-await-in-loop
    const res = await new Promise((resolve) => {
      let errBuf = '';
      const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
      compressProc = proc;
      proc.stdout.on('data', (d) => {
        const m = String(d).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (!m) return;
        if (durationSec) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          send({ index: i, total: files.length, name: f.name, pct: Math.max(1, Math.min(99, Math.round((sec / durationSec) * 100))), phase: 'compressing', inBytes });
        } else {
          // ffprobe couldn't read a duration → no %; show that it's working, not stuck at 0%.
          send({ index: i, total: files.length, name: f.name, phase: 'compressing', indeterminate: true, inBytes });
        }
      });
      proc.stderr.on('data', (d) => { errBuf += String(d); if (errBuf.length > 6000) errBuf = errBuf.slice(-6000); });
      proc.on('error', (e) => { compressProc = null; resolve({ ok: false, error: e.message }); });
      proc.on('close', (code) => { compressProc = null; resolve(code === 0 ? { ok: true } : { ok: false, error: compressAborted ? 'cancelled' : (ffmpegLastError(errBuf) || `ffmpeg exited ${code}`) }); });
    });
    if (res.ok) {
      let outBytes = 0; try { outBytes = (await fsp.stat(outPath)).size; } catch { /* ignore */ }
      results.push({ name: f.name, ok: true, outPath, inBytes, outBytes });
      send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'done', inBytes, outBytes });
    } else {
      try { await fsp.rm(outPath, { force: true }); } catch { /* ignore */ }   // never leave a half-written file
      results.push({ name: f.name, ok: false, error: res.error });
      send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'error', error: res.error });
      if (compressAborted) break;
    }
  }
  // Point Finalize at where we just wrote, so "Organize" continues seamlessly.
  if (out && out !== config.finalizeSource) { config.finalizeSource = out; saveConfig(); }
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  if (!compressAborted) notify('Compression complete', `Compressed ${okCount} clip${okCount !== 1 ? 's' : ''} into your Compressed folder.`);
  return { ok: !compressAborted, cancelled: compressAborted, results, outDir: out };
});

ipcMain.handle('finalize:getSource', () => config.finalizeSource || '');

ipcMain.handle('finalize:pickSource', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Compressed folder',
    defaultPath: config.finalizeSource || config.organizeDest || undefined,
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  config.finalizeSource = res.filePaths[0];
  saveConfig();
  return config.finalizeSource;
});

// "Pending work" for the home screen: how much footage is sitting in the Uncompressed
// intake (still to compress, then organize) vs. already in the Compressed folder ready
// to organize now. Lets the app greet you on launch with "you've got footage to deal
// with" and jump straight into organizing — the per-clip AI analysis is already
// remembered (finalMeta), so nothing re-analyzes.
ipcMain.handle('pending:work', async () => {
  const intakeDir = config.intakeFolder || '';
  const readyDir = config.finalizeSource || config.organizeDest || '';
  let uncompressed = 0; let ready = 0; let readyAnalyzed = 0;
  try { uncompressed = (await listVideosShallow(intakeDir)).length; } catch { /* ignore */ }
  if (readyDir && readyDir !== intakeDir) {
    try {
      const files = await listVideosShallow(readyDir);
      ready = files.length;
      const store = currentFinalMeta();
      const stems = new Set(Object.keys(store).map((k) => stemOf(k)));
      for (const f of files) { const lc = f.name.toLowerCase(); if (store[lc] || stems.has(stemOf(lc))) readyAnalyzed += 1; }
    } catch { /* ignore */ }
  }
  return { ok: true, intakeDir, readyDir, uncompressed, ready, readyAnalyzed };
});

// Scan the (top level of the) Compressed folder and match each file to a stored
// record by exact filename, falling back to a stem match (so a container change
// during compression, e.g. .mov → .mp4, still matches).
ipcMain.handle('finalize:scan', async (_evt, sourceDir) => {
  // Accept either a plain path (legacy) or { dir, includePhotos } so the Organize screen
  // can opt into listing photos alongside (or instead of) videos.
  const opts = (sourceDir && typeof sourceDir === 'object') ? sourceDir : { dir: sourceDir };
  const dir = opts.dir || config.finalizeSource;
  if (!dir) return { ok: false, error: 'No folder chosen' };
  let files;
  try {
    files = await listVideosShallow(dir);
    if (opts.includePhotos) files = files.concat(await listImagesShallow(dir));
  } catch (err) { return { ok: false, error: err.message }; }

  const store = currentFinalMeta();
  const byName = {}; const byStem = {};
  for (const [k, v] of Object.entries(store)) {
    byName[k] = v;
    byStem[stemOf(k)] = v;
  }
  // Token set of a filename stem (drop version/ext/camera junk) for FUZZY matching —
  // recovers the saved record (incl. observation/people) even if the compressor
  // renamed the file (different separators, an added suffix, a dropped token…).
  const fileTokens = (s) => new Set(String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/_v\d+$/i, '')
    .split(/[\s\-_.]+/).filter((t) => t && t.length > 1 && !/^(gx|gopro|hero|dji|img|dsc|mvi|mp4|mov|avi)\w*$/i.test(t)));
  const tokenScore = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n += /^\d{4}-\d{2}-\d{2}$/.test(t) ? 3 : 1; return n; };   // a shared date counts strong
  const storeEntries = Object.entries(store).map(([k, v]) => ({ v, tokens: fileTokens(k) }));
  const out = files.map((f) => {
    const lc = f.name.toLowerCase();
    let rec = byName[lc] || byStem[stemOf(lc)] || null;
    let matchType = rec ? 'saved' : null;
    if (!rec && storeEntries.length) {
      // Fuzzy: best token-overlap against the saved records; needs a strong match
      // (e.g. shared date + ≥1 subject token) so unrelated files don't false-match.
      const ft = fileTokens(f.name); let best = null; let bestScore = 0;
      for (const e of storeEntries) { const s = tokenScore(ft, e.tokens); if (s > bestScore) { bestScore = s; best = e.v; } }
      if (best && bestScore >= 4) { rec = best; matchType = 'fuzzy'; }
    }
    if (!rec) {
      const parsed = parseNamedClip(f.name);   // last resort: derive from the filename
      if (parsed) { rec = parsed; matchType = 'name'; }
    }
    // Photos almost never have a saved record yet (IMG_1234.jpg), but they should still
    // be SELECTABLE so Analyze can name them — so treat a photo as "matched/included".
    return { name: f.name, sourcePath: f.sourcePath, size: f.size, isPhoto: !!f.isPhoto, matched: !!rec || !!f.isPhoto, matchType: rec ? matchType : (f.isPhoto ? 'photo' : matchType), meta: rec };
  });
  return {
    ok: true, dir,
    files: out,
    total: out.length,
    matchedCount: out.filter((x) => x.matched).length
  };
});

// Build a RICH XMP/IPTC tag set for one clip — the more searchable metadata the
// better for indexing later (digiKam, Bridge, Resolve, Windows search). Everything
// lands in standard XMP namespaces (dc / lr / photoshop) that indexers read.
function buildEmbedTags(meta, parts, fallbackName) {
  const m = meta || {};
  const deh = (s) => String(s || '').replace(/[-_]+/g, ' ').trim();   // de-hyphen for human text
  // Hierarchy-safe component: like deh, but also strips the path separators that
  // structure a hierarchical tag ('|' '/' '\') so a value like "AC/DC" or
  // "Smith | Jones" can't accidentally split into bogus extra tree levels.
  const hc = (s) => deh(s).replace(/[|/\\]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const fieldIds = (config.organizeFields || []).map((f) => f.id);
  const fieldVals = fieldIds.map((id) => m[id]).filter(Boolean);
  const date = String(m.date || '');
  const year = /^(\d{4})/.test(date) ? date.slice(0, 4) : '';
  // Flat keyword list — structured fields PLUS the individual words inside subject/
  // description/location, so a search for any token finds the clip.
  const words = uniqStrings(`${m.subject || ''} ${m.description || ''} ${m.location || ''}`.split(/[\s\-_]+/));
  const keywords = uniqStrings([
    m.subject, m.location, m.shotType, m.category, m.project, ...fieldVals,
    ...(Array.isArray(m.keywords) ? m.keywords : []),
    ...(Array.isArray(m.people) ? m.people : []),
    date, year, ...words
  ]).filter((k) => k && k.length > 1);
  // Hierarchical tags (digiKam/Lightroom): the category→project→subject chain and
  // the actual folder path the clip files into.
  const hier = [];
  const chain = uniqStrings([m.category, m.project, m.subject].map(hc));
  if (chain.length > 1) hier.push(chain.join('|'));
  if (Array.isArray(parts) && parts.length > 1) hier.push(parts.join('|'));
  // A readable caption for full-text search — and append the AI's visual
  // observation if we captured one (great for "what was in that clip?" searches).
  const bits = [];
  if (m.subject) bits.push(deh(m.subject));
  if (m.description) bits.push(deh(m.description));
  if (m.shotType) bits.push(`${deh(m.shotType)} shot`);
  if (m.location) bits.push(`at ${deh(m.location)}`);
  if (date) bits.push(`on ${date}`);
  let caption = bits.join(', ');
  if (m.observation) caption += (caption ? ` — ${m.observation}` : m.observation);
  const title = uniqStrings([deh(m.subject), deh(m.description)]).join(' ').trim() || stemOf(fallbackName || '');

  const tags = {};
  if (title) tags['XMP-dc:Title'] = title;
  if (caption) tags['XMP-dc:Description'] = caption;
  if (keywords.length) tags['XMP-dc:Subject'] = keywords;             // flat keywords (Resolve/Bridge)
  if (hier.length) tags['XMP-lr:HierarchicalSubject'] = hier;          // digiKam/Lightroom tag tree
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) tags['XMP-photoshop:DateCreated'] = date;
  if (m.location) tags['XMP-iptcCore:Location'] = deh(m.location);
  if (m.context) tags['XMP-dc:Coverage'] = m.context;                  // the shoot context, kept searchable
  if (m.shotType) tags['XMP-xmp:Label'] = deh(m.shotType);
  // People / faces — written so digiKam reads them as people tags. We write THREE
  // standard things: IPTC PersonInImage (Bridge/Lightroom), a "People/<name>" branch
  // in the hierarchical subject + digiKam's own TagsList (digiKam shows these under
  // its People tag tree), and MWG region person names (digiKam face-region readers).
  if (Array.isArray(m.people) && m.people.length) {
    const ppl = uniqStrings(m.people).filter(Boolean);
    if (ppl.length) {
      tags['XMP-iptcExt:PersonInImage'] = ppl;
      tags['XMP-mwg-rs:RegionPersonDisplayName'] = ppl;
      tags['XMP-mwg-rs:RegionName'] = ppl;
      tags['XMP-mwg-rs:RegionType'] = ppl.map(() => 'Face');
      const peopleHier = ppl.map((n) => `People|${hc(n)}`);
      const peopleTags = ppl.map((n) => `People/${hc(n)}`);
      tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), ...peopleHier]);
      tags['XMP-digiKam:TagsList'] = peopleTags;
    }
  }
  // User tags — write them into digiKam's own TagsList + the hierarchical tree (not
  // just the flat keyword list) so they show up under digiKam's Tags panel as real
  // tags, exactly like the screenshot the user shared.
  if (Array.isArray(m.tags) && m.tags.length) {
    const ut = uniqStrings(m.tags).filter(Boolean);
    if (ut.length) {
      tags['XMP-digiKam:TagsList'] = uniqStrings([...(tags['XMP-digiKam:TagsList'] || []), ...ut]);
      tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), ...ut]);
      tags['XMP-dc:Subject'] = uniqStrings([...(tags['XMP-dc:Subject'] || keywords), ...ut]);
    }
  }
  // Location → a "Places/<location>" branch (digiKam Places tree + Lightroom),
  // mirroring how people get a People branch, so footage is browsable by place and
  // not just findable as a flat keyword.
  const place = hc(m.location);
  if (place) {
    tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), `Places|${place}`]);
    tags['XMP-digiKam:TagsList'] = uniqStrings([...(tags['XMP-digiKam:TagsList'] || []), `Places/${place}`]);
  }
  return tags;
}

ipcMain.handle('finalize:run', async (evt, payload) => {
  const sender = evt.sender;
  const { items, options, dir } = payload || {};
  const opts = options || {};
  const list = Array.isArray(items) ? items.filter((it) => it && it.meta) : [];
  // Per-run choices come from the payload (the Organize screen), falling back to
  // the saved config.
  const dest = payload.organizeDest || config.organizeDest || '';
  const levels = (Array.isArray(payload.folderLevels) && payload.folderLevels.length)
    ? payload.folderLevels
    : (Array.isArray(config.folderLevels) && config.folderLevels.length ? config.folderLevels : ['category', 'project']);
  const nasRoot = (opts.nas && payload.nasPath) ? payload.nasPath : '';

  if (opts.organize && !dest) {
    return { ok: false, error: 'No destination folder set. Choose one in Edit → “Organizing & folders…”.' };
  }

  const summary = { ok: true, embedded: 0, moved: 0, skipped: 0, backedUp: 0, errors: [], total: list.length, csvPath: '' };
  const undoable = [];   // {from,to} per relocated clip → enables "Undo last organize"
  const csvRows = [];
  const et = opts.embed ? getExifTool() : null;
  const emit = (index, name, phase) => sender.send('finalize:progress', { index, total: list.length, name, phase });

  for (let i = 0; i < list.length; i += 1) {
    const it = list[i];
    const meta = it.meta || {};
    let curPath = it.sourcePath;
    let finalFileName = it.name;
    const parts = subdirParts(levels, meta);
    const tags = buildEmbedTags(meta, parts, it.name);
    const keywords = Array.isArray(tags['XMP-dc:Subject']) ? tags['XMP-dc:Subject'] : [];

    // 1. Embed a RICH XMP packet (Title, Description, flat keywords→dc:subject,
    // hierarchical tags for digiKam/Lightroom, date, location, people, shot type…).
    // If the embed fails, SKIP the move/backup for this file and leave it where it
    // is, so re-running retries it cleanly (a moved-but-untagged file would drop
    // out of the next shallow scan).
    if (et) {
      emit(i, it.name, 'embedding');
      try {
        if (Object.keys(tags).length) {
          await et.write(curPath, tags, ['-overwrite_original']);
          summary.embedded += 1;
        }
      } catch (err) {
        summary.errors.push(`Embed ${it.name}: ${err.message}`);
        continue;   // leave untouched for a clean retry
      }
    }

    // 2. Organize into <dest>/<folderLevels…>/ (idempotent).
    if (opts.organize && dest) {
      emit(i, it.name, 'moving');
      try {
        const before = curPath;   // capture origin BEFORE reassigning, for undo
        const r = await organizeMove(curPath, path.join(dest, ...parts), it.name);
        if (r.action === 'moved') { summary.moved += 1; undoable.push({ from: before, to: r.path }); } else summary.skipped += 1;
        curPath = r.path;
        finalFileName = path.basename(r.path);
      } catch (err) { summary.errors.push(`Move ${it.name}: ${err.message}`); }
    }

    // 3. Mirror to the NAS (organized structure), if enabled.
    if (nasRoot) {
      emit(i, it.name, 'backup');
      try {
        const nasDir = path.join(nasRoot, ...parts);
        const nasTarget = path.join(nasDir, finalFileName);
        // Same verified-copy path as the import-time NAS mirror — one shared primitive,
        // so a truncated/corrupt backup is never trusted (and the two can't drift).
        if (await copyFileVerified(curPath, nasTarget) === 'copied') summary.backedUp += 1;
      } catch (err) { summary.errors.push(`Backup ${it.name}: ${err.message}`); }
    }

    // 4. Resolve CSV row.
    if (opts.csv) {
      // Scene = the deepest configured folder level's value (a useful grouping in
      // Resolve), falling back to the legacy 'project' field.
      const sceneLevel = levels[levels.length - 1];
      const scene = (sceneLevel ? metaLevelValue(sceneLevel, meta) : '') || meta.project || '';
      csvRows.push({
        file: finalFileName,
        description: meta.description || '',
        keywords: keywords.join(', '),
        scene
      });
    }
  }

  // Write the Resolve metadata CSV next to the organized folder (or the scan
  // folder when not organizing). Columns Resolve's Import Metadata maps directly.
  if (opts.csv && csvRows.length) {
    try {
      const csvDir = (opts.organize && dest) ? dest : (dir || config.finalizeSource || dest);
      const csvPath = path.join(csvDir, 'resolve-metadata.csv');
      const lines = [['File Name', 'Description', 'Keywords', 'Scene'].map(csvCell).join(',')];
      for (const r of csvRows) lines.push([r.file, r.description, r.keywords, r.scene].map(csvCell).join(','));
      await fsp.writeFile(csvPath, lines.join('\r\n'), 'utf8');
      summary.csvPath = csvPath;
    } catch (err) { summary.errors.push(`CSV: ${err.message}`); }
  }

  // Record this run's relocations so "Undo last organize" can move them back.
  if (undoable.length) { config.lastOrganize = { ts: Date.now(), moves: undoable }; saveConfig(); }

  return summary;
});

// Intake folder (compression destination) — view / pick / set.
ipcMain.handle('intake:get', () => config.intakeFolder);

ipcMain.handle('intake:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the compression intake folder',
    defaultPath: config.intakeFolder,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Generic folder picker (destination / NAS backup).
ipcMain.handle('folder:pick', async (_evt, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: (opts && opts.title) || 'Choose a folder',
    defaultPath: (opts && opts.defaultPath) || undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Pick a single document file (for importing a naming SOP / notes into memory).
ipcMain.handle('file:pick', async (_evt, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: (opts && opts.title) || 'Choose a document',
    filters: [{ name: 'Text & docs', extensions: ['txt', 'md', 'markdown', 'rtf', 'csv', 'json', 'text'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Pick one or more image files (for attaching screenshots to feedback).
ipcMain.handle('image:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach images',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('intake:set', (_evt, folder) => {
  if (folder && typeof folder === 'string') {
    config.intakeFolder = folder;
    saveConfig();
  }
  return config.intakeFolder;
});

// Rename a copied file inside the intake folder. Returns the new path.
ipcMain.handle('rename:apply', async (_evt, payload) => {
  const { destPath, newName } = payload;
  try {
    const dir = path.dirname(destPath);
    const ext = path.extname(destPath);
    // Sanitize the user-supplied name; keep their extension if they typed one.
    let cleaned = String(newName || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!cleaned) return { ok: false, error: 'Name cannot be empty' };
    if (path.extname(cleaned).toLowerCase() !== ext.toLowerCase()) {
      cleaned += ext;
    }
    const target = await uniqueDest(dir, cleaned);
    await fsp.rename(destPath, target);
    return { ok: true, destPath: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Delete selected files from the SOURCE drive (sends to recycle bin via shell).
// Fast integrity fingerprint: size + SHA-256 of three 2 MB samples (head, middle,
// tail). Catches truncation and the common corruption modes without reading a whole
// 50 GB card. (Not a full-file hash — a deliberate speed/safety trade-off.)
async function sampledFingerprint(filePath, { full = false } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    const CHUNK = 2 * 1024 * 1024;
    const hash = crypto.createHash('sha256');
    hash.update(`sz:${size}`);
    const readAt = async (pos, len) => {
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, pos));
      hash.update(buf.subarray(0, bytesRead));
    };
    // full=true hashes the ENTIRE file (used to VERIFY a freshly-written copy — the sampled
    // head/mid/tail can't catch a mid-file corruption that preserves length). Sampled stays
    // the default for the resume/dedup pre-checks that scan whole cards.
    if (full || size <= CHUNK * 3) { await readAt(0, size); }
    else { await readAt(0, CHUNK); await readAt(Math.floor(size / 2) - CHUNK / 2, CHUNK); await readAt(size - CHUNK, CHUNK); }
    return { size, hash: hash.digest('hex') };
  } finally { await fh.close(); }
}
// True when two files have the same size + sampled fingerprint (used for NAS
// resume-dedup and post-copy verification). Best-effort: false on any read error.
async function fingerprintsMatch(a, b, opts) {
  try { const [x, y] = await Promise.all([sampledFingerprint(a, opts), sampledFingerprint(b, opts)]); return x.size === y.size && x.hash === y.hash; }
  catch { return false; }
}
// Verify each copied file against its source BEFORE the originals are deleted.
ipcMain.handle('verify:copies', async (_evt, pairs) => {
  const out = [];
  for (const p of (Array.isArray(pairs) ? pairs : [])) {
    const src = p && p.source; const dst = p && p.dest;
    let ok = false; let reason = '';
    try {
      if (!dst) { reason = 'no copy on record'; }
      else {
        let ss = null; let ds = null;
        try { ss = await fsp.stat(src); } catch { reason = 'source missing'; }
        try { ds = await fsp.stat(dst); } catch { reason = reason || 'copy missing'; }
        if (ss && ds) {
          if (ss.size !== ds.size) { reason = `size mismatch (${ss.size} vs ${ds.size})`; }
          else {
            const [fa, fb] = await Promise.all([sampledFingerprint(src), sampledFingerprint(dst)]);
            if (fa.hash === fb.hash) ok = true; else reason = 'content mismatch';
          }
        }
      }
    } catch (e) { reason = e.message || String(e); }
    out.push({ source: src, dest: dst, ok, reason });
  }
  return out;
});

// Free space on the volume that contains `folderPath` (walks up to the nearest
// existing ancestor so it works even before the folder is created).
ipcMain.handle('disk:freeSpace', async (_evt, folderPath) => {
  try {
    let probe = String(folderPath || '');
    if (!probe) return { ok: false, error: 'no path' };
    for (let i = 0; i < 8; i += 1) {
      try { await fsp.access(probe); break; } catch { const up = path.dirname(probe); if (!up || up === probe) break; probe = up; }
    }
    const st = await fsp.statfs(probe);
    return { ok: true, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), path: probe };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Lightweight index of imported source files (key = name+size) so a re-inserted
// card's already-copied clips can be flagged and skipped. Capped to 30k entries.
ipcMain.handle('imports:get', () => Object.keys(config.importIndex || {}));
ipcMain.handle('imports:add', (_evt, payload) => {
  const keys = (payload && Array.isArray(payload.keys)) ? payload.keys : [];
  if (!keys.length) return { ok: true };
  if (!config.importIndex || typeof config.importIndex !== 'object') config.importIndex = {};
  const now = Date.now();
  for (const k of keys) { if (k) config.importIndex[String(k)] = now; }
  let entries = Object.entries(config.importIndex);
  if (entries.length > 30000) { entries.sort((a, b) => b[1] - a[1]); config.importIndex = Object.fromEntries(entries.slice(0, 30000)); }
  saveConfig();
  return { ok: true, total: Object.keys(config.importIndex).length };
});

ipcMain.handle('delete:source', async (_evt, sourcePaths) => {
  const results = [];
  for (const p of sourcePaths) {
    let ok = false; let method = ''; let error = '';
    // Prefer the Recycle Bin (recoverable), but USB/SD cards (exFAT/removable)
    // usually have no Recycle Bin — there, permanently delete (the intent when
    // clearing a card after copying).
    try { await shell.trashItem(p); ok = true; method = 'recycle'; }
    catch (e1) {
      try { await fsp.rm(p, { force: true }); ok = true; method = 'deleted'; }
      catch (e2) { error = e2.message || e1.message; }
    }
    results.push({ path: p, ok, method, error });
  }
  return results;
});

ipcMain.handle('open:folder', async (_evt, folder) => {
  try {
    await shell.openPath(folder || config.intakeFolder);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    // FIRST, in the primary only (we hold the single-instance lock here): move any
    // append-heavy stores still living in config.json into their own sidecar files,
    // before anything can trigger a config save. One-time; a no-op once migrated.
    migrateStores();

    // Keep the OS login-item entry in sync with config on every start.
    applyLoginItem(config.launchAtLogin);
    console.log(`[startup] launchAtLogin = ${config.launchAtLogin}`);

    ingestMemoryInbox();   // fold any externally-dropped learnings into AI memory
    // Purge last session's thumbnail/poster scratch so temp can't grow without bound.
    try { fs.rmSync(THUMB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    createWindow();
    createTray();

    // Self-update from the Gitea "latest" feed (packaged Windows only). Check a
    // few seconds after boot so it never delays the first paint, then every 6h.
    setTimeout(() => setupAutoUpdates(), 8000);
    setInterval(() => setupAutoUpdates(), 6 * 60 * 60 * 1000);

    // Global hotkey (low-overhead alternative to polling).
    if (config.hotkey) {
      const ok = globalShortcut.register(config.hotkey, triggerHotkey);
      if (ok) console.log(`[hotkey] registered ${config.hotkey}`);
      else console.error(`[hotkey] FAILED to register ${config.hotkey} (already in use?)`);
    }

    // Background polling is opt-in (set "autoPoll": true in config.json).
    if (config.autoPoll) {
      console.log('[detect] auto-poll enabled');
      startPolling();
    } else {
      console.log('[detect] auto-poll disabled — use the hotkey or “Choose drive…”.');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Do NOT quit when the window closes — the app lives in the tray so the global
// hotkey keeps working. Quit only via the tray's "Quit" item.
app.on('window-all-closed', () => { /* stay resident */ });

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  globalShortcut.unregisterAll();
  endExifTool();
});
