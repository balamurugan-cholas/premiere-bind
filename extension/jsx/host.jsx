var PremiereBindHost = PremiereBindHost || {};

PremiereBindHost._stringify = function (value) {
  if (value === null || typeof value === "undefined") return "null";
  var type = typeof value;
  if (type === "number") return isFinite(value) ? String(value) : "null";
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
  var parts = [];
  var i;
  if (value instanceof Array) {
    for (i = 0; i < value.length; i++) parts.push(PremiereBindHost._stringify(value[i]));
    return "[" + parts.join(",") + "]";
  }
  if (type === "object") {
    for (var key in value) {
      if (value.hasOwnProperty(key) && typeof value[key] !== "function" && typeof value[key] !== "undefined") {
        parts.push(PremiereBindHost._stringify(String(key)) + ":" + PremiereBindHost._stringify(value[key]));
      }
    }
    return "{" + parts.join(",") + "}";
  }
  return "null";
};

PremiereBindHost._success = function (data) {
  return PremiereBindHost._stringify({ ok: true, data: data === undefined ? null : data });
};

PremiereBindHost._failure = function (code, message, details) {
  return PremiereBindHost._stringify({
    ok: false,
    error: { code: String(code || "HOST_ERROR"), message: String(message || "Premiere host error."), details: details || null }
  });
};

PremiereBindHost.ping = function () {
  var sequence = app.project ? app.project.activeSequence : null;
  return {
    bridgeVersion: "1.0.0",
    application: app.name || "Adobe Premiere Pro",
    applicationVersion: app.version || "",
    projectOpen: Boolean(app.project),
    activeSequence: sequence ? { name: String(sequence.name || ""), sequenceID: String(sequence.sequenceID || "") } : null
  };
};

PremiereBindHost.saveProject = function () {
  if (!app.project) throw new Error("Open a Premiere project before saving a selection.");
  var result = app.project.save();
  if (result === false) throw new Error("Premiere could not save the project before reading transitions.");
  return { path:String(app.project.path || "") };
};

PremiereBindHost._timeData = function (time) {
  if (!time) return { ticks: "0", seconds: 0 };
  var seconds = Number(time.seconds);
  if (!isFinite(seconds)) seconds = 0;
  var ticks = typeof time.ticks !== "undefined" ? String(time.ticks) : String(Math.round(seconds * 254016000000));
  return { ticks: ticks, seconds: seconds };
};

PremiereBindHost._readMediaPath = function (projectItem) {
  if (!projectItem) return "";
  try {
    if (typeof projectItem.getMediaPath === "function") return String(projectItem.getMediaPath() || "");
  } catch (_) {}
  return "";
};

PremiereBindHost._projectItemId = function (item) {
  try { return String((item && (item.nodeId || item.treePath)) || ""); } catch (_) { return ""; }
};

PremiereBindHost._sequenceForProjectItem = function (projectItem) {
  if (!app.project || !projectItem || !app.project.sequences) return null;
  var wanted = PremiereBindHost._projectItemId(projectItem);
  var count = Number(app.project.sequences.numSequences || app.project.sequences.numItems || 0);
  for (var i = 0; i < count; i++) {
    var sequence = app.project.sequences[i];
    if (!sequence) continue;
    try {
      if (wanted && PremiereBindHost._projectItemId(sequence.projectItem) === wanted) return sequence;
      if (wanted && String(sequence.sequenceID || "") === wanted) return sequence;
    } catch (_) {}
  }
  return null;
};

PremiereBindHost._nestedSequenceDescriptor = function (projectItem, visited) {
  var sequence = PremiereBindHost._sequenceForProjectItem(projectItem);
  if (!sequence) return null;
  visited = visited || {};
  var guid = String(sequence.sequenceID || PremiereBindHost._projectItemId(projectItem) || "");
  var descriptor = { isNestedSequence:true, sequenceGuid:guid, sequenceName:String(sequence.name || projectItem.name || "Nested Sequence"), children:[] };
  if (visited[guid]) return descriptor;
  visited[guid] = true;
  var kinds = [{ tracks:sequence.videoTracks, type:"video" }, { tracks:sequence.audioTracks, type:"audio" }];
  var seen = {};
  for (var k = 0; k < kinds.length; k++) {
    var tracks = kinds[k].tracks;
    var trackCount = Number(tracks && tracks.numTracks || 0);
    for (var t = 0; t < trackCount; t++) {
      var clips = tracks[t] && tracks[t].clips;
      var clipCount = Number(clips && clips.numItems || 0);
      for (var c = 0; c < clipCount; c++) {
        var clip = clips[c], childItem = null;
        try { childItem = clip.projectItem || null; } catch (_) {}
        var nested = PremiereBindHost._nestedSequenceDescriptor(childItem, visited);
        var key = nested ? "sequence:" + (nested.sequenceGuid || nested.sequenceName) : "media:" + (PremiereBindHost._projectItemId(childItem) || String(clip.name || ""));
        if (seen[key]) continue;
        seen[key] = true;
        if (nested) { nested.kind = "sequence"; descriptor.children.push(nested); }
        else descriptor.children.push({ kind:"media", name:String(clip.name || (childItem && childItem.name) || "Untitled clip"), mediaType:kinds[k].type, trackIndex:t });
      }
    }
  }
  delete visited[guid];
  return descriptor;
};

PremiereBindHost._readTrackItem = function (item, mediaType, trackIndex, itemIndex, sequence) {
  var projectItem = null;
  try { projectItem = item.projectItem || null; } catch (_) {}
  var speed = 1;
  try {
    if (typeof item.getSpeed === "function") speed = Number(item.getSpeed()) || 1;
  } catch (_) {}
  var start = PremiereBindHost._timeData(item.start);
  var end = PremiereBindHost._timeData(item.end);
  var inPoint = PremiereBindHost._timeData(item.inPoint);
  var outPoint = PremiereBindHost._timeData(item.outPoint);
  var duration = PremiereBindHost._timeData(item.duration);
  var name = String(item.name || (projectItem && projectItem.name) || "Untitled clip");
  var projectItemId = "";
  try { projectItemId = String((projectItem && (projectItem.nodeId || projectItem.treePath)) || ""); } catch (_) {}
  var labelColor = null;
  try { if (typeof item.getColorLabel === "function") labelColor = Number(item.getColorLabel()); } catch (_) {}
  if (labelColor === null || !isFinite(labelColor)) {
    try { if (projectItem && typeof projectItem.getColorLabel === "function") labelColor = Number(projectItem.getColorLabel()); } catch (_) {}
  }
  if (labelColor === null || !isFinite(labelColor)) labelColor = null;
  var mediaPath = PremiereBindHost._readMediaPath(projectItem);
  return {
    name: name,
    type: mediaType,
    trackIndex: Number(trackIndex),
    itemIndex: Number(itemIndex),
    start: start,
    end: end,
    duration: duration,
    inPoint: inPoint,
    outPoint: outPoint,
    speed: speed,
    labelColor: labelColor,
    mediaPath: mediaPath,
    projectItemId: projectItemId,
    nestedSequence: PremiereBindHost._nestedSequenceDescriptor(projectItem, {}),
    locator: {
      sequenceGuid: String(sequence.sequenceID || ""),
      sequenceName: String(sequence.name || ""),
      type: mediaType,
      trackIndex: Number(trackIndex),
      startTicks: start.ticks,
      startSeconds: start.seconds,
      endTicks: end.ticks,
      projectItemId: projectItemId,
      mediaPath: mediaPath,
      name: name,
      labelColor: labelColor
    }
  };
};

