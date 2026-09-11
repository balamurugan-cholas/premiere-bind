(function(global){
  'use strict';
  var colorIndices={green:0,red:1,purple:2,orange:3,yellow:4,white:5,blue:6,cyan:7};
  function unique(values){var seen={},out=[];(values||[]).sort(function(a,b){return a-b;}).forEach(function(raw){var n=Number(raw),key=n.toFixed(6);if(isFinite(n)&&n>=0&&!seen[key]){seen[key]=true;out.push(n);}});return out;}
  function inRanges(value,ranges){for(var i=0;i<ranges.length;i++)if(value>=Number(ranges[i].start)-.000001&&value<Number(ranges[i].end)-.000001)return true;return false;}
  function mapBeats(plan,sensitivity){
    var clips=plan.audioClips||[],ranges=plan.ranges||[],byPath={},jobs=[];
    clips.forEach(function(clip){if(!byPath[clip.mediaPath]){byPath[clip.mediaPath]=[];jobs.push(global.PremiereBindCompanion.analyzeAudioBeats(clip.mediaPath,sensitivity).then(function(result){byPath[clip.mediaPath]=(result&&result.beats)||[];}));}});
    return Promise.all(jobs).then(function(){var times=[];clips.forEach(function(clip){var rawSpeed=Math.abs(Number(clip.speed)||1),speed=Math.max(.000001,rawSpeed>10?rawSpeed/100:rawSpeed),sourceIn=Math.max(0,Number(clip.inPoint)||0),start=Number(clip.start)||0,end=Number(clip.end)||0,mappedCount=0,beats=byPath[clip.mediaPath]||[];beats.forEach(function(beat){var mapped=start+((Number(beat)-sourceIn)/speed);if(mapped>=start-.000001&&mapped<end-.000001&&inRanges(mapped,ranges)){times.push(mapped);mappedCount++;}});if(!mappedCount)beats.forEach(function(beat){var mapped=start+(Number(beat)/speed);if(mapped>=start&&mapped<end-.000001&&inRanges(mapped,ranges))times.push(mapped);});});var spacing={low:1.4,balanced:.65,high:.12}[String(sensitivity||'balanced').toLowerCase()]||.65,filtered=[];unique(times).forEach(function(value){if(!filtered.length||value-filtered[filtered.length-1]>=spacing)filtered.push(value);});return filtered;});
  }
  function context(scope){return global.PremiereBindBridge.call('getMarkerContext',{scope:scope||'timeline'});}
  function generate(options){
    options=options||{};var mode=options.mode||'boundaries',durationText=String(options.duration===undefined?'':options.duration).trim().replace(',','.');if(durationText&&(!isFinite(Number(durationText))||Number(durationText)<0))return Promise.reject(new Error('Marker duration must be zero or a positive number of seconds.'));
    return global.PremiereBindBridge.call('getMarkerPlan',options).then(function(plan){
      if(mode!=='beats')return plan.times||[];
      if(!global.PremiereBindCompanion||!global.PremiereBindCompanion.analyzeAudioBeats)throw new Error('The PremiereBind companion must be connected to analyze audio beats.');
      return mapBeats(plan,options.sensitivity||'balanced');
    }).then(function(times){return global.PremiereBindBridge.call('createGeneratedMarkers',{times:unique(times),mode:mode,name:options.name||'',duration:Math.max(0,Number(options.duration)||0),colorIndex:colorIndices[options.color]===undefined?5:colorIndices[options.color]});});
  }
  function clear(){return global.PremiereBindBridge.call('clearGeneratedMarkers',{});}
  global.PremiereBindMarkers={context:context,generate:generate,clear:clear,_mapBeats:mapBeats};
})(window);
