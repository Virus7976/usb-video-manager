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
  scanPhone: (name) => ipcRenderer.invoke('phone:scan', name),
  pullFromPhone: (payload) => ipcRenderer.invoke('phone:pull', payload),
  copyPhoneVideos: (payload) => ipcRenderer.invoke('phone:copyVideos', payload),
  distributePhotos: (payload) => ipcRenderer.invoke('phone:distribute', payload),
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
  onAiPullProgress: (cb) => {
    const listener = (_evt, p) => cb(p);
    ipcRenderer.on('ai:pull-progress', listener);
    return () => ipcRenderer.removeListener('ai:pull-progress', listener);
  },
  aiFeedback: (payload) => ipcRenderer.invoke('ai:feedback', payload),
  aiLearnNames: (payload) => ipcRenderer.invoke('ai:learnNames', payload),
  aiLearnEdits: (edits) => ipcRenderer.invoke('ai:learnEdits', edits),
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
    const map = { 'ai:open-settings': 'settings', 'ai:run-this': 'run-this', 'ai:analyze-selected': 'analyze', 'ai:feedback-open': 'feedback' };
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
  organizeUndoInfo: () => ipcRenderer.invoke('organize:undoInfo'),
  organizeUndo: () => ipcRenderer.invoke('organize:undo'),
  ledgerGet: () => ipcRenderer.invoke('ledger:get'),
  ledgerRecord: (payload) => ipcRenderer.invoke('ledger:record', payload),
  ledgerMatchDates: (payload) => ipcRenderer.invoke('ledger:matchDates', Array.isArray(payload) ? { dates: payload } : (payload || {})),
  ledgerSummarize: (rel) => ipcRenderer.invoke('ledger:summarize', { rel }),
  aiSuggestProjects: (payload) => ipcRenderer.invoke('ai:suggestProjects', payload),
  aiBatchQuestions: (payload) => ipcRenderer.invoke('ai:batchQuestions', payload),
  aiAnswerSubjects: (payload) => ipcRenderer.invoke('ai:answerSubjects', payload),

  // People / face recognition (descriptors computed in the renderer via face-api.js)
  getPeople: () => ipcRenderer.invoke('people:get'),
  savePerson: (payload) => ipcRenderer.invoke('people:save', payload),
  renamePerson: (payload) => ipcRenderer.invoke('people:rename', payload),
  deletePerson: (id) => ipcRenderer.invoke('people:delete', id),
  matchPerson: (payload) => ipcRenderer.invoke('people:match', payload),
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
  aiParseRoute: (payload) => ipcRenderer.invoke('ai:parseRoute', payload),
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

  // Quit confirmation (main asks the renderer when there's unsaved rename work)
  onQuitConfirm: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('quit:confirm', listener);
    return () => ipcRenderer.removeListener('quit:confirm', listener);
  },
  sendQuitDecision: (decision) => ipcRenderer.send('quit:decision', decision),
  debugInfo: () => ipcRenderer.invoke('debug:info'),

  // Pop-out preview window
  togglePreview: () => ipcRenderer.invoke('preview:toggle'),
  previewState: () => ipcRenderer.invoke('preview:state'),
  previewSet: (filePath, name, opts) => ipcRenderer.invoke('preview:set', { path: filePath, name, ...(opts || {}) }),
  onPreviewUpdate: (cb) => {
    const listener = (_evt, d) => cb(d);
    ipcRenderer.on('preview:update', listener);
    return () => ipcRenderer.removeListener('preview:update', listener);
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
  deleteSource: (sourcePaths) => ipcRenderer.invoke('delete:source', sourcePaths),
  verifyCopies: (pairs) => ipcRenderer.invoke('verify:copies', pairs),
  freeSpace: (folder) => ipcRenderer.invoke('disk:freeSpace', folder),
  importsGet: () => ipcRenderer.invoke('imports:get'),
  importsAdd: (keys) => ipcRenderer.invoke('imports:add', { keys })
});
