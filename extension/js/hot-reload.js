(function () {
  'use strict';
  var source = new EventSource('http://127.0.0.1:8094/events');
  function status(message) {
    var label = document.getElementById('footer-status');
    if (label) label.textContent = message;
  }
  source.addEventListener('open', function () {
    status('Live reload on · UI preview');
  });
  source.addEventListener('error', function () {
    status('Live reload offline · UI preview');
  });
  source.addEventListener('reload', function () {
    window.setTimeout(function () { window.location.reload(); }, 80);
  });
  window.addEventListener('beforeunload', function () { source.close(); });
})();
