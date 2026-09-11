(function (global) {
  'use strict';

  var audioExtensions = { aac:1, aif:1, aiff:1, flac:1, m4a:1, mp3:1, ogg:1, opus:1, wav:1, wma:1 };
  var imageExtensions = { avif:1, bmp:1, gif:1, heic:1, jpeg:1, jpg:1, png:1, psd:1, svg:1, tif:1, tiff:1, webp:1 };
  var videoExtensions = { avi:1, braw:1, m4v:1, mkv:1, mov:1, mp4:1, mpeg:1, mpg:1, mxf:1, r3d:1, webm:1 };

  function extension(path) {
    var value = String(path || '').trim();
    var dot = value.lastIndexOf('.');
    return dot > -1 && dot < value.length - 1 ? value.slice(dot + 1).toLowerCase() : '';
  }

  function mediaGroup(item) {
    if (item.type === 'audio') return 'audio';
    if (/adjustment/i.test(item.name || '')) return 'adjustment';
    var ext = extension(item.mediaPath || item.name);
    if (audioExtensions[ext]) return 'audio';
    if (imageExtensions[ext]) return 'image';
    if (videoExtensions[ext]) return 'video';
    return 'other';
  }

  function id(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function defaultTitle(now) {
    var hours = now.getHours();
    var minutes = now.getMinutes();
    var suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return 'Selection (' + (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes + ' ' + suffix + ')';
  }

  function createPreset(selection, options) {
    options = options || {};
    if (!selection || !Array.isArray(selection.items) || !selection.items.length) {
      var emptyError = new Error('No timeline clips are selected. Select one or more clips, then click Save Selection.');
      emptyError.code = 'EMPTY_SELECTION';
      throw emptyError;
    }
    var items = selection.items;
    var minStart = Math.min.apply(Math, items.map(function (item) { return Number(item.start && item.start.seconds) || 0; }));
    var maxEnd = Math.max.apply(Math, items.map(function (item) { return Number(item.end && item.end.seconds) || 0; }));
    var playhead = Number(selection.playerPosition && selection.playerPosition.seconds);
    var anchor = isFinite(playhead) && playhead >= minStart && playhead <= maxEnd ? playhead - minStart : 0;
    var groups = { adjustment:[], image:[], video:[], audio:[], other:[] };
    var labels = { adjustment:'Adjustment Layers', image:'Images', video:'Video Clips', audio:'Audio', other:'Other Media' };
    var now = options.now instanceof Date ? options.now : new Date();

    items.forEach(function (item, index) {
      var group = mediaGroup(item);
      groups[group].push({
        id: id('clip'),
        title: item.name || 'Untitled clip',
        relativeStart: Math.max(0, (Number(item.start && item.start.seconds) || 0) - minStart),
        duration: Number(item.duration && item.duration.seconds) || Math.max(0, (Number(item.end && item.end.seconds) || 0) - (Number(item.start && item.start.seconds) || 0)),
        inPoint: Number(item.inPoint && item.inPoint.seconds) || 0,
        outPoint: Number(item.outPoint && item.outPoint.seconds) || 0,
        trackIndex: Number(item.trackIndex) || 0,
        sourceStartSeconds: Number(item.start && item.start.seconds) || 0,
        speed: Number(item.speed) || 1,
        labelColor: item.labelColor === null || typeof item.labelColor === 'undefined' ? null : Number(item.labelColor),
        source: item.locator || {},
        capture: { components:[], effectCount:0, keyframeCount:0 },
        captureIndex: index
      });
    });

    var children = [];
    ['adjustment','image','video','audio','other'].forEach(function (key) {
      if (groups[key].length) children.push({ category:labels[key], randomizerGroups:[], folders:[], items:groups[key] });
    });
    var requestedTitle = String(options.title || '').trim();
    var nestedRoots = items.map(function (item) { return item.nestedSequence; }).filter(function (root, index, roots) {
      if (!root || !root.isNestedSequence) return false;
      return roots.findIndex(function (candidate) { return candidate && ((candidate.sequenceGuid && candidate.sequenceGuid === root.sequenceGuid) || (!candidate.sequenceGuid && candidate.sequenceName === root.sequenceName)); }) === index;
    });
    return {
      id: id('preset'),
      title: (requestedTitle || defaultTitle(now)).slice(0, 100),
      shortcut: String(options.shortcut || ''),
      expanded: true,
      iconColor: '#ffffff',
      capturedAt: now.toISOString(),
      playheadAnchorOffsetSeconds: anchor,
      clipCount: items.length,
      assetType: nestedRoots.length ? 'true-nest' : 'selection',
      trueNest: nestedRoots.length ? { rootNames:nestedRoots.map(function (root) { return root.sequenceName; }), rootGuids:nestedRoots.map(function (root) { return root.sequenceGuid; }).filter(Boolean), roots:nestedRoots } : null,
      sourceContext: { project:selection.project || null, sequence:selection.sequence || null },
      captureFidelity: nestedRoots.length ? 'true-nest-reference' : 'timeline-metadata',
      children: children,
      selectionFolders: [],
      transitions: (selection.transitions || []).map(function (transition, index) {
        var ownerItem = null;
        children.some(function (category) { return (category.items || []).some(function (candidate) {
          var source = candidate.source || {};
          if ((source.type === 'audio' ? 'audio' : 'video') !== (transition.type === 'audio' ? 'audio' : 'video')) return false;
          if (Number(source.trackIndex) !== Number(transition.trackIndex)) return false;
          if (Math.abs(Number(candidate.sourceStartSeconds || source.startSeconds || 0) - Number(transition.ownerSourceStartSeconds || 0)) >= 0.00001) return false;
          if (transition.ownerSourceName && String(candidate.title) !== String(transition.ownerSourceName)) return false;
          ownerItem = candidate; return true;
        }); });
        return {
          id:id('transition'),
          title:String(transition.title || 'Transition'),
          matchName:String(transition.matchName || transition.title || ''),
          type:transition.type === 'audio' ? 'audio' : 'video',
          trackIndex:Number(transition.trackIndex) || 0,
          relativeStart:(Number(transition.startSeconds) || 0) - minStart,
          duration:Number(transition.duration) || 0.5,
          applyToStart:transition.applyToStart === true,
          forceSingleSided:transition.forceSingleSided === true,
          ownerItemId:ownerItem ? ownerItem.id : '',
          ownerSourceStartSeconds:Number(transition.ownerSourceStartSeconds) || 0,
          ownerSourceName:String(transition.ownerSourceName || '')
        };
      })
    };
  }

  function mergeProjectTransitions(selection, metadata) {
    var clips=selection.items||[],seen={},mapped=[];
    (metadata||[]).forEach(function(entry){
      var type=entry.type==='audio'?'audio':'video',start=Number(entry.startSeconds)||0,end=Number(entry.endSeconds)||0;
      var same=clips.filter(function(clip){return clip.type===type&&end>(Number(clip.start&&clip.start.seconds)||0)-.001&&start<(Number(clip.end&&clip.end.seconds)||0)+.001;});
      if(!same.length)return;
      var atStart=same.filter(function(clip){var value=Number(clip.start&&clip.start.seconds)||0;return value>=start-.001&&value<=end+.001;})[0]||null;
      var atEnd=same.filter(function(clip){var value=Number(clip.end&&clip.end.seconds)||0;return value>=start-.001&&value<=end+.001;})[0]||null;
      var needsIncoming=entry.hasIncomingClip===true,needsOutgoing=entry.hasOutgoingClip===true;
      if(needsIncoming&&!needsOutgoing&&!atStart)return;
      if(needsOutgoing&&!needsIncoming&&!atEnd)return;
      if(needsIncoming&&needsOutgoing&&!atStart&&!atEnd)return;
      var owner=atStart||atEnd||same[0],title=String(entry.displayName||entry.name||'Transition'),matchName=String(entry.matchName||title);
      var key=[type,title,matchName,start.toFixed(6),end.toFixed(6),Boolean(entry.hasOutgoingClip),Boolean(entry.hasIncomingClip)].join('|');
      if(seen[key])return;seen[key]=true;
      mapped.push({title:title,matchName:matchName,type:type,trackIndex:Number(owner.trackIndex)||0,startSeconds:start,endSeconds:end,duration:Number(entry.durationSeconds)||Math.max(0,end-start)||.5,applyToStart:Boolean(atStart),forceSingleSided:!(atStart&&atEnd&&atStart!==atEnd),ownerSourceStartSeconds:Number(owner.start&&owner.start.seconds)||0,ownerSourceName:String(owner.name||'')});
    });
    selection.transitions=mapped;
    return selection;
  }

  function save(options) {
    if (!global.PremiereBindBridge || !global.PremiereBindStorage) return Promise.reject(new Error('PremiereBind services are not ready.'));
    var saveProject=typeof global.PremiereBindBridge.saveProject==='function'?global.PremiereBindBridge.saveProject():Promise.resolve();
    return saveProject.then(function(){return global.PremiereBindBridge.readTimelineSelection();}).then(function (selection) {
      // QE's transition collection belongs to this exact active sequence and track.
      // Do not overwrite it with project-wide XML matches from unrelated sequences.
      if (Array.isArray(selection.transitions) && selection.transitions.length) return selection;
      if(!global.PremiereBindCompanion||typeof global.PremiereBindCompanion.readProjectTransitionMetadata!=='function'||!selection.project||!selection.project.path)return selection;
      return global.PremiereBindCompanion.readProjectTransitionMetadata(selection.project.path,selection.sequence&&selection.sequence.sequenceID,selection.sequence&&selection.sequence.name).then(function(result){return mergeProjectTransitions(selection,result.transitions||[]);});
    }).then(function (selection) {
      var preset = createPreset(selection, options);
      var capture=global.PremiereBindBridge.captureNativeLibrary?global.PremiereBindBridge.captureNativeLibrary({presetId:preset.id}).then(function(snapshot){preset.nativeLibrary=snapshot;preset.captureFidelity='native-sequence';return preset;}):Promise.reject(new Error('PremiereBind could not create the exact private library snapshot.'));
      return capture.then(function(){return global.PremiereBindStorage.update(function (library) {
        var profile = library.profiles.filter(function (entry) { return entry.id === library.activeProfileId; })[0] || library.profiles[0];
        if (!profile) throw new Error('PremiereBind has no active profile.');
        var folderId = String(options && options.folderId || '');
        var folder = folderId ? profile.presets.filter(function (item) { return item && (item.isFolder || Array.isArray(item.presets)) && item.id === folderId; })[0] : null;
        if (folder) {
          if (!Array.isArray(folder.presets)) folder.presets = [];
          folder.presets.unshift(preset);
        } else profile.presets.unshift(preset);
        return library;
      }).then(function (library) { return { preset:preset, library:library }; });});
    });
  }

  global.PremiereBindSaveSelection = { createPreset:createPreset, mergeProjectTransitions:mergeProjectTransitions, save:save };
})(window);
