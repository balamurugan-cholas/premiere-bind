(function (global) {
  'use strict';
  var cs = new CSInterface();
  var ready = false;

  function hostError(code, message, details) {
    var error = new Error(message || 'Premiere host call failed.');
    error.code = code || 'HOST_ERROR';
    error.details = details || null;
    return error;
  }

  function parseResult(raw) {
    if (!raw || raw === 'EvalScript error.') throw hostError('EVAL_SCRIPT_ERROR', 'Premiere did not evaluate the host request.');
    var result;
    try { result = JSON.parse(raw); }
    catch (_) { throw hostError('INVALID_HOST_RESPONSE', 'Premiere returned an invalid host response.', { raw: String(raw) }); }
    if (!result.ok) {
      var info = result.error || {};
      throw hostError(info.code, info.message, info.details);
    }
    return result.data;
  }

  function extensionPath() {
    return decodeURI(cs.getSystemPath(SystemPath.EXTENSION) || '')
      .replace(/^file:\/\/\/([A-Za-z]:)/, '$1')
      .replace(/^file:\/\//, '')
      .replace(/\\/g, '/');
  }

  function loadHost() {
    return new Promise(function (resolve, reject) {
      var root = extensionPath();
      if (!root) { reject(hostError('CEP_UNAVAILABLE', 'CEP extension path is unavailable.')); return; }
      var path = (root + '/jsx/host.jsx').replace(/'/g, "\\'");
      var markerPath = (root + '/jsx/markers.jsx').replace(/'/g, "\\'");
      var nativePath = (root + '/jsx/native-library.jsx').replace(/'/g, "\\'");
      cs.evalScript("$.evalFile(File('" + path + "')); $.evalFile(File('" + markerPath + "')); $.evalFile(File('" + nativePath + "')); typeof PremiereBindHost !== 'undefined' && typeof PremiereBindHost.getMarkerPlan === 'function' && typeof PremiereBindHost.beginNativeInsert === 'function' ? 'READY' : 'NOT_READY'", function (raw) {
        ready = raw === 'READY';
        if (ready) resolve(true);
        else reject(hostError('HOST_LOAD_FAILED', 'PremiereBind host script could not be loaded.', { raw: raw }));
      });
    });
  }

  function call(method, payload, retried) {
    var begin = ready ? Promise.resolve() : loadHost();
    return begin.then(function () {
      return new Promise(function (resolve, reject) {
        var methodJson = JSON.stringify(String(method));
        var payloadJson = JSON.stringify(JSON.stringify(payload || {}));
        cs.evalScript('PremiereBindHost.dispatch(' + methodJson + ',' + payloadJson + ')', function (raw) {
          try { resolve(parseResult(raw)); }
          catch (error) {
            if (!retried && error.code === 'EVAL_SCRIPT_ERROR') {
              ready = false;
              loadHost().then(function () { return call(method, payload, true); }).then(resolve, reject);
            } else reject(error);
          }
        });
      });
    });
  }

  global.PremiereBindBridge = {
    call: call,
    ping: function () { return call('ping'); },
    readTimelineSelection: function () { return call('readTimelineSelection'); },
    saveProject: function () { return call('saveProject'); },
    insertPresetAtPlayhead: function (payload) { return call('insertPresetAtPlayhead', payload); },
    applyTransitions: function (payload) { return call('applyTransitions', payload); },
    resolveInsertionTargets: function (payload) {
      payload = payload || {};
      if (String(payload.mode || 'playhead') === 'playhead' && payload.playSnap && payload.playSnap.enabled && payload.playSnap.mode) {
        var resolved = {}, key;
        for (key in payload) if (Object.prototype.hasOwnProperty.call(payload, key)) resolved[key] = payload[key];
        resolved.mode = payload.playSnap.mode;
        resolved.snapHover = true;
        payload = resolved;
      }
      return call('resolveInsertionTargets', payload);
    },
    getActiveSequenceTracks: function () { return call('getActiveSequenceTracks'); },
    chooseExportPath: function (suggestedName) { return call('chooseExportPath', { suggestedName:suggestedName }); },
    chooseImportPath: function () { return call('chooseImportPath'); },
    captureNativeLibrary: function (payload) { return call('captureNativeLibrary', payload); },
    beginNativeInsert: function (payload) { return call('beginNativeInsert', payload); },
    prepareNativeInsertTarget: function (payload) { return call('prepareNativeInsertTarget', payload); },
    confirmNativeInsertTarget: function (payload) { return call('confirmNativeInsertTarget', payload); },
    completeNativeInsert: function (payload) { return call('completeNativeInsert', payload); },
    reloadHost: function () { ready = false; return loadHost(); },
    isCEP: function () { return Boolean(global.__adobe_cep__); }
  };

  function reportDevelopment(result) {
    try {
      fetch('http://127.0.0.1:8094/host-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      }).catch(function () {});
    } catch (_) {}
  }

  function reportSelectionDevelopment(result) {
    try {
      fetch('http://127.0.0.1:8094/selection-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      }).catch(function () {});
    } catch (_) {}
  }

  if (global.__adobe_cep__) {
    global.PremiereBindBridge.ping().then(function (info) {
      document.body.dataset.hostReady = 'true';
      reportDevelopment({ ok: true, data: info });
      global.dispatchEvent(new CustomEvent('premierebind:host-ready', { detail: info }));
      global.PremiereBindBridge.readTimelineSelection().then(function (selection) {
        reportSelectionDevelopment({ ok: true, data: selection });
        global.dispatchEvent(new CustomEvent('premierebind:selection-read', { detail: selection }));
      }).catch(function (error) {
        reportSelectionDevelopment({ ok: false, error: { code: error.code, message: error.message, details: error.details || null } });
        console.error('[PremiereBind] Selection reader:', error.code, error.message, error.details || '');
        global.dispatchEvent(new CustomEvent('premierebind:selection-error', { detail: { code: error.code, message: error.message } }));
      });
    }).catch(function (error) {
      document.body.dataset.hostReady = 'false';
      reportDevelopment({ ok: false, error: { code: error.code, message: error.message, details: error.details || null } });
      console.error('[PremiereBind] Host bridge:', error.code, error.message, error.details || '');
      global.dispatchEvent(new CustomEvent('premierebind:host-error', { detail: { code: error.code, message: error.message } }));
    });
  }
})(window);















