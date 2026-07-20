'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Theme (Windows 11 light/dark + system accent)
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (cb) => {
    const listener = (_evt, t) => cb(t);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },

  // Config / window
  getConfig: () => ipcRenderer.invoke('config:get'),
  setUiPref: (key, value) => ipcRenderer.invoke('ui:set', { key, value }),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  hideWindow: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openFolder: (folder) => ipcRenderer.invoke('open:folder', folder),
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),

  // Drives
  onDriveDetected: (cb) => {
    const listener = (_evt, drive) => cb(drive);
    ipcRenderer.on('drive:detected', listener);
    return () => ipcRenderer.removeListener('drive:detected', listener);
  },
  onDriveOptions: (cb) => {
    const listener = (_evt, drives) => cb(drives);
    ipcRenderer.on('drive:options', listener);
    return () => ipcRenderer.removeListener('drive:options', listener);
  },
  listRemovable: () => ipcRenderer.invoke('drive:listRemovable'),
  pickDrive: () => ipcRenderer.invoke('drive:pick'),

  // Scan + copy
  scanVideos: (mountpoint) => ipcRenderer.invoke('scan:videos', mountpoint),
  startCopy: (files, intakeFolder) => ipcRenderer.invoke('copy:start', { files, intakeFolder }),
  cancelCopy: () => ipcRenderer.invoke('copy:cancel'),
  copyStatus: () => ipcRenderer.invoke('copy:status'),
  onCopyProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('copy:progress', listener);
    return () => ipcRenderer.removeListener('copy:progress', listener);
  },

  // Media / preview
  mediaUrl: (filePath) => ipcRenderer.invoke('media:url', filePath),
  getMeta: (srcPath) => ipcRenderer.invoke('meta:get', srcPath),
  getPoster: (srcPath) => ipcRenderer.invoke('poster:get', srcPath),

  // Phone backup (MTP — phones with no drive letter)
  listPhones: () => ipcRenderer.invoke('phone:list'),
  phoneAlbums: (device) => ipcRenderer.invoke('phone:albums', { device }),
  phonePulledNames: () => ipcRenderer.invoke('phone:pulledNames'),
  pickPhoneBackupFolder: () => ipcRenderer.invoke('phoneBackup:pick'),
  clearPhoneBackupFolder: () => ipcRenderer.invoke('phoneBackup:clear'),
  adbStatus: () => ipcRenderer.invoke('adb:status'),
  adbEnable: () => ipcRenderer.invoke('adb:enable'),
  adbDisable: () => ipcRenderer.invoke('adb:disable'),
  wirelessBegin: () => ipcRenderer.invoke('wireless:begin'),
  wirelessAwait: () => ipcRenderer.invoke('wireless:await'),
  wirelessCancel: () => ipcRenderer.invoke('wireless:cancel'),
  wirelessManualPair: (payload) => ipcRenderer.invoke('wireless:manualPair', payload),
  onWirelessStatus: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('wireless:status', listener);
    return () => ipcRenderer.removeListener('wireless:status', listener);
  },
  scanPhone: (name, albums) => ipcRenderer.invoke('phone:scan', { name, albums }),
  pullFromPhone: (payload) => ipcRenderer.invoke('phone:pull', payload),
  copyPhoneVideos: (payload) => ipcRenderer.invoke('phone:copyVideos', payload),
  distributePhotos: (payload) => ipcRenderer.invoke('phone:distribute', payload),
  pendingWork: () => ipcRenderer.invoke('pending:work'),
  setProgress: (frac) => ipcRenderer.send('progress:set', frac),
  logInteraction: (entry) => ipcRenderer.send('log:interaction', entry),
  findClipsWithPerson: (name) => ipcRenderer.invoke('clips:findByPerson', name),
  retagPerson: (payload) => ipcRenderer.invoke('clips:retagPerson', payload),
  tagPersonOnClips: (payload) => ipcRenderer.invoke('clips:tagPerson', payload),
  untagPersonOnClips: (payload) => ipcRenderer.invoke('clips:untagPerson', payload),
  onPhoneCopyProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('phone:copy-progress', listener);
    return () => ipcRenderer.removeListener('phone:copy-progress', listener);
  },

  // Default playback speed (persisted) for the in-app <video> previews
  getPlayerInfo: () => ipcRenderer.invoke('player:info'),
  setSpeed: (speed) => ipcRenderer.invoke('player:setSpeed', speed),

  // Subject history
  getSubjects: () => ipcRenderer.invoke('subjects:get'),
  addSubject: (name) => ipcRenderer.invoke('subjects:add', name),
  removeSubject: (name) => ipcRenderer.invoke('subjects:remove', name),
  getDescriptions: () => ipcRenderer.invoke('descriptions:get'),
  addDescription: (value) => ipcRenderer.invoke('descriptions:add', value),
  getLocations: () => ipcRenderer.invoke('locations:get'),
  addLocation: (name) => ipcRenderer.invoke('locations:add', name),

  // Local AI suggestions (Ollama)
  getAiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSuggest: (payload) => ipcRenderer.invoke('ai:suggest', payload),
  aiPerceive: (payload) => ipcRenderer.invoke('ai:perceive', payload),
  aiImprove: (payload) => ipcRenderer.invoke('ai:improve', payload),
  aiReflect: (payload) => ipcRenderer.invoke('ai:reflect', payload),
  aiPull: (name) => ipcRenderer.invoke('ai:pull', name),
  // Stop the in-flight Ollama request, not just the loop between clips (audit #78).
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  onAiPullProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('ai:pull-progress', listener);
    return () => ipcRenderer.removeListener('ai:pull-progress', listener);
  },
  aiFeedback: (payload) => ipcRenderer.invoke('ai:feedback', payload),
  aiLearnNames: (payload) => ipcRenderer.invoke('ai:learnNames', payload),
  aiLearnEdits: (edits) => ipcRenderer.invoke('ai:learnEdits', edits),
  aiRecordStyleCorrection: (pair) => ipcRenderer.invoke('ai:recordStyleCorrection', pair),
  getFaceScenes: () => ipcRenderer.invoke('faces:getScenes'),
  saveFaceScenes: (list) => ipcRenderer.invoke('faces:saveScenes', list),
  aiAddMemories: (rules) => ipcRenderer.invoke('ai:addMemories', rules),
  aiReplaceMemories: (rules) => ipcRenderer.invoke('ai:replaceMemories', rules),
  aiConsolidateMemories: () => ipcRenderer.invoke('ai:consolidateMemories'),
  aiRefineMemory: (text) => ipcRenderer.invoke('ai:refineMemory', { text }),
  aiImportDoc: (payload) => ipcRenderer.invoke('ai:importDoc', payload),
  aiCatalog: () => ipcRenderer.invoke('ai:catalog'),
  aiDelete: (name) => ipcRenderer.invoke('ai:delete', name),

  // In-app feedback log (Help → Feedback + right-click → Report feedback)
  feedbackAdd: (payload) => ipcRenderer.invoke('feedback:add', payload),
  feedbackList: () => ipcRenderer.invoke('feedback:list'),
  feedbackExport: (payload) => ipcRenderer.invoke('feedback:export', payload),
  feedbackText: (payload) => ipcRenderer.invoke('feedback:text', payload),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  onFeedbackOpen: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('feedback:open', listener);
    return () => ipcRenderer.removeListener('feedback:open', listener);
  },
  // Live per-clip reasoning step ('perceiving' | 'naming' | 'checking') from multi-pass.
  onAiSuggestStep: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('ai:suggest-step', listener);
    return () => ipcRenderer.removeListener('ai:suggest-step', listener);
  },
  onAiMenu: (cb) => {
    // Fired by the right-click AI submenu: 'settings' | 'run-this' | 'analyze' | 'feedback'.
    const map = { 'ai:open-settings': 'settings', 'ai:run-this': 'run-this', 'ai:analyze-selected': 'analyze', 'ai:scan-faces': 'scan-faces', 'ai:feedback-open': 'feedback' };
    const listeners = [];
    for (const [ch, action] of Object.entries(map)) {
      const l = () => cb(action);
      ipcRenderer.on(ch, l);
      listeners.push([ch, l]);
    }
    return () => listeners.forEach(([ch, l]) => ipcRenderer.removeListener(ch, l));
  },
  onAiMemoryUpdated: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('ai:memory-updated', listener);
    return () => ipcRenderer.removeListener('ai:memory-updated', listener);
  },

  // Custom organizing fields (taxonomy) + their remembered value history
  getFields: () => ipcRenderer.invoke('fields:get'),
  setFields: (list) => ipcRenderer.invoke('fields:set', list),
  getFieldHistory: () => ipcRenderer.invoke('fieldHistory:get'),
  addFieldHistory: (id, value) => ipcRenderer.invoke('fieldHistory:add', { id, value }),
  removeFieldHistory: (id, value) => ipcRenderer.invoke('fieldHistory:remove', { id, value }),

  // Rename drafts (in-progress naming, persisted across app restarts)
  getDrafts: () => ipcRenderer.invoke('drafts:get'),
  saveDrafts: (map) => ipcRenderer.invoke('drafts:save', map),
  clearDrafts: (keys) => ipcRenderer.invoke('drafts:clear', keys),

  // Version history / save points (full naming snapshots to roll back to)
  appVersion: () => ipcRenderer.invoke('app:version'),
  changelog: () => ipcRenderer.invoke('changelog:get'),
  getVersions: () => ipcRenderer.invoke('versions:get'),
  saveVersion: (entry) => ipcRenderer.invoke('versions:save', entry),
  deleteVersion: (id) => ipcRenderer.invoke('versions:delete', id),
  clearVersions: () => ipcRenderer.invoke('versions:clear'),

  // Metadata-by-final-filename (persisted when a copy completes, matched at Finalize)
  saveFinalMeta: (map) => ipcRenderer.invoke('finalMeta:save', map),
  getFinalMeta: () => ipcRenderer.invoke('finalMeta:get'),

  // Destination map — real Projects folder tree + AI placement + move
  getProjectsRoot: () => ipcRenderer.invoke('projects:getRoot'),
  setProjectsRoot: (p) => ipcRenderer.invoke('projects:setRoot', p),
  pickProjectsRoot: () => ipcRenderer.invoke('projects:pickRoot'),
  getProjectsTree: (root) => ipcRenderer.invoke('projects:tree', root),
  projectsInnerLayout: (rel) => ipcRenderer.invoke('projects:innerLayout', { rel }),
  projectsMove: (payload) => ipcRenderer.invoke('projects:move', payload),
  // Ask where clips WOULD file, without filing them — same ladder finalize:run uses.
  organizePreviewDest: (payload) => ipcRenderer.invoke('organize:previewDest', payload),
  organizeUndoInfo: () => ipcRenderer.invoke('organize:undoInfo'),
  organizeUndo: () => ipcRenderer.invoke('organize:undo'),
  ledgerGet: () => ipcRenderer.invoke('ledger:get'),
  ledgerRecord: (payload) => ipcRenderer.invoke('ledger:record', payload),
  ledgerMatchDates: (payload) => ipcRenderer.invoke('ledger:matchDates', Array.isArray(payload) ? { dates: payload } : (payload || {})),
  ledgerSummarize: (rel) => ipcRenderer.invoke('ledger:summarize', { rel }),
  aiSuggestProjects: (payload) => ipcRenderer.invoke('ai:suggestProjects', payload),
  // TOOL-BASED AI. The model chooses a tool; the tool does the work deterministically.
  // ai:placeGroup answers "where does this shoot go?" by SEARCHING the real tree and READING what's
  // actually inside a project — instead of guessing from a list of folder names in a giant prompt.
  aiPlaceGroup: (group) => ipcRenderer.invoke('ai:placeGroup', group),
  aiNameFromObservation: (payload) => ipcRenderer.invoke('ai:nameFromObservation', payload),
  // Teach the ledger what's ALREADY in the Projects tree — it was only ever written after this app
  // filed something, so an existing library was invisible to the AI.
  aiBackfillLedger: (root) => ipcRenderer.invoke('ai:backfillLedger', root),
  // ASK ONCE, THEN KNOW. Confirming a placement teaches it permanently; recall answers next time with
  // no model call at all.
  aiRememberPlacement: (p) => ipcRenderer.invoke('ai:rememberPlacement', p),
  aiForgetPlacement: (p) => ipcRenderer.invoke('ai:forgetPlacement', p),
  // Shoot memory — ask once per shoot, then never again.
  aiRememberShoot: (p) => ipcRenderer.invoke('ai:rememberShoot', p),
  aiRecallShoot: (date) => ipcRenderer.invoke('ai:recallShoot', date),
  aiShootsToAsk: (dates) => ipcRenderer.invoke('ai:shootsToAsk', dates),
  aiRecallPlacement: (p) => ipcRenderer.invoke('ai:recallPlacement', p),
  // AI health: the four things that were silently wrong in the real config.
  aiHealth: () => ipcRenderer.invoke('ai:health'),
  // VRAM residency — one model at a time, and hand it back when the run ends.
  aiUseOnly: (model) => ipcRenderer.invoke('ai:useOnly', model),
  aiRelease: () => ipcRenderer.invoke('ai:release'),
  aiLoaded: () => ipcRenderer.invoke('ai:loaded'),
  aiVisionAdvice: () => ipcRenderer.invoke('ai:visionAdvice'),
  aiUseVisionModel: (name) => ipcRenderer.invoke('ai:useVisionModel', name),
  aiLearnFromLibrary: (dirs) => ipcRenderer.invoke('ai:learnFromLibrary', dirs),
  aiAnswerSubjects: (payload) => ipcRenderer.invoke('ai:answerSubjects', payload),

  // People / face recognition (descriptors computed in the renderer via face-api.js)
  getPeople: () => ipcRenderer.invoke('people:get'),
  storePersistFailures: () => ipcRenderer.invoke('stores:persistFailures'),
  onStorePersistFailed: (cb) => {
    const listener = (_e, info) => cb(info);
    ipcRenderer.on('store:persist-failed', listener);
    return () => ipcRenderer.removeListener('store:persist-failed', listener);
  },
  savePerson: (payload) => ipcRenderer.invoke('people:save', payload),
  undoAssignPerson: (receipt) => ipcRenderer.invoke('people:undoAssign', receipt),
  getPendingFaces: () => ipcRenderer.invoke('faces:getPending'),
  savePendingFaces: (list) => ipcRenderer.invoke('faces:savePending', list),
  renamePerson: (payload) => ipcRenderer.invoke('people:rename', payload),
  deletePerson: (id) => ipcRenderer.invoke('people:delete', id),
  matchPerson: (payload) => ipcRenderer.invoke('people:match', payload),
  matchPeopleBatch: (payload) => ipcRenderer.invoke('people:matchBatch', payload),
  facesImage: (payload) => ipcRenderer.invoke('faces:image', payload),
  facesFrames: (payload) => ipcRenderer.invoke('faces:frames', payload),
  personDetail: (id) => ipcRenderer.invoke('people:detail', id),
  mergePerson: (payload) => ipcRenderer.invoke('people:merge', payload),
  removePersonFace: (payload) => ipcRenderer.invoke('people:removeFace', payload),
  setPersonCover: (payload) => ipcRenderer.invoke('people:setCover', payload),
  confirmFace: (payload) => ipcRenderer.invoke('people:confirmFace', payload),
  reassignFace: (payload) => ipcRenderer.invoke('people:reassignFace', payload),
  ignoreFace: (payload) => ipcRenderer.invoke('faces:ignore', payload),
  listIgnoredFaces: () => ipcRenderer.invoke('faces:listIgnored'),
  unignoreFace: (idx) => ipcRenderer.invoke('faces:unignore', idx),
  ignoredCount: () => ipcRenderer.invoke('faces:ignoredCount'),

  // Standing filing rules + plain-English rule parsing + per-clip analysis cache
  getRoutes: () => ipcRenderer.invoke('routes:get'),
  saveRoutes: (list) => ipcRenderer.invoke('routes:save', list),
  aiParseRules: (payload) => ipcRenderer.invoke('ai:parseRules', payload),
  getClipObs: () => ipcRenderer.invoke('clipObs:get'),
  saveClipObs: (payload) => ipcRenderer.invoke('clipObs:save', payload),

  // Finalize / Organize
  getFinalizeSource: () => ipcRenderer.invoke('finalize:getSource'),
  pickFinalizeSource: () => ipcRenderer.invoke('finalize:pickSource'),
  finalizeScan: (dir, opts) => ipcRenderer.invoke('finalize:scan', opts ? { dir, ...opts } : dir),
  finalizeRun: (payload) => ipcRenderer.invoke('finalize:run', payload),
  onFinalizeProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('finalize:progress', listener);
    return () => ipcRenderer.removeListener('finalize:progress', listener);
  },

  // In-app compression (ffmpeg)
  compressDefaults: () => ipcRenderer.invoke('compress:defaults'),
  compressList: (dir) => ipcRenderer.invoke('compress:list', dir),
  compressRun: (payload) => ipcRenderer.invoke('compress:run', payload),
  compressCancel: () => ipcRenderer.invoke('compress:cancel'),
  onCompressProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('compress:progress', listener);
    return () => ipcRenderer.removeListener('compress:progress', listener);
  },

  // (Removed: quit:confirm/quit:decision handshake — rename work auto-saves
  // continuously now, so quitting just quits; the main side has no such emitter.)
  debugInfo: () => ipcRenderer.invoke('debug:info'),

  // Pop-out preview window
  togglePreview: () => ipcRenderer.invoke('preview:toggle'),
  previewState: () => ipcRenderer.invoke('preview:state'),
  previewSet: (filePath, name, opts) => ipcRenderer.invoke('preview:set', { path: filePath, name, ...(opts || {}) }),
  // Grid-wall mode: the main window pushes the list of clips in scope.
  previewList: (clips) => ipcRenderer.invoke('preview:list', { clips }),
  // View config (mode / tile size / source / play-videos / mute) — persisted by main.
  previewConfig: (patch) => ipcRenderer.invoke('preview:config', patch || {}),
  previewMode: (mode) => ipcRenderer.invoke('preview:mode', mode),
  // Preview window → main window: focus/scroll to a clip when a grid tile is clicked.
  previewJump: (i) => ipcRenderer.invoke('preview:jump', i),
  // Preview window announces it has (re)loaded and wants the current state.
  previewReady: () => ipcRenderer.invoke('preview:ready'),
  onPreviewUpdate: (cb) => {
    const listener = (_evt, d) => cb(d);
    ipcRenderer.on('preview:update', listener);
    return () => ipcRenderer.removeListener('preview:update', listener);
  },
  onPreviewList: (cb) => {
    const listener = (_evt, d) => cb(d);
    ipcRenderer.on('preview:list', listener);
    return () => ipcRenderer.removeListener('preview:list', listener);
  },
  onPreviewConfig: (cb) => {
    const listener = (_evt, d) => cb(d);
    ipcRenderer.on('preview:config', listener);
    return () => ipcRenderer.removeListener('preview:config', listener);
  },
  onPreviewJump: (cb) => {
    const listener = (_evt, i) => cb(i);
    ipcRenderer.on('preview:jump', listener);
    return () => ipcRenderer.removeListener('preview:jump', listener);
  },
  onPreviewClosed: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('preview:closed', listener);
    return () => ipcRenderer.removeListener('preview:closed', listener);
  },

  // Intake (compression) folder
  getIntake: () => ipcRenderer.invoke('intake:get'),
  pickIntakeFolder: () => ipcRenderer.invoke('intake:pick'),
  pickFolder: (opts) => ipcRenderer.invoke('folder:pick', opts),
  pickFile: (opts) => ipcRenderer.invoke('file:pick', opts),
  pickImages: () => ipcRenderer.invoke('image:pick'),
  setIntake: (folder) => ipcRenderer.invoke('intake:set', folder),

  // Rename + delete
  applyRename: (destPath, newName) => ipcRenderer.invoke('rename:apply', { destPath, newName }),
  // delete:source takes {source, dest} PAIRS — it re-verifies every file itself and refuses a
  // bare path, which carries no proof a copy exists. See main-mod/09-ipc-boot.js.
  deleteSource: (items) => ipcRenderer.invoke('delete:source', items),
  // Durable "what did I copy off this card, and where did it land" — so the Delete step still
  // works days later, in a different session, without re-copying the whole card.
  recordCopied: (entries) => ipcRenderer.invoke('copied:record', entries),
  getCopied: (keys) => ipcRenderer.invoke('copied:get', keys),
  forgetCopied: (keys) => ipcRenderer.invoke('copied:forget', keys),
  // The AI's outstanding review questions — so quitting before the review doesn't lose it.
  saveAiQueue: (list) => ipcRenderer.invoke('aiq:save', list),
  getAiQueue: () => ipcRenderer.invoke('aiq:get'),
  // Is the card still physically there? Asked when a file fails, so a yanked card is diagnosed
  // once and correctly instead of sixty times as sixty imaginary model timeouts.
  drivePresent: (mountpoint) => ipcRenderer.invoke('drive:present', mountpoint),
  onDriveRemoved: (fn) => {
    const listener = (_e, p) => fn(p);
    ipcRenderer.on('drive:removed', listener);
    return () => ipcRenderer.removeListener('drive:removed', listener);
  },
  verifyCopies: (pairs) => ipcRenderer.invoke('verify:copies', pairs),
  onVerifyProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('verify:progress', listener);
    return () => ipcRenderer.removeListener('verify:progress', listener);
  },
  freeSpace: (folder) => ipcRenderer.invoke('disk:freeSpace', folder),
  importsGet: () => ipcRenderer.invoke('imports:get'),
  importsAdd: (keys) => ipcRenderer.invoke('imports:add', { keys }),
  pathExists: (p) => ipcRenderer.invoke('path:exists', p)
});