PremiereBindHost._collectSelectedTrackItems = function (tracks, mediaType, sequence, output) {
  if (!tracks) return;
  var trackCount = Number(tracks.numTracks || 0);
  for (var trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    var track = tracks[trackIndex];
    if (!track || !track.clips) continue;
    var clipCount = Number(track.clips.numItems || 0);
    for (var itemIndex = 0; itemIndex < clipCount; itemIndex++) {
      var item = track.clips[itemIndex];
      var selected = false;
      try { selected = Boolean(item && typeof item.isSelected === "function" && item.isSelected()); } catch (_) {}
      if (selected) output.push(PremiereBindHost._readTrackItem(item, mediaType, trackIndex, itemIndex, sequence));
    }
  }
};

PremiereBindHost._qeSeconds = function (value) {
  if (!value) return 0;
  try { if (typeof value.secs !== "undefined") return Number(value.secs) || 0; } catch (_) {}
  try { if (typeof value.seconds !== "undefined") return Number(value.seconds) || 0; } catch (_) {}
  try { if (typeof value.ticks !== "undefined") return (Number(value.ticks) || 0) / 254016000000; } catch (_) {}
  return Number(value) || 0;
};

PremiereBindHost._captureSelectedTransitions = function (selectedItems) {
  var output = [];
  if (!selectedItems || !selectedItems.length) return output;
  try {
    app.enableQE();
    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence) return output;
    var kinds = ["video", "audio"];
    for (var k = 0; k < kinds.length; k++) {
      var kind = kinds[k];
      var trackCount = kind === "audio" ? Number(qeSequence.numAudioTracks || 0) : Number(qeSequence.numVideoTracks || 0);
      for (var trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        var track = kind === "audio" ? qeSequence.getAudioTrackAt(trackIndex) : qeSequence.getVideoTrackAt(trackIndex);
        if (!track) continue;
        for (var itemIndex = 0; itemIndex < Number(track.numTransitions || 0); itemIndex++) {
          var transition = track.getTransitionAt(itemIndex);
          if (!transition) continue;
          var transitionType = "";
          try { transitionType = String(transition.type || "").toLowerCase(); } catch (_) {}
          if (transitionType.indexOf("transition") < 0 && transitionType !== "2") continue;
          var start = PremiereBindHost._qeSeconds(transition.start);
          var end = PremiereBindHost._qeSeconds(transition.end);
          var duration = PremiereBindHost._qeSeconds(transition.duration);
          if (!(end > start) && duration > 0) end = start + duration;
          if (!(duration > 0)) duration = Math.max(0, end - start);
          var sameTrack = [], c;
          for (c = 0; c < selectedItems.length; c++) {
            var candidate = selectedItems[c];
            if (candidate.type === kind && Number(candidate.trackIndex) === trackIndex && end > candidate.start.seconds - 0.001 && start < candidate.end.seconds + 0.001) sameTrack.push(candidate);
          }
          if (!sameTrack.length) continue;
          var clipAtStart = null, clipAtEnd = null;
          for (c = 0; c < sameTrack.length; c++) {
            if (!clipAtStart && sameTrack[c].start.seconds >= start - 0.001 && sameTrack[c].start.seconds <= end + 0.001) clipAtStart = sameTrack[c];
            if (!clipAtEnd && sameTrack[c].end.seconds >= start - 0.001 && sameTrack[c].end.seconds <= end + 0.001) clipAtEnd = sameTrack[c];
          }
          var owner = clipAtStart || clipAtEnd || sameTrack[0];
          var name = "Transition";
          try { name = String(transition.name || transition.getName() || name); } catch (_) { try { name = String(transition.name || name); } catch (__) {} }
          output.push({
            title:name, matchName:name, type:kind, trackIndex:trackIndex,
            startSeconds:start, endSeconds:end, duration:duration,
            applyToStart:Boolean(clipAtStart),
            forceSingleSided:!(clipAtStart && clipAtEnd && clipAtStart !== clipAtEnd),
            ownerSourceStartSeconds:owner ? owner.start.seconds : 0,
            ownerSourceName:owner ? owner.name : ""
          });
        }
      }
    }
  } catch (_) {}
  return output;
};

PremiereBindHost.readTimelineSelection = function () {
  if (!app.project) throw new Error("Open a Premiere project before reading a timeline selection.");
  var sequence = app.project.activeSequence;
  if (!sequence) throw new Error("Open a sequence in the Timeline before reading a selection.");
  var items = [];
  PremiereBindHost._collectSelectedTrackItems(sequence.videoTracks, "video", sequence, items);
  PremiereBindHost._collectSelectedTrackItems(sequence.audioTracks, "audio", sequence, items);
  items.sort(function (left, right) {
    if (left.start.seconds !== right.start.seconds) return left.start.seconds - right.start.seconds;
    if (left.type !== right.type) return left.type === "video" ? -1 : 1;
    return left.trackIndex - right.trackIndex;
  });
  var playerPosition = null;
  try { playerPosition = PremiereBindHost._timeData(sequence.getPlayerPosition()); } catch (_) { playerPosition = PremiereBindHost._timeData(null); }
  return {
    project: { name: String(app.project.name || ""), path: String(app.project.path || "") },
    sequence: { name: String(sequence.name || ""), sequenceID: String(sequence.sequenceID || "") },
    playerPosition: playerPosition,
    count: items.length,
    videoCount: (function () { var count = 0; for (var i = 0; i < items.length; i++) if (items[i].type === "video") count++; return count; }()),
    audioCount: (function () { var count = 0; for (var i = 0; i < items.length; i++) if (items[i].type === "audio") count++; return count; }()),
    items: items,
    transitions: PremiereBindHost._captureSelectedTransitions(items)
  };
};

