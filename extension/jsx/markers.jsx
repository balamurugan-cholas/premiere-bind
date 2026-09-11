(function (host) {
  var GENERATED_TAG = "PremiereBind:auto";
  function timeSeconds(value) { return host._timeData(value).seconds; }
  function unique(values) {
    var seen = {}, output = [];
    values.sort(function (a, b) { return Number(a) - Number(b); });
    for (var i = 0; i < values.length; i++) {
      var value = Number(values[i]), key = value.toFixed(6);
      if (isFinite(value) && value >= 0 && !seen[key]) { seen[key] = true; output.push(value); }
    }
    return output;
  }
  function allClips(sequence) {
    var output = [], kinds = ["video", "audio"];
    for (var k = 0; k < kinds.length; k++) {
      var tracks = kinds[k] === "audio" ? sequence.audioTracks : sequence.videoTracks;
      for (var t = 0; t < Number(tracks && tracks.numTracks || 0); t++) {
        var clips = tracks[t] && tracks[t].clips;
        for (var c = 0; c < Number(clips && clips.numItems || 0); c++) {
          var clip = clips[c];
          output.push({ clip:clip, type:kinds[k], trackIndex:t, start:timeSeconds(clip.start), end:timeSeconds(clip.end), inPoint:timeSeconds(clip.inPoint), speed:(function(){try{return Math.abs(Number(clip.getSpeed())||1);}catch(_){return 1;}})(), mediaPath:host._readMediaPath(clip.projectItem), name:String(clip.name||"") });
        }
      }
    }
    return output;
  }
  function selectedClips(sequence) {
    var items = [], selected = [];
    host._collectSelectedTrackItems(sequence.videoTracks, "video", sequence, items);
    host._collectSelectedTrackItems(sequence.audioTracks, "audio", sequence, items);
    var clips = allClips(sequence);
    for (var i = 0; i < clips.length; i++) for (var j = 0; j < items.length; j++)
      if (clips[i].type === items[j].type && clips[i].trackIndex === items[j].trackIndex && Math.abs(clips[i].start-items[j].start.seconds)<0.00001) { selected.push(clips[i]); break; }
    return selected;
  }
  function mergeRanges(ranges) {
    ranges.sort(function(a,b){return a.start-b.start;});var output=[];
    for(var i=0;i<ranges.length;i++){if(!(ranges[i].end>ranges[i].start))continue;var last=output[output.length-1];if(last&&ranges[i].start<=last.end+0.000001)last.end=Math.max(last.end,ranges[i].end);else output.push({start:ranges[i].start,end:ranges[i].end});}
    return output;
  }
  function timelineEnd(sequence) {
    var end=0;
    try{end=timeSeconds(sequence.end);}catch(_){}
    // `Sequence.end` is intermittently zero/stale after native timeline
    // switching. The visible timeline still has a reliable end on its clips.
    var clips=allClips(sequence);
    for(var i=0;i<clips.length;i++)end=Math.max(end,Number(clips[i].end)||0);
    try{if(!(end>0)&&typeof sequence.getOutPointAsTime==="function")end=Math.max(end,timeSeconds(sequence.getOutPointAsTime()));}catch(__){}
    return end;
  }
  function scopeRanges(sequence, scope) {
    scope=String(scope||"timeline").toLowerCase();
    if(scope==="timeline"){var end=timelineEnd(sequence);return end>0?[{start:0,end:end}]:[];}
    if(scope==="selected"){var chosen=selectedClips(sequence),selectedRanges=[];if(!chosen.length)throw new Error("Select one or more timeline clips before using the Selected Clips scope.");for(var i=0;i<chosen.length;i++)selectedRanges.push({start:chosen[i].start,end:chosen[i].end});return mergeRanges(selectedRanges);}
    if(scope==="inout"){
      var start=0,end=0;try{start=timeSeconds(sequence.getInPointAsTime());end=timeSeconds(sequence.getOutPointAsTime());}catch(_){try{start=Number(sequence.getInPoint())||0;end=Number(sequence.getOutPoint())||0;}catch(__){}}
      if(!(end>start))throw new Error("Set a valid sequence In and Out range before using the In / Out scope.");return[{start:start,end:end}];
    }
    throw new Error("Unknown marker scope: "+scope);
  }
  function within(values,ranges){var sorted=unique(values),output=[];for(var v=0;v<sorted.length;v++){for(var i=0;i<ranges.length;i++){if(sorted[v]>=ranges[i].start-0.000001&&sorted[v]<ranges[i].end-0.000001){output.push(sorted[v]);break;}}}return output;}
  function colorGeneratedMarkers(markers,times,color){
    var marker=null,colored=0;
    try{marker=markers.getFirstMarker();}catch(_){return 0;}
    while(marker){
      var next=null;try{next=markers.getNextMarker(marker);}catch(_){}
      var owned=false,start=-1;try{owned=String(marker.comments||"").indexOf(GENERATED_TAG)>=0;}catch(_){}try{start=timeSeconds(marker.start);}catch(_){}
      if(owned)for(var i=0;i<times.length;i++)if(Math.abs(start-Number(times[i]))<.001){try{marker.setColorByIndex(color);colored++;}catch(_){}break;}
      marker=next;
    }
    return colored;
  }
  function transitionTimes(sequence){var result=[];try{app.enableQE();var q=qe.project.getActiveSequence();for(var t=0;t<Number(q.numVideoTracks||0);t++){var track=q.getVideoTrackAt(t);for(var i=0;i<Number(track.numTransitions||0);i++){var tr=track.getTransitionAt(i);if(!tr)continue;var name="";try{name=String(tr.name||"");}catch(_){}if(!name||/^Empty$/i.test(name))continue;var start=host._qeSeconds(tr.start),end=host._qeSeconds(tr.end);if(isFinite(start)&&isFinite(end)&&end>=start){result.push(start);result.push(end);}}}}catch(_){}return result;}
  function parameterKeys(prop){var keys=[];try{keys=prop.getKeys()||[];}catch(_){}return keys;}
  function keyTimelineTimes(keys,clip){
    var raw=[],i;for(i=0;i<keys.length;i++){var value=timeSeconds(keys[i]);if(isFinite(value))raw.push(value);}
    var speed=Math.max(.000001,Math.abs(Number(clip.speed)||1)),sourceIn=Number(clip.inPoint)||0,epsilon=.0001;
    var maps=[function(value){return clip.start+((value-sourceIn)/speed);},function(value){return clip.start+(value/speed);},function(value){return value;}],best=[],bestCount=-1;
    for(var m=0;m<maps.length;m++){var mapped=[],inside=0;for(i=0;i<raw.length;i++){var time=maps[m](raw[i]);mapped.push(time);if(time>=clip.start-epsilon&&time<=clip.end+epsilon)inside++;}if(inside>bestCount){bestCount=inside;best=mapped;}}
    var output=[];for(i=0;i<best.length;i++)if(best[i]>=clip.start-epsilon&&best[i]<=clip.end+epsilon)output.push(best[i]);return output;
  }
  function effectData(clips, wanted, listOnly) {
    var times=[],options=[],seen={};
    for(var c=0;c<clips.length;c++){var clip=clips[c],components=clip.clip.components,count=Number(components&&components.numItems||0);for(var ci=0;ci<count;ci++){var component=components[ci],display=String(component.displayName||component.matchName||"Effect"),match=String(component.matchName||display),props=component.properties,pcount=Number(props&&props.numItems||0);for(var pi=0;pi<pcount;pi++){var prop=props[pi],pname=String(prop.displayName||"Parameter "+(pi+1)),id=match+"::"+pname,keys=parameterKeys(prop);if(keys.length<2)continue;if(!seen[id]){seen[id]=true;options.push({id:id,label:display+" - "+pname});}if(listOnly||(wanted&&wanted!=="all"&&wanted!==id))continue;var mapped=keyTimelineTimes(keys,clip);for(var ki=0;ki<mapped.length;ki++)times.push(mapped[ki]);}
    }}return{times:times,options:options};
  }
  host.getMarkerContext=function(payload){var sequence=app.project.activeSequence;if(!sequence)throw new Error("Open a sequence first.");var clips=String(payload&&payload.scope||"timeline")==="selected"?selectedClips(sequence):allClips(sequence),effects=effectData(clips,"all",true);return{selectedClipCount:selectedClips(sequence).length,effectTargets:effects.options};};
  host.getMarkerPlan=function(payload){var sequence=app.project.activeSequence;if(!sequence)throw new Error("Open a sequence first.");var mode=String(payload.mode||"boundaries"),ranges=scopeRanges(sequence,mode==="boundaries"?"selected":payload.scope),clips=allClips(sequence),times=[],audio=[];
    if(mode==="boundaries"){var chosen=selectedClips(sequence),boundary=String(payload.boundary||"both");for(var i=0;i<chosen.length;i++){if(boundary==="start"||boundary==="both")times.push(chosen[i].start);if(boundary==="end"||boundary==="both")times.push(chosen[i].end);}}
    else if(mode==="interval"){var value=Number(payload.intervalValue);if(!(value>0))throw new Error("Enter an interval greater than zero.");var unit=String(payload.intervalUnit||"seconds");if(unit==="minutes")value*=60;if(unit==="frames"){var frame=.033333;try{frame=Number(sequence.getSettings().videoFrameRate.seconds)||frame;}catch(_){}value*=frame;}for(var r=0;r<ranges.length;r++)for(var at=ranges[r].start;at<ranges[r].end-.000001;at+=value)times.push(at);}
    else if(mode==="cuts"){for(i=0;i<clips.length;i++){times.push(clips[i].start);times.push(clips[i].end);}}
    else if(mode==="transitions"){times=transitionTimes(sequence);if(!times.length){for(i=0;i<clips.length;i++)times.push(clips[i].end);}}
    else if(mode==="effects")times=effectData(clips,String(payload.effectTarget||"all"),false).times;
    else if(mode==="beats"){for(i=0;i<clips.length;i++)if(clips[i].type==="audio"&&clips[i].mediaPath)audio.push(clips[i]);if(!audio.length)throw new Error("Premiere did not expose a readable media file for the audio clip.");}
    else throw new Error("Unknown marker mode: "+mode);
    return{mode:mode,times:within(times,ranges),ranges:ranges,audioClips:audio};
  };
  host.createGeneratedMarkers=function(payload){var sequence=app.project.activeSequence;if(!sequence)throw new Error("Open a sequence first.");var times=unique(payload.times||[]);if(times.length>10000)throw new Error("This would create more than 10,000 markers. Use a larger interval or smaller scope.");var mode=String(payload.mode||"markers"),name=String(payload.name||"").replace(/^\s+|\s+$/g,"")||(mode==="boundaries"?"Auto-clip-boundaries":"Auto-"+mode),duration=Math.max(0,Number(payload.duration)||0),color=Math.max(0,Math.min(7,Number(payload.colorIndex)||0)),created=0,markers=sequence.markers,project=app.project,i;
    if(times.length&&markers&&typeof markers.createAddMarkerAction==="function"&&project&&typeof project.executeTransaction==="function"){
      var runTransaction=function(){project.executeTransaction(function(compoundAction){for(i=0;i<times.length;i++){var action=markers.createAddMarkerAction(name,"comment",host._makeTime(times[i]),host._makeTime(duration),GENERATED_TAG);if(action){compoundAction.addAction(action);created++;}}},"PremiereBind: Create "+times.length+" Markers");};
      if(typeof project.lockedAccess==="function")project.lockedAccess(runTransaction);else runTransaction();
      if(created){colorGeneratedMarkers(markers,times,color);return{mode:payload.mode,count:created,undoGrouped:true,colorIndex:color};}
    }
    for(i=0;i<times.length;i++){var marker=markers.createMarker(times[i]);if(!marker)continue;try{marker.name=name;}catch(_){}try{marker.comments=GENERATED_TAG;}catch(_){}try{marker.setColorByIndex(color);}catch(_){}if(duration>0)try{marker.end=host._makeTime(times[i]+duration);}catch(_){}created++;}return{mode:payload.mode,count:created};};
  host.clearGeneratedMarkers=function(){var sequence=app.project.activeSequence;if(!sequence)throw new Error("Open a sequence first.");var markers=sequence.markers,marker=markers.getFirstMarker(),remove=[],count=0;while(marker){var next=markers.getNextMarker(marker),owned=false;try{owned=String(marker.comments||"").indexOf(GENERATED_TAG)>=0;}catch(_){}if(owned)remove.push(marker);marker=next;}for(var i=0;i<remove.length;i++)try{markers.deleteMarker(remove[i]);count++;}catch(_){}return{count:count};};
})(PremiereBindHost);
