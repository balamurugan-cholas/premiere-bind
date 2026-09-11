(function (global) {
  'use strict';
  function CSInterface() {}
  CSInterface.prototype.evalScript = function (script, callback) {
    if (global.__adobe_cep__ && typeof global.__adobe_cep__.evalScript === 'function') {
      global.__adobe_cep__.evalScript(script, callback || function () {});
      return;
    }
    if (callback) callback('EvalScript error.');
  };
  CSInterface.prototype.getSystemPath = function (pathType) {
    if (!global.__adobe_cep__ || typeof global.__adobe_cep__.getSystemPath !== 'function') return '';
    return global.__adobe_cep__.getSystemPath(pathType);
  };
  global.SystemPath = { EXTENSION: 'extension', USER_DATA: 'userData' };
  global.CSInterface = CSInterface;
})(window);