PremiereBindHost._durationText = function (seconds, sequence) {
  var frameDuration = 1 / 30;
  try { frameDuration = Number(sequence.getSettings().videoFrameRate.seconds) || frameDuration; } catch (_) {}
  var fps = Math.max(1, Math.round(1 / frameDuration));
  var value = Number(seconds);
  if (!isFinite(value) || value <= 0) value = 0.5;
  var whole = Math.floor(value), frames = Math.round((value - whole) * fps);
  if (frames >= fps) { whole++; frames = 0; }
  return String(whole) + ":" + (frames < 10 ? "0" : "") + String(frames);
};

PremiereBindHost._applyTransitions = function (sequence, transitions, inserted) {
  var applied = 0, failures = [];
  if (!transitions || !transitions.length) return { applied:0, failures:failures };
  try { app.enableQE(); } catch (_) {}
  var qeSequence = null;
  try { qeSequence = qe.project.getActiveSequence(); } catch (_) {}
  if (!qeSequence) return { applied:0, failures:[{ error:"QE has no active sequence." }] };
  for (var p = 0; p < transitions.length; p++) {
    var saved = transitions[p] || {}, owner = null, best = 999999;
    for (var i = 0; i < inserted.length; i++) {
      var candidate = inserted[i];
      if (candidate.type !== (saved.type === "audio" ? "audio" : "video")) continue;
      if (Number(candidate.sourceTrackIndex) !== Number(saved.trackIndex)) continue;
      var nameMatches = !saved.ownerSourceName || String(candidate.sourceName || "").toLowerCase() === String(saved.ownerSourceName).toLowerCase();
      if (!nameMatches) continue;
      var distance = Math.abs(Number(candidate.sourceStartSeconds || 0) - Number(saved.ownerSourceStartSeconds || 0));
      if (distance < best) { owner = candidate; best = distance; }
    }
    if (!owner) {
      for (i = 0; i < inserted.length; i++) {
        candidate = inserted[i];
        if (candidate.type !== (saved.type === "audio" ? "audio" : "video")) continue;
        if (Number(candidate.sourceTrackIndex) !== Number(saved.trackIndex)) continue;
        distance = Math.abs(Number(candidate.sourceStartSeconds || 0) - Number(saved.ownerSourceStartSeconds || 0));
        if (distance < best) { owner = candidate; best = distance; }
      }
    }
    if (!owner) { failures.push({ index:p, title:String(saved.title || "Transition"), error:"The inserted owner clip could not be matched." }); continue; }
    try {
      var kind = saved.type === "audio" ? "audio" : "video";
      var track = kind === "audio" ? qeSequence.getAudioTrackAt(owner.trackIndex) : qeSequence.getVideoTrackAt(owner.trackIndex);
      if (!track) throw new Error("Destination track was not found.");
      var clip = null, namedClip = null, clipDistance = 999999, namedDistance = 999999;
      for (i = 0; i < Number(track.numItems || 0); i++) {
        var item = track.getItemAt(i);
        if (!item || !item.name || typeof item.addTransition !== "function") continue;
        var itemStart = PremiereBindHost._qeSeconds(item.start);
        var distanceToStart = Math.abs(itemStart - owner.startSeconds);
        var itemName = String(item.name || "").toLowerCase(), wantedName = String(owner.sourceName || "").toLowerCase();
        var nameMatches = !wantedName || itemName === wantedName || itemName.indexOf(wantedName) >= 0 || wantedName.indexOf(itemName) >= 0;
        if (nameMatches && distanceToStart < namedDistance) { namedClip = item; namedDistance = distanceToStart; }
        if (distanceToStart < 0.08 && distanceToStart < clipDistance) { clip = item; clipDistance = distanceToStart; }
      }
      if (!clip) clip = namedClip;
      if (!clip) throw new Error("Destination clip was not found.");
      var transitionName = String(saved.title || saved.matchName || "");
      var effect = kind === "audio" ? qe.project.getAudioTransitionByName(transitionName) : qe.project.getVideoTransitionByName(transitionName);
      if (!effect && saved.matchName && String(saved.matchName) !== transitionName) effect = kind === "audio" ? qe.project.getAudioTransitionByName(String(saved.matchName)) : qe.project.getVideoTransitionByName(String(saved.matchName));
      if (!effect || !String(effect.name || "")) throw new Error("Premiere cannot create the native transition by name: " + transitionName + ". The original custom fade needs native copying.");
      var atStart = saved.applyToStart === true;
      var position = saved.forceSingleSided === true ? (atStart ? 1 : 0) : 0.5;
      var durationText = PremiereBindHost._durationText(saved.duration, sequence);
      var accepted = clip.addTransition(effect, atStart, durationText, "0", position, saved.forceSingleSided === true);
      if (accepted === false && kind === "audio" && saved.forceSingleSided === true) {
        var naturalPosition = atStart ? 0 : 1;
        if (naturalPosition !== position) accepted = clip.addTransition(effect, atStart, durationText, "0", naturalPosition, true);
        if (accepted === false) accepted = clip.addTransition(effect, atStart, durationText, "0", 0.5, true);
        if (accepted === false) accepted = clip.addTransition(effect, atStart, durationText, "0", naturalPosition);
      }
      if (accepted === false) throw new Error("Premiere rejected the transition.");
      applied++;
    } catch (error) { failures.push({ index:p, title:String(saved.title || "Transition"), error:String(error && error.message || error) }); }
  }
  return { applied:applied, failures:failures };
};

PremiereBindHost._normalizeMediaPath = function (value) {
  var path = String(value || "").replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
};

PremiereBindHost._findProjectItem = function (root, projectItemId, mediaPath) {
  if (!root) return null;
  var wantedId = String(projectItemId || "");
  var wantedPath = PremiereBindHost._normalizeMediaPath(mediaPath);
  var fallback = null;
  var visit = function (item) {
    if (!item) return null;
    var id = "";
    try { id = String(item.nodeId || item.treePath || ""); } catch (_) {}
    var itemPath = "";
    if (wantedPath) itemPath = PremiereBindHost._normalizeMediaPath(PremiereBindHost._readMediaPath(item));
    // Project-item IDs belong to the project where the selection was saved.
    // After importing a portable package the same numeric ID can identify an
    // unrelated item in the destination project. Require the relinked media
    // path to agree before accepting an ID match.
    if (wantedId && id === wantedId && (!wantedPath || (itemPath && itemPath === wantedPath))) return item;
    if (!fallback && wantedPath) {
      if (itemPath && itemPath === wantedPath) fallback = item;
    }
    var children = null;
    try { children = item.children; } catch (_) {}
    if (children) {
      var count = Number(children.numItems || 0);
      for (var index = 0; index < count; index++) {
        var match = visit(children[index]);
        if (match) return match;
      }
    }
    return null;
  };
  return visit(root) || fallback;
};

