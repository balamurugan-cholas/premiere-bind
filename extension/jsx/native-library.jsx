/* Native library sequences retain Premiere's non-factory Custom Fade data. */
(function (host) {
  // Keep closed source-sequence handles: Premiere may omit closed tabs from enumeration.
  var cachedLibraries=host._nativeLibraries||{};host._nativeLibraries=cachedLibraries;
  function libraryBin(){var root=app.project.rootItem,children=root.children;for(var i=0;i<children.numItems;i++)if(String(children[i].name)==="PremiereBind"&&Number(children[i].type)===2)return children[i];return root.createBin("PremiereBind");}
  function organize(sequence){var bin=libraryBin();if(!bin)throw new Error("Could not create the PremiereBind project bin.");if(sequence.projectItem)sequence.projectItem.moveBin(bin);return sequence;}
  function sequences() {
    var result = [], list = app.project.sequences;
    for (var i = 0; i < list.numSequences; i++) result.push(list[i]);
    return result;
  }
  function clips(sequence) {
    var result = [], kinds = ["video", "audio"];
    for (var k = 0; k < kinds.length; k++) {
      var tracks = kinds[k] === "audio" ? sequence.audioTracks : sequence.videoTracks;
      for (var t = 0; t < tracks.numTracks; t++)
        for (var c = 0; c < tracks[t].clips.numItems; c++)
          result.push({ clip:tracks[t].clips[c], type:kinds[k], trackIndex:t });
    }
    return result;
  }
  function projectItemExists(projectItem){
    if(!projectItem||!app.project||!app.project.rootItem)return false;
    var wanted=host._projectItemId?host._projectItemId(projectItem):String(projectItem.nodeId||projectItem.treePath||"");
    if(!wanted)return false;
    var visit=function(item){if(!item)return false;var id=host._projectItemId?host._projectItemId(item):String(item.nodeId||item.treePath||"");if(id===wanted)return true;var children=null;try{children=item.children;}catch(_){}if(children)for(var i=0;i<Number(children.numItems||0);i++)if(visit(children[i]))return true;return false;};
    return visit(app.project.rootItem);
  }
  function identityHash(value){var text=String(value||""),hash=2166136261;for(var i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash+=(hash<<1)+(hash<<4)+(hash<<7)+(hash<<8)+(hash<<24);}return(hash>>>0).toString(36);}
  function snapshotFingerprint(selection){
    var parts=[],items=selection.items||[],transitions=selection.transitions||[],i,item,locator,transition;
    for(i=0;i<items.length;i++){item=items[i]||{};locator=item.locator||{};parts.push(["clip",item.type,Number(item.trackIndex)||0,Number(item.start&&item.start.seconds)||0,Number(item.end&&item.end.seconds)||0,Number(item.inPoint&&item.inPoint.seconds)||0,Number(item.outPoint&&item.outPoint.seconds)||0,String(locator.mediaPath||item.mediaPath||""),String(locator.projectItemId||item.projectItemId||"")].join("|"));}
    for(i=0;i<transitions.length;i++){transition=transitions[i]||{};parts.push(["transition",transition.type,Number(transition.trackIndex)||0,Number(transition.startSeconds)||0,Number(transition.endSeconds)||0,String(transition.matchName||""),String(transition.title||"")].join("|"));}
    return identityHash(parts.join("\n"));
  }
  function matches(entry, item) {
    var locator = item.locator || item.source || item;
    return entry.type === locator.type && entry.trackIndex === Number(locator.trackIndex) &&
      Math.abs(Number(entry.clip.start.seconds) - Number(locator.startSeconds)) < 0.00001 &&
      host._projectItemId(entry.clip.projectItem) === String(locator.projectItemId);
  }
  function findSequence(id) {
    var all = sequences();
    for (var i = 0; i < all.length; i++) if (String(all[i].sequenceID) === String(id)) return all[i];
    for(var key in cachedLibraries){var entry=cachedLibraries[key];try{if(key.indexOf(String(app.project.path||"")+"|")===0&&entry&&String(entry.sequenceID)===String(id)&&projectItemExists(entry.projectItem)) return entry;}catch(_){} }
    return null;
  }
  function librarySequence(payload){
    var key=String(app.project.path||"")+"|"+String(payload.projectPath||payload.sequenceID),source=cachedLibraries[key],all=sequences(),i;
    try{if(source&&projectItemExists(source.projectItem)){organize(source);return source;}delete cachedLibraries[key];}catch(_){delete cachedLibraries[key];}
    source=findSequence(payload.sequenceID);
    if(!source&&payload.sequenceName&&String(payload.sequenceName).indexOf("PremiereBind Library - ")===0){for(i=0;i<all.length;i++)if(String(all[i].name)===String(payload.sequenceName)){source=all[i];break;}}
    if(!source){
      if(!payload.projectPath)throw new Error("Save this selection again to create its native snapshot.");
      var bin=libraryBin(),root=app.project.rootItem,prior={},added=[],r;
      for(r=0;r<root.children.numItems;r++)prior[String(root.children[r].nodeId)]=true;
      app.project.importSequences(String(payload.projectPath),[String(payload.sequenceID)]);
      for(r=0;r<root.children.numItems;r++)if(!prior[String(root.children[r].nodeId)])added.push(root.children[r]);
      for(r=0;r<added.length;r++)added[r].moveBin(bin);
      source=findSequence(payload.sequenceID);all=sequences();
      if(!source)for(i=0;i<all.length;i++)if(String(all[i].name)===String(payload.sequenceName)){source=all[i];break;}
    }
    if(!source)throw new Error("Premiere did not import the saved source sequence.");
    organize(source);cachedLibraries[key]=source;return source;
  }

  function freshLibrarySequence(payload){
    if(!payload.projectPath)throw new Error("Save this True Nest again to create its private hierarchy.");
    var before={},all=sequences(),i;for(i=0;i<all.length;i++)before[String(all[i].sequenceID)]=true;
    app.project.importSequences(String(payload.projectPath),[String(payload.sequenceID)]);
    all=sequences();var added=[],source=null;
    for(i=0;i<all.length;i++)if(!before[String(all[i].sequenceID)]){added.push(all[i]);if(String(all[i].name)===String(payload.sequenceName))source=all[i];}
    if(!source&&added.length)source=added[added.length-1];
    if(!source)throw new Error("Premiere reused the existing nest instead of creating an independent True Nest copy.");
    for(i=0;i<added.length;i++)organize(added[i]);
    return source;
  }

  function activate(sequence){if(!app.project.activeSequence||String(app.project.activeSequence.sequenceID)!==String(sequence.sequenceID))app.project.openSequence(sequence.sequenceID);}
  function targets(sequence){var result={video:[],audio:[]},k,t,list;for(k in result){list=k==="video"?sequence.videoTracks:sequence.audioTracks;for(t=0;t<list.numTracks;t++)result[k].push(list[t].isTargeted());}return result;}
  function trackLocks(sequence){var result={video:[],audio:[]},k,t,list;for(k in result){list=k==="video"?sequence.videoTracks:sequence.audioTracks;for(t=0;t<list.numTracks;t++){try{result[k].push(Boolean(list[t].isLocked()));}catch(_){result[k].push(false);}}}return result;}
  function restore(state){var target=findSequence(state.targetSequenceID);if(!target)return;activate(target);target=app.project.activeSequence||target;var k,t,list;if(state.targetLocks)for(k in state.targetLocks){list=k==="video"?target.videoTracks:target.audioTracks;for(t=0;t<list.numTracks;t++)if(typeof list[t].setLocked==="function")try{list[t].setLocked(state.targetLocks[k][t]?1:0);}catch(_){}}for(k in state.targetTracks){list=k==="video"?target.videoTracks:target.audioTracks;for(t=0;t<list.numTracks;t++)list[t].setTargeted(Boolean(state.targetTracks[k][t]),false);}target.setPlayerPosition(state.originalPlayheadTicks);if(state.closeSource){var source=findSequence(state.sourceSequenceID);if(source&&String(source.sequenceID)!==String(target.sequenceID)){try{source.close();}catch(_){}if(state.deleteSource&&typeof app.project.deleteSequence==="function")try{app.project.deleteSequence(source);}catch(_){}}}}
  host.cancelNativeInsert=function(payload){restore(payload);return{restored:true};};
  host.beginNativeInsert = function (payload) {
    var target = app.project.activeSequence;
    if (!target) throw new Error("Open the destination sequence before inserting.");
    var state={targetSequenceID:String(target.sequenceID),originalPlayheadTicks:String(target.getPlayerPosition().ticks),targetTracks:targets(target)};
    var snapshot=payload.snapshot||{},nativeSnapshot=Boolean(snapshot.projectPath),source;
    try{source=nativeSnapshot?(payload.trueNest===true?freshLibrarySequence(snapshot):librarySequence(snapshot)):findSequence(payload.sourceSequenceID);}catch(error){restore(state);throw error;}
    if(!source)throw new Error("The source is unavailable. Save this selection again.");
    state.sourceSequenceID=String(source.sequenceID);state.closeSource=nativeSnapshot;state.deleteSource=Boolean(nativeSnapshot&&payload.trueNest===true);
    activate(source);
    var entries = clips(source), wanted = payload.items || [], selected = [], i, j;
    for (i = 0; i < entries.length; i++) try { entries[i].clip.setSelected(false, true); } catch (_) {}
    for (i = 0; i < entries.length; i++) {
      for (j = 0; j < wanted.length; j++) {
        if (nativeSnapshot ? (entries[i].type===wanted[j].type && entries[i].trackIndex===Number(wanted[j].source.trackIndex) && Math.abs(Number(entries[i].clip.start.seconds)-Number(wanted[j].source.startSeconds))<.00001) : matches(entries[i], wanted[j])) { entries[i].clip.setSelected(true, true); selected.push(entries[i]); break; }
      }
    }
    if (selected.length !== wanted.length) {
      restore(state);
      throw new Error("Some original source clips were moved or deleted. Save this selection again to refresh its native transition source.");
    }
    state.clipCount=selected.length;return state;
  };
  host.activateNativeTimeline=function(payload){
    var sequence=findSequence(payload.sequenceID);if(!sequence)throw new Error("The requested timeline is unavailable.");
    if(payload.requestActivation){app.project.openSequence(sequence.sequenceID);
      if(payload.closeSourceSequenceID&&String(payload.closeSourceSequenceID)!==String(sequence.sequenceID)){var source=findSequence(payload.closeSourceSequenceID);if(source)source.close();}
    }
    var active=app.project.activeSequence;
    return {ready:Boolean(active&&String(active.sequenceID)===String(sequence.sequenceID)),activeSequenceID:active?String(active.sequenceID):""};
  };
  host.prepareNativeInsertTarget = function (payload) {
    var target = findSequence(payload.targetSequenceID);
    if (!target) throw new Error("The destination sequence is unavailable.");
    if(!app.project.activeSequence||String(app.project.activeSequence.sequenceID)!==String(target.sequenceID))throw new Error("Destination activation must finish before preparing tracks.");
    // Premiere can leave an older Sequence handle with stale track/clip
    // collections after switching away to the private True Nest library and
    // back. Smart insertion must inspect the freshly activated destination;
    // otherwise a repeated nest can look collision-free and paste over V1/A1.
    target=app.project.activeSequence;
    var items = payload.items || [], insertionStart = Number(payload.targetSeconds) - Number(payload.anchor || 0);
    insertionStart=Math.max(0,insertionStart);
    (host._applyGeneralSmartTracks||host._applySmartTracks)(target,items,insertionStart);
    var existing=clips(target);for(var e=0;e<existing.length;e++)try{existing[e].clip.setSelected(false,true);}catch(_){}
    var vBase = -1, aBase = -1;
    for (var i = 0; i < items.length; i++) {
      var track = Number(items[i]._smartTrackIndex);
      if (items[i].type === "audio") aBase = aBase < 0 ? track : Math.min(aBase, track);
      else vBase = vBase < 0 ? track : Math.min(vBase, track);
    }
    for (i = 0; i < target.videoTracks.numTracks; i++) target.videoTracks[i].setTargeted(i === vBase, true);
    for (i = 0; i < target.audioTracks.numTracks; i++) target.audioTracks[i].setTargeted(i === aBase, true);
    // Native Paste can prefer Premiere's source-patch mapping over track
    // targeting. Temporarily lock every non-destination track so clipboard
    // inserts (True Nests and exact-transition selections) cannot overwrite
    // an occupied original track. The exact prior lock state is restored as
    // soon as Paste is verified or cancelled.
    var priorLocks=trackLocks(target),allowed={video:{},audio:{}},kind,list,t;
    for(i=0;i<items.length;i++){kind=items[i].type==="audio"?"audio":"video";allowed[kind][String(items[i]._smartTrackIndex)]=true;}
    for(kind in allowed){list=kind==="video"?target.videoTracks:target.audioTracks;for(t=0;t<list.numTracks;t++)if(typeof list[t].setLocked==="function")list[t].setLocked(allowed[kind][String(t)]?0:1);}
    target.setPlayerPosition(String(Math.round(insertionStart * 254016000000)));
    var actual = host._timeData(target.getPlayerPosition()).seconds;
    if (Math.abs(actual - insertionStart) > 0.05)
      throw new Error("Premiere did not move to the requested insertion position.");
    return { targetSequenceID:String(target.sequenceID), insertionStartSeconds:insertionStart, expectedClipCount:items.length, expectedItems:items, targetLocks:priorLocks };
  };
  host.confirmNativeInsertTarget = function (payload) {
    var sequence = app.project.activeSequence;
    if (!sequence || String(sequence.sequenceID) !== String(payload.targetSequenceID))
      throw new Error("Premiere has not activated the destination timeline yet.");
    var actual = host._timeData(sequence.getPlayerPosition()).seconds;
    if (Math.abs(actual - Number(payload.insertionStartSeconds)) > 0.05)
      throw new Error("The destination playhead moved before native Paste.");
    return payload;
  };
  host.completeNativeInsert = function (payload) {
    var sequence=app.project.activeSequence,selected=[],i,j,matched={},expected=payload.expectedItems||[],epsilon=.05;
    try {
      if(!sequence||String(sequence.sequenceID)!==String(payload.targetSequenceID))throw new Error("The destination timeline changed during Paste.");
      host._collectSelectedTrackItems(sequence.videoTracks,"video",sequence,selected);
      host._collectSelectedTrackItems(sequence.audioTracks,"audio",sequence,selected);
      if(selected.length!==expected.length)throw new Error("Paste returned "+selected.length+" clips; expected "+expected.length+". The transfer was not verified.");
      for(i=0;i<expected.length;i++){
        var item=expected[i],found=false,start=Number(payload.insertionStartSeconds)+Number(item.relativeStart||0);
        for(j=0;j<selected.length;j++)if(!matched[j]&&selected[j].type===item.type&&selected[j].trackIndex===item._smartTrackIndex&&Math.abs(selected[j].start.seconds-start)<epsilon&&Math.abs(selected[j].end.seconds-(start+Number(item.duration)))<epsilon){matched[j]=true;found=true;break;}
        if(!found)throw new Error("Premiere pasted a clip at an unexpected time or track. No second paste was attempted.");
      }
      return {count:selected.length,items:selected,transitions:{applied:"native",failures:[],pendingAudio:[]}};
    } finally {restore(payload);}
  };
  host.captureNativeLibrary = function (payload) {
    var source=app.project.activeSequence;
    if(!source)throw new Error("Open the source timeline before saving.");
    var selected=host.readTimelineSelection(),fingerprint=snapshotFingerprint(selected)+"-"+String(payload.presetId||new Date().getTime()).replace(/[^a-zA-Z0-9_-]/g,""),sequenceName="PremiereBind Library - "+fingerprint,before={},all=sequences(),library=null,i,j;
    if(!selected.items.length)throw new Error("Select clips before saving.");
    var root=new Folder(Folder.userData.fsName+"/PremiereBind/native-library");if(!root.exists&&!root.create())throw new Error("Could not create native snapshot storage.");
    var file=new File(root.fsName+"/snapshot-"+fingerprint+".prproj");
    for(i=0;i<all.length;i++)if(String(all[i].name)===sequenceName){library=all[i];break;}
    if(library){organize(library);if(!file.exists||file.length===0)library.exportAsProject(file.fsName);cachedLibraries[String(app.project.path||"")+"|"+file.fsName]=library;return{version:4,fingerprint:fingerprint,sequenceID:String(library.sequenceID),sourceSequenceID:String(source.sequenceID),sequenceName:String(library.name),projectPath:file.fsName,clipCount:selected.items.length};}
    for(i=0;i<all.length;i++)before[String(all[i].sequenceID)]=true;
    try{
      if(source.clone()===false)throw new Error("Premiere could not preserve the selection.");
      all=sequences();for(i=0;i<all.length;i++)if(!before[String(all[i].sequenceID)]){if(library)throw new Error("Could not identify the cloned sequence uniquely.");library=all[i];}
      if(!library)throw new Error("Premiere did not create the source snapshot.");
      library.name=sequenceName;
      organize(library);
      var entries=clips(library),kept=0;
      for(i=entries.length-1;i>=0;i--){var keep=false;for(j=0;j<selected.items.length;j++)if(matches(entries[i],selected.items[j])){keep=true;break;}if(keep)kept++;else entries[i].clip.remove(false,false);}
      if(kept!==selected.items.length)throw new Error("The saved clip selection could not be verified.");
      library.exportAsProject(file.fsName);if(!file.exists||file.length===0)throw new Error("Premiere did not write the snapshot.");
      cachedLibraries[String(app.project.path||"")+"|"+file.fsName]=library;
      return {version:4,fingerprint:fingerprint,sequenceID:String(library.sequenceID),sourceSequenceID:String(source.sequenceID),sequenceName:String(library.name),projectPath:file.fsName,clipCount:kept};
    }finally{activate(source);if(library)try{library.close();}catch(_){} }
  };
})(PremiereBindHost);
