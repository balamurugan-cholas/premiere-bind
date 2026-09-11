/* PremiereBind host-synchronized panel skin. */
(function (global) {
  'use strict';
  var cs = null;
  try { cs = new CSInterface(); } catch (_) {}

  function clamp(value) { return Math.max(0, Math.min(255, Math.round(value))); }
  function rgb(value) {
    value = value || {};
    return { r:clamp(value.red), g:clamp(value.green), b:clamp(value.blue) };
  }
  function mix(color, amount) {
    var target = amount < 0 ? 0 : 255;
    var weight = Math.abs(amount);
    return 'rgb(' + clamp(color.r + (target - color.r) * weight) + ',' + clamp(color.g + (target - color.g) * weight) + ',' + clamp(color.b + (target - color.b) * weight) + ')';
  }
  function apply() {
    var environment = null;
    try { environment = cs && cs.getHostEnvironment(); } catch (_) {}
    var skin = environment && environment.appSkinInfo;
    var base = rgb(skin && skin.panelBackgroundColor && skin.panelBackgroundColor.color || { red:31, green:31, blue:31 });
    var root = document.documentElement.style;
    root.setProperty('--pr-panel', mix(base, 0));
    root.setProperty('--pr-sidebar', mix(base, -0.08));
    root.setProperty('--pr-header', mix(base, -0.055));
    root.setProperty('--pr-control', mix(base, 0.035));
    root.setProperty('--pr-raised', mix(base, 0.065));
    root.setProperty('--pr-hover', mix(base, 0.095));
    root.setProperty('--pr-border', mix(base, base.r < 80 ? 0.085 : -0.12));
    root.setProperty('--pr-text', base.r < 125 ? '#d6d6d6' : '#202020');
    root.setProperty('--pr-muted', base.r < 125 ? '#9a9a9a' : '#555555');
  }
  apply();
  try { if (cs) cs.addEventListener('com.adobe.csxs.events.ThemeColorChanged', apply); } catch (_) {}
  global.PremiereBindTheme = { apply:apply };
})(window);