PremiereBindHost._premiereBindBin = function () {
  if (!app.project || !app.project.rootItem) return null;
  var root = app.project.rootItem;
  var children = root.children;
  var count = children ? Number(children.numItems || 0) : 0;
  for (var index = 0; index < count; index++) {
    var child = children[index];
    try {
      if (String(child.name || "") === "PremiereBind" && Number(child.type) === 2) return child;
    } catch (_) {}
  }
  try { return root.createBin("PremiereBind"); } catch (_) { return null; }
};

PremiereBindHost._restoreMissingProjectItem = function (mediaPath) {
  var path = String(mediaPath || "");
  if (!path) return null;
  var file = null;
  try { file = new File(path); } catch (_) {}
  if (!file || !file.exists) throw new Error("The original source file no longer exists: " + path);
  var bin = PremiereBindHost._premiereBindBin();
  if (!bin) throw new Error("PremiereBind could not create its project folder for the restored media.");
  var accepted = app.project.importFiles([path], true, bin, false);
  if (accepted === false) throw new Error("Premiere could not re-import the original source media: " + path);
  return PremiereBindHost._findProjectItem(app.project.rootItem, "", path);
};

PremiereBindHost._makeTime = function (seconds) {
  var value = new Time();
  value.seconds = Math.max(0, Number(seconds) || 0);
  return value;
};

