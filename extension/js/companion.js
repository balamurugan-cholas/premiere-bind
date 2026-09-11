(function(global){
  'use strict';
  var URL='ws://127.0.0.1:50900',socket=null,library=null,reconnectTimer=null,launchAttempted=false,busy={},lastExecuted={},requests={},requestCounter=0;

  function status(message){var el=document.getElementById('operation-status');if(el)el.textContent=message;}
  function nativePath(value){
    value=decodeURIComponent(String(value||'').replace(/^file:\/\//i,''));
    if(/^\/[A-Za-z]:\//.test(value))value=value.slice(1);
    return value.replace(/\//g,navigator.platform.indexOf('Win')===0?'\\':'/');
  }
  function extensionPath(){try{return nativePath(global.__adobe_cep__.getSystemPath('extension'));}catch(_){return'';}}
  function join(root,tail){var slash=navigator.platform.indexOf('Win')===0?'\\':'/';return root.replace(/[\\\/]$/,'')+slash+tail.replace(/[\\\/]/g,slash);}
  function launch(){
    if(launchAttempted)return;launchAttempted=true;
    var root=extensionPath(),isMac=/Mac/i.test(navigator.platform),bundled=isMac?'companion/macos/PremiereBindCompanion.app/Contents/MacOS/PremiereBindCompanion':'companion/PremiereBindCompanion.exe';
    var development=isMac?'../premiere bind/premierebind-companion/bin/macos/PremiereBindCompanion.app/Contents/MacOS/PremiereBindCompanion':'../premiere bind/premierebind-companion/bin/PremiereBindCompanion.exe';
    var candidates=[join(root,bundled),join(root,development)];
    try{
      if(global.cep&&global.cep.process&&typeof global.cep.process.createProcess==='function'){
        for(var i=0;i<candidates.length;i++){var pid=global.cep.process.createProcess(candidates[i]);if(Number(pid)>0)return;}
      }
    }catch(_){}
  }
  function activePresets(value){
    if(!value||!global.PremiereBindLibraryView)return[];
    var presets=global.PremiereBindLibraryView.collect(value,'').map(function(item){return{id:item.id,shortcut:item.shortcut||'',folder:false};}),profile=global.PremiereBindLibraryView.activeProfile(value);(profile&&profile.presets||[]).forEach(function(item){if((item.isFolder||Array.isArray(item.presets))&&item.shortcut)presets.push({id:item.id,shortcut:item.shortcut,folder:true});});presets=presets.filter(function(item){return Boolean(String(item.shortcut||'').trim());});
    presets.push({id:'save-selection',shortcut:String(value.saveShortcut||'Shift+S')});
    return presets;
  }
  function sync(){if(socket&&socket.readyState===WebSocket.OPEN&&library)socket.send(JSON.stringify({type:'syncShortcuts',presets:activePresets(library)}));}
  function waitForConnection(timeoutMs){
    return new Promise(function(resolve,reject){
      var started=Date.now();connect();launch();
      var timer=setInterval(function(){
        if(socket&&socket.readyState===WebSocket.OPEN){clearInterval(timer);resolve(socket);return;}
        if(Date.now()-started>Number(timeoutMs||10000)){clearInterval(timer);reject(new Error('PremiereBind could not start its helper.'));}
      },120);
    });
  }
  function request(type,payload,timeoutMs){
    return waitForConnection(10000).then(function(){return new Promise(function(resolve,reject){
      var requestId='cep-'+type+'-'+Date.now()+'-'+(++requestCounter),timer=setTimeout(function(){delete requests[requestId];reject(new Error('The PremiereBind helper timed out.'));},timeoutMs||30000);
      requests[requestId]={resolve:resolve,reject:reject,timer:timer};
      var message=payload||{};message.type=type;message.requestId=requestId;
      try{socket.send(JSON.stringify(message));}catch(error){clearTimeout(timer);delete requests[requestId];reject(error);}
    });});
  }
  function schedule(){if(reconnectTimer)return;reconnectTimer=setTimeout(function(){reconnectTimer=null;connect();},2000);}
  function normalizedCombo(value){return String(value||'').replace(/\s+/g,'').toUpperCase();}
  function execute(payload){
    if(!payload||!payload.presetId||busy[payload.presetId])return;
    var shortcutEntry=activePresets(library).filter(function(item){return item.id===payload.presetId;})[0];
    if(!shortcutEntry||normalizedCombo(payload.combo)!==normalizedCombo(shortcutEntry.shortcut))return;
    var now=Date.now();
    if(now-Number(lastExecuted[payload.presetId]||0)<1200)return;
    lastExecuted[payload.presetId]=now;
    if(payload.presetId==='save-selection'){
      var saveButton=document.querySelector('[data-dialog="save"]');
      if(saveButton){saveButton.click();status('Save Selection opened by '+String(library.saveShortcut||'Shift+S')+'.');}
      return;
    }
    if(!library)return;
    var shortcutIsFolder=shortcutEntry.folder===true,item=shortcutIsFolder&&global.PremiereBindLibraryView.findFolder?global.PremiereBindLibraryView.findFolder(library,payload.presetId):global.PremiereBindLibraryView&&global.PremiereBindLibraryView.find(library,payload.presetId);
    if(!item||(!shortcutIsFolder&&!global.PremiereBindInsertSelection)||(shortcutIsFolder&&!global.PremiereBindFolderPresets))return;
    busy[payload.presetId]=true;
    var task=shortcutIsFolder?global.PremiereBindFolderPresets.insert(item,{mode:item.targetMode||'playhead',colorIndex:Number(item.targetColorId)||0,name:item.targetName||'',playSnap:library.playSnap||null}):global.PremiereBindInsertSelection.insert(item.preset,{mode:'playhead',playSnap:library.playSnap||null});task.then(function(result){
      var failure=result.transitionFailures&&result.transitionFailures[0];status(failure?'Transition “'+failure.title+'” failed: '+failure.error:'Inserted “'+(item.name||item.title)+'” at '+result.targetCount+' target'+(result.targetCount===1?'':'s')+'.');
    }).catch(function(error){status(error.message||String(error));}).then(function(){delete busy[payload.presetId];});
  }
  function connect(){
    if(socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING))return;
    try{socket=new WebSocket(URL);}catch(_){launch();schedule();return;}
    socket.onopen=function(){launchAttempted=true;status('Global shortcuts ready.');sync();};
    socket.onmessage=function(event){var payload=null;try{payload=JSON.parse(event.data);}catch(_){}if(!payload)return;if(payload.type==='exportProgress'){global.dispatchEvent(new CustomEvent('premierebind:export-progress',{detail:payload}));return;}if(payload.requestId&&requests[payload.requestId]){var pending=requests[payload.requestId];clearTimeout(pending.timer);delete requests[payload.requestId];if(payload.ok===false)pending.reject(new Error(payload.error||'The PremiereBind helper request failed.'));else pending.resolve(payload);return;}if(payload.type==='import_library'){global.dispatchEvent(new CustomEvent('premierebind:external-import',{detail:payload.data}));return;}if(payload.type==='shortcut')execute(payload);};
    socket.onclose=function(){socket=null;Object.keys(requests).forEach(function(id){clearTimeout(requests[id].timer);requests[id].reject(new Error('The PremiereBind helper disconnected.'));delete requests[id];});launch();schedule();};
    socket.onerror=function(){};
  }
  function accept(value){library=value;sync();}
  function handles(combo){
    if(!socket||socket.readyState!==WebSocket.OPEN||!library)return false;
    var wanted=normalizedCombo(combo);
    return Boolean(wanted)&&activePresets(library).some(function(item){return normalizedCombo(item.shortcut)===wanted;});
  }
  ['premierebind:library-ready','premierebind:profiles-changed','premierebind:folders-changed','premierebind:selections-changed','premierebind:settings-changed','premierebind:randomizers-changed'].forEach(function(name){global.addEventListener(name,function(event){accept(event.detail);});});
  global.addEventListener('beforeunload',function(){if(reconnectTimer)clearTimeout(reconnectTimer);if(socket)socket.close();});
  global.PremiereBindCompanion={nativeClipboard:function(action,token){return request("premiereClipboardShortcut",{action:action,clipboardToken:token},10000);},analyzeAudioBeats:function(mediaPath,sensitivity){return request('analyzeAudioBeats',{mediaPath:mediaPath,sensitivity:sensitivity||'balanced'},120000);},connect:connect,sync:accept,activePresets:activePresets,handles:handles,readProjectTransitionMetadata:function(projectPath,sequenceGuid,sequenceName){return request('readProjectTransitionMetadata',{projectPath:projectPath,sequenceGuid:sequenceGuid||'',sequenceName:sequenceName||''},30000);},exportLibraryZip:function(outputPath,libraryData,mediaPaths){return request('exportLibraryZip',{outputPath:outputPath,libraryData:libraryData,mediaPaths:mediaPaths||[]},30*60*1000);},importLibraryZip:function(inputPath){return request('importLibraryZip',{inputPath:inputPath},30*60*1000).then(function(result){return result.data;});}};
  connect();
})(window);





