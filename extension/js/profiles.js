(function (global) {
  'use strict';

  function fail(code, message) { var error=new Error(message);error.code=code;throw error; }
  function makeId() { return 'profile-'+Date.now()+'-'+Math.random().toString(36).slice(2,8); }
  function service() {
    if (!global.PremiereBindStorage) fail('STORAGE_UNAVAILABLE','PremiereBind storage is unavailable.');
    return global.PremiereBindStorage;
  }
  function current() { return service().get() || null; }
  function notify(library) {
    global.dispatchEvent(new CustomEvent('premierebind:profiles-changed',{detail:library}));
    return library;
  }
  function nextLabel(profiles) {
    var used={};profiles.forEach(function(profile){used[String(profile.label||'').toLowerCase()]=true;});
    var number=1;while(used[('Profile '+number).toLowerCase()])number++;
    return 'Profile '+number;
  }
  function mutate(change) { return service().update(change).then(notify); }
  function select(profileId) {
    return mutate(function(library){
      var exists=library.profiles.some(function(profile){return profile.id===profileId;});
      if(!exists)fail('PROFILE_NOT_FOUND','That profile no longer exists.');
      library.activeProfileId=profileId;return library;
    });
  }
  function add(label) {
    return mutate(function(library){
      var name=String(label||'').trim().slice(0,40)||nextLabel(library.profiles);
      var profile={id:makeId(),label:name,presets:[]};
      library.profiles.push(profile);library.activeProfileId=profile.id;return library;
    });
  }
  function rename(profileId,label) {
    var name=String(label||'').trim().slice(0,40);
    if(!name) return Promise.reject((function(){var error=new Error('Enter a profile name.');error.code='INVALID_PROFILE_NAME';return error;}()));
    return mutate(function(library){
      var profile=library.profiles.filter(function(entry){return entry.id===profileId;})[0];
      if(!profile)fail('PROFILE_NOT_FOUND','That profile no longer exists.');
      profile.label=name;return library;
    });
  }
  function remove(profileId) {
    return mutate(function(library){
      var index=-1;for(var i=0;i<library.profiles.length;i++)if(library.profiles[i].id===profileId){index=i;break;}
      if(index<0)fail('PROFILE_NOT_FOUND','That profile no longer exists.');
      if(library.profiles.length===1){
        var empty={id:makeId(),label:'Profile 1',presets:[]};
        library.profiles=[empty];library.activeProfileId=empty.id;return library;
      }
      library.profiles.splice(index,1);
      if(library.activeProfileId===profileId)library.activeProfileId=(library.profiles[Math.max(0,index-1)]||library.profiles[0]).id;
      return library;
    });
  }
  function removeAll() {
    return mutate(function(library){
      var empty={id:makeId(),label:'Profile 1',presets:[]};
      library.profiles=[empty];library.activeProfileId=empty.id;return library;
    });
  }
  global.PremiereBindProfiles={get:current,select:select,add:add,rename:rename,remove:remove,removeAll:removeAll,nextLabel:nextLabel};
})(window);