PremiereBindHost._identityHash = function (value) {
  var text = String(value || ""), hash = 2166136261;
  for (var index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
};

PremiereBindHost._findProjectItemByName = function (root, name) {
  if (!root || !name) return null;
  var wanted = String(name);
  var visit = function (item) {
    if (!item) return null;
    try { if (String(item.name || "") === wanted) return item; } catch (_) {}
    var children = null;
    try { children = item.children; } catch (_) {}
    if (children) {
      var count = Number(children.numItems || 0);
      for (var index = 0; index < count; index++) {
        var match = visit(children[index]);
        if (match) return match;
      }
    }
    return null;
  };
  return visit(root);
};

PremiereBindHost._savedRangeProjectItem = function (plan) {
  var item = plan.item || {};
  var savedLabelColor = item.labelColor;
  if ((savedLabelColor === null || typeof savedLabelColor === "undefined") && item.source) savedLabelColor = item.source.labelColor;
  if (savedLabelColor === null || typeof savedLabelColor === "undefined") {
    try { if (plan.projectItem && typeof plan.projectItem.getColorLabel === "function") savedLabelColor = Number(plan.projectItem.getColorLabel()); } catch (_) {}
  }
  plan.savedLabelColor = savedLabelColor;
  var inSeconds = Math.max(0, Number(item.inPoint) || 0);
  var duration = Math.max(0, Number(item.duration) || 0);
  var outSeconds = Number(item.outPoint);
  if (!isFinite(outSeconds) || outSeconds <= inSeconds) outSeconds = inSeconds + duration;
  var rangeKey = Math.round(inSeconds * 1000) + "-" + Math.round(outSeconds * 1000);
  var source = item.source || {};
  var mediaIdentity = PremiereBindHost._normalizeMediaPath(source.mediaPath) || String(source.projectItemId || plan.projectItem && (plan.projectItem.nodeId || plan.projectItem.treePath) || item.title || "media");
  var name = "PremiereBind Range - " + PremiereBindHost._identityHash(mediaIdentity + "|" + plan.kind + "|" + rangeKey) + " - " + plan.kind + " - " + rangeKey;
  var existing = PremiereBindHost._findProjectItemByName(app.project.rootItem, name);
  if (existing) {
    if (savedLabelColor !== null && typeof savedLabelColor !== "undefined" && typeof existing.setColorLabel === "function") {
      try { existing.setColorLabel(Number(savedLabelColor)); } catch (_) {}
    }
    return existing;
  }
  if (!plan.projectItem || typeof plan.projectItem.createSubClip !== "function") {
    throw new Error("Premiere cannot create the saved clip range for " + String(item.title || "this clip") + ".");
  }
  var takeVideo = plan.kind === "video" ? 1 : 0;
  var takeAudio = plan.kind === "audio" ? 1 : 0;
  var subclip = plan.projectItem.createSubClip(name, PremiereBindHost._makeTime(inSeconds), PremiereBindHost._makeTime(outSeconds), 1, takeVideo, takeAudio);
  if (!subclip) throw new Error("Premiere rejected the saved clip range for " + String(item.title || "this clip") + ".");
  if (savedLabelColor !== null && typeof savedLabelColor !== "undefined" && typeof subclip.setColorLabel === "function") {
    try { subclip.setColorLabel(Number(savedLabelColor)); } catch (_) {}
  }
  var bin = PremiereBindHost._premiereBindBin();
  if (bin && typeof subclip.moveBin === "function") {
    try { subclip.moveBin(bin); } catch (_) {}
  }
  return subclip;
};

PremiereBindHost._insertSavedRange = function (plan) {
  plan.insertProjectItem = PremiereBindHost._savedRangeProjectItem(plan);
  return plan.track.overwriteClip(plan.insertProjectItem, String(Math.round(plan.start * 254016000000)));
};

PremiereBindHost._findInsertedClip = function (track, projectItem, startSeconds) {
  if (!track || !track.clips) return null;
  var count = Number(track.clips.numItems || 0);
  var projectId = "";
  try { projectId = String(projectItem.nodeId || projectItem.treePath || ""); } catch (_) {}
  var best = null;
  var bestDistance = 999999;
  for (var index = 0; index < count; index++) {
    var clip = track.clips[index];
    if (!clip) continue;
    var clipId = "";
    try { clipId = String((clip.projectItem && (clip.projectItem.nodeId || clip.projectItem.treePath)) || ""); } catch (_) {}
    if (projectId && clipId && projectId !== clipId) continue;
    var seconds = 0;
    try { seconds = Number(clip.start.seconds) || 0; } catch (_) {}
    var distance = Math.abs(seconds - startSeconds);
    if (distance < bestDistance) { best = clip; bestDistance = distance; }
  }
  return bestDistance <= 0.05 ? best : null;
};

PremiereBindHost._transitionsForPlans = function (transitions, plans) {
  var source = transitions || [], output = [];
  var anchoredToRandomizerItem = function (transition, item) {
    var locator = item.source || {};
    if (!locator.randomizerTargetTrack) return true;
    var itemStart = Number(item.sourceStartSeconds || locator.startSeconds || 0);
    var itemEnd = itemStart + Math.max(0, Number(item.duration) || 0);
    var selectionStart = itemStart - (Number(item.relativeStart) || 0);
    var transitionStart = selectionStart + (Number(transition.relativeStart) || 0);
    var transitionEnd = transitionStart + Math.max(0, Number(transition.duration) || 0);
    var transitionCenter = transitionStart + ((transitionEnd - transitionStart) / 2);
    var tolerance = 0.12;
    var near = function (left, right) { return Math.abs(left - right) <= tolerance; };
    return near(itemStart, transitionStart) || near(itemStart, transitionEnd) || near(itemStart, transitionCenter)
      || near(itemEnd, transitionStart) || near(itemEnd, transitionEnd) || near(itemEnd, transitionCenter);
  };
  for (var transitionIndex = 0; transitionIndex < source.length; transitionIndex++) {
    var transition = source[transitionIndex] || {};
    if (transition.ownerItemId) {
      for (var exactIndex = 0; exactIndex < plans.length; exactIndex++) {
        if (String(plans[exactIndex].item && plans[exactIndex].item.id || "") === String(transition.ownerItemId) && anchoredToRandomizerItem(transition, plans[exactIndex].item || {})) { output.push(transition); break; }
      }
      continue;
    }
    var ownerName = String(transition.ownerSourceName || "").toLowerCase();
    var hasOwnerStart = typeof transition.ownerSourceStartSeconds !== "undefined" && transition.ownerSourceStartSeconds !== null;
    if (!ownerName && !hasOwnerStart) { output.push(transition); continue; }
    for (var planIndex = 0; planIndex < plans.length; planIndex++) {
      var plan = plans[planIndex], item = plan.item || {}, locator = item.source || {};
      var itemName = String(item.title || locator.name || "").toLowerCase();
      var sourceTrack = typeof locator.trackIndex === "number" ? locator.trackIndex : Number(item.trackIndex) || 0;
      var typeMatches = String(transition.type || "video") === plan.kind;
      var trackMatches = Number(transition.trackIndex || 0) === Number(sourceTrack);
      var nameMatches = !ownerName || ownerName === itemName;
      var startMatches = !hasOwnerStart || Math.abs(Number(transition.ownerSourceStartSeconds || 0) - Number(item.sourceStartSeconds || locator.startSeconds || 0)) < 0.00001;
      if (typeMatches && trackMatches && nameMatches && startMatches && anchoredToRandomizerItem(transition, item)) { output.push(transition); break; }
    }
  }
  return output;
};

PremiereBindHost._rangesOverlap = function (leftStart, leftEnd, rightStart, rightEnd) {
  var epsilon = 0.000001;
  return leftStart < rightEnd - epsilon && leftEnd > rightStart + epsilon;
};

PremiereBindHost._trackHasCollision = function (track, startSeconds, endSeconds) {
  if (!track || !track.clips) return false;
  var count = Number(track.clips.numItems || 0);
  for (var i = 0; i < count; i++) {
    var clip = track.clips[i];
    if (!clip) continue;
    var start = 0, end = 0;
    try { start = Number(clip.start.seconds) || 0; end = Number(clip.end.seconds) || start; } catch (_) {}
    if (PremiereBindHost._rangesOverlap(startSeconds, endSeconds, start, end)) return true;
  }
  return false;
};

PremiereBindHost._ensureTrackCounts = function (sequence, videoRequired, audioRequired) {
  var videoCount = Number(sequence.videoTracks && sequence.videoTracks.numTracks || 0);
  var audioCount = Number(sequence.audioTracks && sequence.audioTracks.numTracks || 0);
  var addVideo = Math.max(0, Number(videoRequired) - videoCount);
  var addAudio = Math.max(0, Number(audioRequired) - audioCount);
  if (!addVideo && !addAudio) return;
  var priorTracks = { video:[], audio:[] }, trackKind, trackList, ti;
  for (trackKind in priorTracks) {
    trackList = trackKind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    for (ti = 0; ti < trackList.numTracks; ti++) priorTracks[trackKind].push(trackList[ti].id);
  }
  try {
    app.enableQE();
    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence || typeof qeSequence.addTracks !== "function") throw new Error("QE addTracks is unavailable.");
    // Refresh the append positions after prior track additions.
    videoCount = Math.max(videoCount, Number(qeSequence.numVideoTracks) || 0);
    audioCount = Math.max(audioCount, Number(qeSequence.numAudioTracks) || 0);
    addVideo = Math.max(0, Number(videoRequired) - videoCount);
    addAudio = Math.max(0, Number(audioRequired) - audioCount);
    // QE: video count, video position, audio count, audio type, audio position.
    // Keep audio type fixed (stereo); passing the track index here prepends
    // tracks and eventually requests an unsupported audio type.
    if (addVideo) qeSequence.addTracks(addVideo, videoCount, 0);
    if (addAudio) qeSequence.addTracks(0, 0, addAudio, 1, audioCount);
  } catch (error) {
    throw new Error("Premiere could not create the tracks required for smart insertion: " + String(error && error.message || error));
  }
  videoCount = Math.max(Number(sequence.videoTracks && sequence.videoTracks.numTracks || 0), Number(qeSequence && qeSequence.numVideoTracks || 0));
  audioCount = Math.max(Number(sequence.audioTracks && sequence.audioTracks.numTracks || 0), Number(qeSequence && qeSequence.numAudioTracks || 0));
  if (videoCount < videoRequired || audioCount < audioRequired) throw new Error("Premiere did not create all tracks required for smart insertion.");
  for (trackKind in priorTracks) {
    trackList = trackKind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    for (ti = 0; ti < priorTracks[trackKind].length; ti++) {
      if (typeof priorTracks[trackKind][ti] !== "undefined" && (!trackList[ti] || String(trackList[ti].id) !== String(priorTracks[trackKind][ti])))
        throw new Error("Premiere shifted existing tracks while adding a track. Insertion stopped to protect existing clips.");
    }
  }
};

PremiereBindHost._applySmartTracks = function (sequence, items, insertionStart) {
  var kinds = ["video", "audio"];
  for (var k = 0; k < kinds.length; k++) {
    var kind = kinds[k], matching = [], minTrack = 999999, maxNormalized = 0;
    for (var i = 0; i < items.length; i++) {
      var itemKind = items[i].type === "audio" ? "audio" : "video";
      if (itemKind !== kind) continue;
      var sourceTrack = Math.max(0, Number(items[i].trackIndex) || 0);
      matching.push(items[i]);
      minTrack = Math.min(minTrack, sourceTrack);
    }
    if (!matching.length) continue;
    for (i = 0; i < matching.length; i++) maxNormalized = Math.max(maxNormalized, (Number(matching[i].trackIndex) || 0) - minTrack);
    var tracks = kind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    var count = Number(tracks && tracks.numTracks || 0), base = 0;
    for (base = 0; base <= count; base++) {
      var collision = false;
      for (i = 0; i < matching.length; i++) {
        var destination = base + ((Number(matching[i].trackIndex) || 0) - minTrack);
        var start = insertionStart + (Number(matching[i].relativeStart) || 0);
        var end = start + Math.max(Number(matching[i].duration) || 0, 0.000001);
        if (destination < count && PremiereBindHost._trackHasCollision(tracks[destination], start, end)) { collision = true; break; }
      }
      if (!collision) break;
    }
    var required = base + maxNormalized + 1;
    PremiereBindHost._ensureTrackCounts(sequence, kind === "video" ? required : 0, kind === "audio" ? required : 0);
    for (i = 0; i < matching.length; i++) matching[i]._smartTrackIndex = base + ((Number(matching[i].trackIndex) || 0) - minTrack);
  }
};

