(function(global){
  'use strict';
  function encoded(value){return encodeURI(value).replace(/#/g,'%23').replace(/\?/g,'%3F');}
  function url(path){var value=String(path||'').replace(/\\/g,'/');if(!value)return'';if(/^file:/i.test(value))return encoded(value);if(/^[A-Za-z]:\//.test(value))return encoded('file:///'+value);if(/^\/\//.test(value))return encoded('file:'+value);return encoded('file://'+(value.charAt(0)==='/'?'':'/')+value);}
  function markup(preview){if(!preview||!preview.path)return'';var src=url(preview.path);if(preview.kind==='image')return '<img class="source-preview is-active" data-preview-image src="'+src+'" alt="">';return '<video class="source-preview is-active" data-preview-video muted playsinline preload="metadata" src="'+src+'" data-start="'+(Number(preview.start)||0)+'" data-end="'+(Number(preview.end)||0)+'"></video>';}
  function reset(video){var start=Number(video.dataset.start)||0;try{video.pause();if(isFinite(video.duration))video.currentTime=Math.min(start,Math.max(0,video.duration-.04));}catch(_) {}}
  document.addEventListener('loadedmetadata',function(e){var video=e.target;if(!video.matches||!video.matches('[data-preview-video]'))return;video.classList.add('is-ready');reset(video);},true);
  document.addEventListener('load',function(e){if(e.target.matches&&e.target.matches('[data-preview-image]'))e.target.classList.add('is-ready');},true);
  document.addEventListener('error',function(e){if(e.target.matches&&e.target.matches('.source-preview'))e.target.classList.add('is-unavailable');},true);
  function play(video){try{var playing=video.play();if(playing&&playing.catch)playing.catch(function(){});}catch(_){} }
  document.addEventListener('mouseover',function(e){var card=e.target.closest&&e.target.closest('.card');if(!card||!document.body.classList.contains('preview-enabled'))return;var video=card.querySelector('[data-preview-video]');if(video&&video.classList.contains('is-ready'))play(video);},true);
  document.addEventListener('mouseout',function(e){var card=e.target.closest&&e.target.closest('.card');if(!card||card.contains(e.relatedTarget))return;var video=card.querySelector('[data-preview-video]');if(video)reset(video);},true);
  function loop(video){var card=video.closest('.card');reset(video);if(card&&card.matches(':hover')&&document.body.classList.contains('preview-enabled'))play(video);}
  document.addEventListener('timeupdate',function(e){var video=e.target;if(!video.matches||!video.matches('[data-preview-video]'))return;var start=Number(video.dataset.start)||0,end=Number(video.dataset.end)||0;if(end>start&&video.currentTime>=end-.03)loop(video);},true);
  document.addEventListener('ended',function(e){if(e.target.matches&&e.target.matches('[data-preview-video]'))loop(e.target);},true);
  global.PremiereBindMediaPreview={url:url,markup:markup};
}(window));
