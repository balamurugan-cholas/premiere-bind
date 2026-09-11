(function (global) {
  'use strict';
  var PROFILE_FILENAME = 'premierebind-profiles-v1.json';
  var LEGACY_PRESET_FILENAME = 'premierebind-presets-v2.json';
  var DATA_FOLDER_NAME = 'PremiereBind';
  var writeQueue = Promise.resolve();
  var currentLibrary = null;

  function storageError(code, message, details) {
    var error = new Error(message);
    error.code = code;
    error.details = details || null;
    return error;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizePath(raw) {
    var path = decodeURI(String(raw || ''))
      .replace(/^file:\/\/\/([A-Za-z]:)/, '$1')
      .replace(/^file:\/\//, '')
      .replace(/\\/g, '/');
    return path.replace(/\/+$/, '');
  }

  function joinPath(root, name) {
    return root + '/' + name;
  }

  function defaultLibrary(presets) {
    return {
      version: 1,
      activeProfileId: 'profile-1',
      insertAlignment: 'center',
      accentColor: '#b6a2fa',
      searchShortcut: 'Shift+F',
      saveShortcut: 'Shift+S',
      tooltipsEnabled: true,
      tooltipsConfigured: false,
      playSnap: undefined,
      hoverPlayback: true,
      showScrollbars: true,
      confirmSelectionDelete: true,
      profiles: [{ id: 'profile-1', label: 'Profile 1', presets: Array.isArray(presets) ? presets : [] }]
    };
  }

  function jsonSafe(value, depth) {
    if (depth > 30 || value === null || typeof value === 'undefined') return value === null ? null : undefined;
    var type = typeof value;
    if (type === 'string' || type === 'boolean') return value;
    if (type === 'number') return isFinite(value) ? value : null;
    if (type === 'function') return undefined;
    if (Array.isArray(value)) return value.map(function (item) { return jsonSafe(item, depth + 1); }).filter(function (item) { return typeof item !== 'undefined'; });
    if (type === 'object') {
      var result = {};
      Object.keys(value).forEach(function (key) {
        if (key.charAt(0) === '_') return;
        var item = jsonSafe(value[key], depth + 1);
        if (typeof item !== 'undefined') result[key] = item;
      });
      return result;
    }
    return undefined;
  }

  function normalizePreset(item) {
    item = jsonSafe(item || {}, 0) || {};
    var isFolder = Boolean(item.isFolder || Array.isArray(item.presets));
    item.id = typeof item.id === 'string' && item.id ? item.id : 'preset-' + Date.now();
    item.title = typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 100) : 'Saved selection';
    item.isFolder = isFolder;
    item.shortcut = typeof item.shortcut === 'string' ? item.shortcut : '';
    item.shuffle = item.shuffle === true;
    item.shuffleBag = isFolder && Array.isArray(item.shuffleBag) ? item.shuffleBag.filter(function (id, index, list) { return typeof id === 'string' && list.indexOf(id) === index; }) : [];
    item.lastPickedPresetId = isFolder && typeof item.lastPickedPresetId === 'string' ? item.lastPickedPresetId : '';
    item.sequenceIndex = isFolder ? Math.max(0, Number(item.sequenceIndex) || 0) : 0;
    item.targetMode = typeof item.targetMode === 'string' ? item.targetMode : 'playhead';
    item.targetColorId = typeof item.targetColorId === 'string' ? item.targetColorId : '';
    item.targetName = typeof item.targetName === 'string' ? item.targetName : '';
    item.presets = isFolder && Array.isArray(item.presets) ? item.presets.map(normalizePreset) : undefined;
    item.children = Array.isArray(item.children) ? item.children : [];
    item.selectionFolders = Array.isArray(item.selectionFolders) ? item.selectionFolders : [];
    item.transitions = Array.isArray(item.transitions) ? item.transitions : [];
    var presetItems = [];
    item.children.forEach(function (category) { (category && category.items || []).forEach(function (clip) { presetItems.push(clip); }); });
    item.transitions.forEach(function (transition) {
      if (!transition || transition.ownerItemId) return;
      var owner = presetItems.filter(function (clip) {
        var source = clip && clip.source || {};
        return (source.type === 'audio' ? 'audio' : 'video') === (transition.type === 'audio' ? 'audio' : 'video')
          && Number(source.trackIndex) === Number(transition.trackIndex)
          && Math.abs(Number(clip.sourceStartSeconds || source.startSeconds || 0) - Number(transition.ownerSourceStartSeconds || 0)) < 0.00001
          && (!transition.ownerSourceName || String(clip.title) === String(transition.ownerSourceName));
      })[0];
      transition.ownerItemId = owner ? owner.id : '';
    });
    item.children.forEach(function (category) {
      var groups = category && Array.isArray(category.randomizerGroups) ? category.randomizerGroups : [];
      var targets = {};
      groups.forEach(function (group) { if (group && group.id) targets[group.id] = String(group.targetTrack || 'Smart'); });
      (category && category.items || []).forEach(function (clip) {
        if (!clip || !clip.randomizerGroupId || !targets[clip.randomizerGroupId]) return;
        if (!clip.source || typeof clip.source !== 'object') clip.source = {};
        clip.source.randomizerTargetTrack = targets[clip.randomizerGroupId];
      });
    });
    return item;
  }

  function normalizeLibrary(library) {
    var rawProfiles = library && Array.isArray(library.profiles) ? library.profiles : [];
    if (!rawProfiles.length) return defaultLibrary();
    var ids = {};
    var profiles = rawProfiles.map(function (profile, index) {
      profile = profile || {};
      var baseId = typeof profile.id === 'string' && profile.id.trim() ? profile.id.trim() : 'profile-' + (index + 1);
      var id = baseId;
      var suffix = 2;
      while (ids[id]) id = baseId + '-' + suffix++;
      ids[id] = true;
      return {
        id: id,
        label: typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim().slice(0, 40) : 'Profile ' + (index + 1),
        presets: Array.isArray(profile.presets) ? profile.presets.map(normalizePreset) : []
      };
    });
    var requested = library && library.activeProfileId;
    return {
      version: 1,
      activeProfileId: profiles.some(function (profile) { return profile.id === requested; }) ? requested : profiles[0].id,
      insertAlignment: library && ['left','center','right'].indexOf(library.insertAlignment) >= 0 ? library.insertAlignment : 'center',
      accentColor: library && typeof library.accentColor === 'string' ? library.accentColor : '#b6a2fa',
      searchShortcut: library && typeof library.searchShortcut === 'string' && library.searchShortcut.trim() ? library.searchShortcut.trim() : 'Shift+F',
      saveShortcut: library && typeof library.saveShortcut === 'string' && library.saveShortcut.trim() ? library.saveShortcut.trim() : 'Shift+S',
      tooltipsEnabled: !(library && library.tooltipsConfigured === true && library.tooltipsEnabled === false),
      tooltipsConfigured: Boolean(library && library.tooltipsConfigured === true),
      playSnap: library && library.playSnap ? jsonSafe(library.playSnap, 0) : undefined,
      hoverPlayback: !library || library.hoverPlayback !== false,
      showScrollbars: !library || library.showScrollbars !== false,
      confirmSelectionDelete: !library || library.confirmSelectionDelete !== false,
      profiles: profiles
    };
  }

  function cepFs() {
    if (!global.cep || !global.cep.fs || !global.__adobe_cep__) throw storageError('CEP_FS_UNAVAILABLE', 'CEP filesystem access is unavailable.');
    return global.cep.fs;
  }

  function dataFolder() {
    var cs = new CSInterface();
    var root = normalizePath(cs.getSystemPath(SystemPath.USER_DATA));
    if (!root) throw storageError('USER_DATA_UNAVAILABLE', 'CEP user-data path is unavailable.');
    return joinPath(root, DATA_FOLDER_NAME);
  }

  function ensureFolder() {
    var fs = cepFs();
    var folder = dataFolder();
    var result = fs.stat(folder);
    if (result.err === 0) return folder;
    result = fs.makedir(folder);
    if (result.err !== 0 && fs.stat(folder).err !== 0) throw storageError('CREATE_FOLDER_FAILED', 'Could not create the PremiereBind data folder.', { path: folder, error: result.err });
    return folder;
  }

  function readText(filename) {
    var fs = cepFs();
    var path = joinPath(ensureFolder(), filename);
    var result = fs.readFile(path, global.cep.encoding.UTF8);
    if (result.err === 3 || result.err === 2 || result.err === 30) return null;
    if (result.err !== 0) throw storageError('READ_FAILED', 'Could not read ' + filename + '.', { path: path, error: result.err });
    return String(result.data || '');
  }

  function writeText(filename, content) {
    var fs = cepFs();
    var folder = ensureFolder();
    var path = joinPath(folder, filename);
    var previous = fs.readFile(path, global.cep.encoding.UTF8);
    if (previous.err === 0) {
      var preserve = true;
      if (filename === PROFILE_FILENAME) {
        try { JSON.parse(previous.data); } catch (_) { preserve = false; }
      }
      if (preserve) fs.writeFile(path + '.backup', previous.data, global.cep.encoding.UTF8);
    }
    var result = fs.writeFile(path, String(content), global.cep.encoding.UTF8);
    if (result.err !== 0) throw storageError('WRITE_FAILED', 'Could not save ' + filename + '.', { path: path, error: result.err });
    return path;
  }

  function readJson(filename) {
    var raw = readText(filename);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (error) {
      throw storageError('CORRUPT_LIBRARY', filename + ' contains invalid JSON.', { cause: error.message });
    }
  }

  function load() {
    return Promise.resolve().then(function () {
      var library = null;
      try { library = readJson(PROFILE_FILENAME); }
      catch (primaryError) {
        if (primaryError.code !== 'CORRUPT_LIBRARY') throw primaryError;
        try { library = readJson(PROFILE_FILENAME + '.backup'); }
        catch (_) { library = null; }
      }
      if (!library || !Array.isArray(library.profiles)) {
        var legacy = null;
        try { legacy = readJson(LEGACY_PRESET_FILENAME); } catch (_) {}
        library = defaultLibrary(Array.isArray(legacy) ? legacy : []);
      }
      currentLibrary = normalizeLibrary(library);
      return clone(currentLibrary);
    });
  }

  function save(library) {
    var snapshot = normalizeLibrary(library || currentLibrary);
    writeQueue = writeQueue.catch(function () {}).then(function () {
      writeText(PROFILE_FILENAME, JSON.stringify(snapshot));
      currentLibrary = snapshot;
      return clone(currentLibrary);
    });
    return writeQueue;
  }

  function update(mutator) {
    return (currentLibrary ? Promise.resolve(clone(currentLibrary)) : load()).then(function (draft) {
      var result = mutator(draft);
      return save(result || draft);
    });
  }

  function selfTest() {
    return Promise.resolve().then(function () {
      var fs = cepFs();
      var path = joinPath(ensureFolder(), 'premierebind-storage-test.json');
      var token = String(Date.now());
      var sample = defaultLibrary([{ id:'test-preset', title:'Storage test', _runtimeTask:'must not persist' }]);
      sample.testToken = token;
      var normalized = normalizeLibrary(sample);
      var written = fs.writeFile(path, JSON.stringify(normalized), global.cep.encoding.UTF8);
      if (written.err !== 0) throw storageError('SELF_TEST_WRITE_FAILED', 'Storage test could not write.', { error: written.err });
      var read = fs.readFile(path, global.cep.encoding.UTF8);
      var restored = read.err === 0 ? normalizeLibrary(JSON.parse(read.data)) : null;
      var preset = restored && restored.profiles[0] && restored.profiles[0].presets[0];
      if (!restored || restored.version !== 1 || !preset || preset.title !== 'Storage test' || typeof preset._runtimeTask !== 'undefined') {
        throw storageError('SELF_TEST_READ_FAILED', 'Storage test could not verify a normalized library round trip.', { error: read.err });
      }
      fs.deleteFile(path);
      return { ok: true, schemaVersion: restored.version, runtimeDataStripped: true, dataFolder: dataFolder(), profileFile: joinPath(dataFolder(), PROFILE_FILENAME) };
    });
  }

  global.PremiereBindStorage = {
    filenames: { profiles: PROFILE_FILENAME, legacyPresets: LEGACY_PRESET_FILENAME },
    createDefault: defaultLibrary,
    normalize: normalizeLibrary,
    load: load,
    save: save,
    update: update,
    selfTest: selfTest,
    get: function () { return currentLibrary ? clone(currentLibrary) : null; },
    getDataFolder: dataFolder
  };

  if (global.__adobe_cep__) {
    load().then(function (library) {
      return selfTest().then(function (test) {
        global.dispatchEvent(new CustomEvent('premierebind:library-ready', { detail: library }));
        try { fetch('http://127.0.0.1:8094/storage-report', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ok:true,test:test,profiles:library.profiles.length}) }); } catch (_) {}
      });
    }).catch(function (error) {
      console.error('[PremiereBind] Storage:', error.code, error.message, error.details || '');
      global.dispatchEvent(new CustomEvent('premierebind:library-error', { detail:{code:error.code,message:error.message} }));
      try { fetch('http://127.0.0.1:8094/storage-report', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ok:false,error:{code:error.code,message:error.message,details:error.details||null}}) }); } catch (_) {}
    });
  }
})(window);