PremiereBindHost._applyGeneralSmartTracks = PremiereBindHost._applySmartTracks;
PremiereBindHost._applySmartTracks = function (sequence, items, insertionStart) {
  var hasRandomizerTargets = false, index;
  for (index = 0; index < items.length; index++) {
    if (items[index] && items[index].source && items[index].source.randomizerTargetTrack) { hasRandomizerTargets = true; break; }
  }
  if (!hasRandomizerTargets) return PremiereBindHost._applyGeneralSmartTracks(sequence, items, insertionStart);

  PremiereBindHost._applyGeneralSmartTracks(sequence, items, insertionStart);
  var reservations = { video:{}, audio:{} };
  var reserve = function (kind, trackIndex, start, end) {
    var key = String(trackIndex);
    if (!reservations[kind][key]) reservations[kind][key] = [];
    reservations[kind][key].push({ start:start, end:end });
  };
  var collides = function (kind, trackIndex, start, end) {
    var tracks = kind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    if (trackIndex < Number(tracks && tracks.numTracks || 0) && PremiereBindHost._trackHasCollision(tracks[trackIndex], start, end)) return true;
    var ranges = reservations[kind][String(trackIndex)] || [];
    for (var rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
      if (start < ranges[rangeIndex].end - 0.000001 && end > ranges[rangeIndex].start + 0.000001) return true;
    }
    return false;
  };
  var nearestFree = function (kind, preferred, start, end) {
    preferred = Math.max(0, Number(preferred) || 0);
    if (!collides(kind, preferred, start, end)) return preferred;
    var tracks = kind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    var count = Number(tracks && tracks.numTracks || 0);
    for (var distance = 1; distance <= count + preferred + 1; distance++) {
      var above = preferred + distance;
      if (above < count && !collides(kind, above, start, end)) return above;
      var below = preferred - distance;
      if (below >= 0 && !collides(kind, below, start, end)) return below;
    }
    return count;
  };

  for (index = 0; index < items.length; index++) {
    var fixed = items[index] || {}, fixedKind = fixed.type === "audio" ? "audio" : "video", fixedSource = fixed.source || {};
    var fixedPolicy = String(fixedSource.randomizerTargetTrack || "").toUpperCase();
    if (fixedPolicy === "SMART") continue;
    var fixedTrack = typeof fixed._smartTrackIndex === "number" ? fixed._smartTrackIndex : Math.max(0, Number(fixed.trackIndex) || 0);
    if (fixedPolicy === "ORIGINAL") fixedTrack = Math.max(0, Number(fixedSource.trackIndex));
    else if (fixedPolicy) {
      var fixedPrefix = fixedKind === "audio" ? "A" : "V";
      var fixedMatch = fixedPolicy.match(new RegExp("^" + fixedPrefix + "([1-9][0-9]*)$"));
      if (fixedMatch) fixedTrack = Number(fixedMatch[1]) - 1;
    }
    var fixedStart = insertionStart + (Number(fixed.relativeStart) || 0);
    if (fixedPolicy) fixedTrack = nearestFree(fixedKind, fixedTrack, fixedStart, fixedStart + Math.max(Number(fixed.duration) || 0, 0.000001));
    PremiereBindHost._ensureTrackCounts(sequence, fixedKind === "video" ? fixedTrack + 1 : 0, fixedKind === "audio" ? fixedTrack + 1 : 0);
    fixed._smartTrackIndex = fixedTrack;
    reserve(fixedKind, fixedTrack, fixedStart, fixedStart + Math.max(Number(fixed.duration) || 0, 0.000001));
  }

  for (index = 0; index < items.length; index++) {
    var item = items[index] || {}, kind = item.type === "audio" ? "audio" : "video", source = item.source || {};
    var policy = String(source.randomizerTargetTrack || "").toUpperCase();
    if (policy !== "SMART") continue;
    var start = insertionStart + (Number(item.relativeStart) || 0), end = start + Math.max(Number(item.duration) || 0, 0.000001), target = nearestFree(kind, 0, start, end);
    PremiereBindHost._ensureTrackCounts(sequence, kind === "video" ? target + 1 : 0, kind === "audio" ? target + 1 : 0);
    item._smartTrackIndex = target;
    reserve(kind, target, start, end);
  }
};

PremiereBindHost.insertPresetAtPlayhead = function (payload) {
  if (!app.project) throw new Error("Open a Premiere project before inserting a selection.");
  var sequence = app.project.activeSequence;
  if (!sequence) throw new Error("Open a sequence in the Timeline before inserting a selection.");
  var items = payload && payload.items instanceof Array ? payload.items : [];
  if (!items.length) throw new Error("This saved selection has no clips to insert.");
  var playhead = typeof payload.targetSeconds === "number" ? payload.targetSeconds : PremiereBindHost._timeData(sequence.getPlayerPosition()).seconds;
  var duration = Math.max(0, Number(payload.duration) || 0);
  var anchor = Math.max(0, Math.min(duration, Number(payload.anchor) || 0));
  var insertionStart = playhead - anchor;
  PremiereBindHost._applySmartTracks(sequence,items,insertionStart);

  var plans = [];
  var root = app.project.rootItem;
  for (var index = 0; index < items.length; index++) {
    var item = items[index] || {};
    var kind = item.type === "audio" ? "audio" : "video";
    var trackIndex = Math.max(0, typeof item._smartTrackIndex === "number" ? item._smartTrackIndex : Number(item.trackIndex) || 0);
    var tracks = kind === "audio" ? sequence.audioTracks : sequence.videoTracks;
    if (!tracks || trackIndex >= Number(tracks.numTracks || 0)) throw new Error("Track " + (kind === "audio" ? "A" : "V") + (trackIndex + 1) + " is not available in the active sequence.");
    var source = item.source || {};
    var projectItem = PremiereBindHost._findProjectItem(root, source.projectItemId, source.mediaPath);
    if (!projectItem) projectItem = PremiereBindHost._restoreMissingProjectItem(source.mediaPath);
    if (!projectItem) throw new Error("Source media was not found in the active project: " + String(item.title || source.name || "Clip"));
    plans.push({ presetId:String(payload && payload.presetId || "selection"), item:item, kind:kind, trackIndex:trackIndex, track:tracks[trackIndex], projectItem:projectItem, start:insertionStart + (Number(item.relativeStart) || 0) });
  }

  var inserted = [];
  for (var p = 0; p < plans.length; p++) {
    var plan = plans[p];
    var accepted = PremiereBindHost._insertSavedRange(plan);
    if (accepted === false) throw new Error("Premiere rejected insertion of " + String(plan.item.title || "a clip") + ".");
    var clip = PremiereBindHost._findInsertedClip(plan.track, plan.insertProjectItem || plan.projectItem, plan.start);
    var savedLabelColor = plan.savedLabelColor;
    if (clip && savedLabelColor !== null && typeof savedLabelColor !== "undefined" && typeof clip.setColorLabel === "function") {
      try { clip.setColorLabel(Number(savedLabelColor)); } catch (_) {}
    }
    var originalTrackIndex = plan.item.source && typeof plan.item.source.trackIndex === "number" ? Number(plan.item.source.trackIndex) : Number(plan.item.trackIndex) || 0;
    inserted.push({ title:String(plan.item.title || "Clip"), sourceName:String(plan.item.title || "Clip"), type:plan.kind, sourceTrackIndex:originalTrackIndex, sourceStartSeconds:Number(plan.item.sourceStartSeconds)||0, trackIndex:plan.trackIndex, startSeconds:plan.start, trimmed:Boolean(clip) });
  }
  var allTransitions = PremiereBindHost._transitionsForPlans(payload && payload.transitions || [], plans), videoTransitions = [], audioTransitions = [];
  for (var transitionIndex = 0; transitionIndex < allTransitions.length; transitionIndex++) {
    if (allTransitions[transitionIndex] && allTransitions[transitionIndex].type === "audio") audioTransitions.push(allTransitions[transitionIndex]);
    else videoTransitions.push(allTransitions[transitionIndex]);
  }
  var transitionResult = PremiereBindHost._applyTransitions(sequence, videoTransitions, inserted);
  transitionResult.pendingAudio = audioTransitions;
  return { count:inserted.length, playheadSeconds:playhead, insertionStartSeconds:insertionStart, items:inserted, transitions:transitionResult };
};

PremiereBindHost.applyTransitions = function (payload) {
  if (!app.project || !app.project.activeSequence) throw new Error("Open a sequence before restoring transitions.");
  return PremiereBindHost._applyTransitions(app.project.activeSequence, payload && payload.transitions || [], payload && payload.inserted || []);
};

PremiereBindHost.resolveInsertionTargets = function (payload) {
  if (!app.project || !app.project.activeSequence) throw new Error("Open a sequence before resolving insertion targets.");
  var sequence=app.project.activeSequence,mode=String(payload&&payload.mode||"playhead"),times=[];
  if(mode==="playhead"){
    var position=PremiereBindHost._timeData(sequence.getPlayerPosition()).seconds,snap=payload&&payload.playSnap;
    // Current Snap modes already describe the target explicitly. Only old
    // profiles without a mode need the legacy boundary-under-playhead lookup.
    if(snap&&snap.enabled&&!snap.mode){
      var trackName=String(snap.track||"auto").toLowerCase(),boundary=String(snap.boundary||"start"),candidates=[];
      var collect=function(tracks,wanted){if(!tracks)return;var n=Number(tracks.numTracks||0);for(var ti=0;ti<n;ti++){if(wanted>=0&&ti!==wanted)continue;var clips=tracks[ti]&&tracks[ti].clips,cn=Number(clips&&clips.numItems||0);for(var ci=0;ci<cn;ci++){var clip=clips[ci],st=Number(clip.start.seconds)||0,en=Number(clip.end.seconds)||0;if(position>=st-.04&&position<=en+.04)candidates.push({start:st,end:en});}}};
      if(trackName==="selected"){var selected=[];PremiereBindHost._collectSelectedTrackItems(sequence.videoTracks,"video",sequence,selected);PremiereBindHost._collectSelectedTrackItems(sequence.audioTracks,"audio",sequence,selected);for(var si=0;si<selected.length;si++)if(position>=selected[si].start.seconds-.04&&position<=selected[si].end.seconds+.04)candidates.push({start:selected[si].start.seconds,end:selected[si].end.seconds});}
      else if(/^v\d+$/.test(trackName))collect(sequence.videoTracks,Math.max(0,parseInt(trackName.substring(1),10)-1));
      else if(/^a\d+$/.test(trackName))collect(sequence.audioTracks,Math.max(0,parseInt(trackName.substring(1),10)-1));
      else{collect(sequence.videoTracks,-1);if(!candidates.length)collect(sequence.audioTracks,-1);}
      if(candidates.length)position=boundary==="end"?candidates[0].end:candidates[0].start;
    }
    times.push(position);
  }
  else if(mode.indexOf("clip-")===0){
    if(!(payload&&payload.snapHover===true)){
      var selectedTargets=[];
      PremiereBindHost._collectSelectedTrackItems(sequence.videoTracks,"video",sequence,selectedTargets);
      PremiereBindHost._collectSelectedTrackItems(sequence.audioTracks,"audio",sequence,selectedTargets);
      if(!selectedTargets.length)throw new Error("Select one or more timeline clips before using Start or End of Selected Clips.");
      for(var selectedIndex=0;selectedIndex<selectedTargets.length;selectedIndex++){
        if(mode==="clip-start"||mode==="clip-start-end")times.push(Number(selectedTargets[selectedIndex].start.seconds)||0);
        if(mode==="clip-end"||mode==="clip-start-end")times.push(Number(selectedTargets[selectedIndex].end.seconds)||0);
      }
    }else{
    var snapConfig=payload&&payload.playSnap||{},playhead=PremiereBindHost._timeData(sequence.getPlayerPosition()).seconds,watch=String(snapConfig.track||"auto").toLowerCase(),hovered=[];
    var collectHovered=function(tracks,wanted,type,selectedOnly){if(!tracks)return;var trackCount=Number(tracks.numTracks||0);for(var trackIndex=0;trackIndex<trackCount;trackIndex++){if(wanted>=0&&trackIndex!==wanted)continue;var clips=tracks[trackIndex]&&tracks[trackIndex].clips,clipCount=Number(clips&&clips.numItems||0);for(var clipIndex=0;clipIndex<clipCount;clipIndex++){var clip=clips[clipIndex],isSelected=true;if(selectedOnly)try{isSelected=Boolean(clip&&typeof clip.isSelected==="function"&&clip.isSelected());}catch(_){isSelected=false;}if(!isSelected)continue;var start=Number(clip.start.seconds)||0,end=Number(clip.end.seconds)||0;if(playhead>=start-.04&&playhead<=end+.04)hovered.push({start:start,end:end,type:type,trackIndex:trackIndex});}}};
    if(watch==="selected"){collectHovered(sequence.videoTracks,-1,"video",true);collectHovered(sequence.audioTracks,-1,"audio",true);}
    else if(/^v\d+$/.test(watch))collectHovered(sequence.videoTracks,Math.max(0,parseInt(watch.substring(1),10)-1),"video",false);
    else if(/^a\d+$/.test(watch))collectHovered(sequence.audioTracks,Math.max(0,parseInt(watch.substring(1),10)-1),"audio",false);
    else{var preferred=String(payload&&payload.preferredTrackKind||"mixed");if(preferred==="audio")collectHovered(sequence.audioTracks,-1,"audio",false);else if(preferred==="video")collectHovered(sequence.videoTracks,-1,"video",false);else{collectHovered(sequence.videoTracks,-1,"video",false);if(!hovered.length)collectHovered(sequence.audioTracks,-1,"audio",false);}}
    if(!hovered.length)throw new Error("No clip is under the playhead on the selected target.");
    var hoveredClip=hovered[0];if(mode==="clip-start"||mode==="clip-start-end")times.push(hoveredClip.start);if(mode==="clip-end"||mode==="clip-start-end")times.push(hoveredClip.end);
    }
  }else{
    var markers=sequence.markers;if(!markers)throw new Error("Sequence markers are unavailable.");var marker=markers.getFirstMarker();var wantedName=String(payload&&payload.name||"").toLowerCase();var wantedColor=Number(payload&&payload.colorIndex);
    if(mode==="marker-name"&&!wantedName)throw new Error("Enter a marker name.");
    while(marker){var include=mode==="all-markers";if(mode==="marker-name")include=String(marker.name||"").toLowerCase().indexOf(wantedName)>=0;if(mode==="marker-color"){var color=-1;try{color=Number(marker.getColorByIndex());}catch(_){}include=color===wantedColor;}if(include)times.push(PremiereBindHost._timeData(marker.start).seconds);marker=markers.getNextMarker(marker);}
  }
  var seen={},unique=[];times.sort(function(a,b){return a-b;});for(var i=0;i<times.length;i++){var key=Number(times[i]).toFixed(9);if(!seen[key]){seen[key]=true;unique.push(Number(times[i]));}}
  if(!unique.length)throw new Error("No matching insertion targets were found.");return {mode:mode,times:unique,count:unique.length,snapHover:Boolean(payload&&payload.snapHover===true)};
};

PremiereBindHost.getActiveSequenceTracks = function () {
  if (!app.project || !app.project.activeSequence) throw new Error("Open a sequence before reading tracks.");
  var sequence = app.project.activeSequence;
  return { videoCount:Number(sequence.videoTracks && sequence.videoTracks.numTracks || 0), audioCount:Number(sequence.audioTracks && sequence.audioTracks.numTracks || 0) };
};

PremiereBindHost.chooseExportPath = function (payload) {
  var suggested = String(payload && payload.suggestedName || "PremiereBind Library.prbind").replace(/[\\\/:*?\"<>|]/g, "-");
  if (!/\.prbind$/i.test(suggested)) suggested += ".prbind";
  var filter = /Windows/i.test(String($.os || "")) ? "PremiereBind package:*.prbind" : function (entry) { return entry instanceof Folder || /\.prbind$/i.test(String(entry.name || "")); };
  var chosen = File.saveDialog("Export PremiereBind library as " + suggested, filter);
  if (!chosen) return { cancelled:true, path:"" };
  var path = String(chosen.fsName || chosen.fullName || "");
  if (!/\.prbind$/i.test(path)) path += ".prbind";
  return { cancelled:false, path:path };
};

PremiereBindHost.chooseImportPath = function () {
  var filter = /Windows/i.test(String($.os || "")) ? "PremiereBind packages:*.prbind;*.json" : function (entry) { return entry instanceof Folder || /\.(prbind|json)$/i.test(String(entry.name || "")); };
  var chosen = File.openDialog("Import PremiereBind library", filter, false);
  return { cancelled:!chosen, path:chosen ? String(chosen.fsName || chosen.fullName || "") : "" };
};

PremiereBindHost.dispatch = function (method, payloadJson) {
  try {
    var handlers = { activateNativeTimeline:PremiereBindHost.activateNativeTimeline, cancelNativeInsert:PremiereBindHost.cancelNativeInsert, captureNativeLibrary:PremiereBindHost.captureNativeLibrary, beginNativeInsert:PremiereBindHost.beginNativeInsert, prepareNativeInsertTarget:PremiereBindHost.prepareNativeInsertTarget, confirmNativeInsertTarget:PremiereBindHost.confirmNativeInsertTarget, completeNativeInsert:PremiereBindHost.completeNativeInsert, getMarkerContext:PremiereBindHost.getMarkerContext, getMarkerPlan:PremiereBindHost.getMarkerPlan, createGeneratedMarkers:PremiereBindHost.createGeneratedMarkers, clearGeneratedMarkers:PremiereBindHost.clearGeneratedMarkers, ping: PremiereBindHost.ping, saveProject:PremiereBindHost.saveProject, readTimelineSelection: PremiereBindHost.readTimelineSelection, insertPresetAtPlayhead: PremiereBindHost.insertPresetAtPlayhead, applyTransitions:PremiereBindHost.applyTransitions, resolveInsertionTargets: PremiereBindHost.resolveInsertionTargets, getActiveSequenceTracks:PremiereBindHost.getActiveSequenceTracks, chooseExportPath:PremiereBindHost.chooseExportPath, chooseImportPath:PremiereBindHost.chooseImportPath };
    if (!handlers[method]) return PremiereBindHost._failure("UNKNOWN_METHOD", "Unknown host method: " + method);
    var payload = {};
    if (payloadJson) {
      try { payload = eval("(" + payloadJson + ")"); }
      catch (parseError) { return PremiereBindHost._failure("INVALID_PAYLOAD", "The host payload is not valid JSON."); }
    }
    return PremiereBindHost._success(handlers[method](payload));
  } catch (error) {
    return PremiereBindHost._failure("HOST_EXCEPTION", error && error.message ? error.message : String(error), {
      line: error && error.line ? Number(error.line) : null,
      fileName: error && error.fileName ? String(error.fileName) : null
    });
  }
};

