(() => {
'use strict';
const panel=$('pushSettings'), notice=$('pushStatus');
if(local||!panel)return;
panel.classList.remove('hidden');
const on=$('pushEnable'), off=$('pushDisable'), test=$('pushTest');
const testAll=$('pushTestAll'), registrationStatus=$('pushRegistration');
let registration=null, busyPush=false, registered=false, subscribed=false, deviceCount=0, statusVersion=0;
const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const message=text=>{notice.textContent=text;};
function buttons(){
  const signedIn=Boolean(window.linePushSignedIn?.());
  on.disabled=busyPush||!registration||!signedIn;
  off.disabled=busyPush||!signedIn||!subscribed;
  test.disabled=busyPush||!signedIn||!registered||!subscribed||Notification.permission!=='granted';
  testAll.disabled=busyPush||!signedIn||!deviceCount;
}
async function refreshStatus(){
  const version=++statusVersion;
  const subscription=await registration?.pushManager.getSubscription();
  if(version!==statusVersion)return;
  subscribed=Boolean(subscription);
  if(!window.linePushSignedIn?.()){
    registered=false;deviceCount=0;
    registrationStatus.textContent='ログインすると通知先を確認できます。';
    buttons();
    return;
  }
  registrationStatus.textContent='通知先を確認しています…';
  try{
    const status=await window.linePushRequest({action:'status',...(subscription?{endpoint:subscription.endpoint}:{})});
    if(version!==statusVersion)return;
    registered=status.registered;
    deviceCount=status.count;
    const state=!supported?'この画面では端末の通知状態を確認できません。'
      :registered&&Notification.permission==='granted'?'この端末は登録済みです。'
      :registered?'この端末は登録済みです。iPhoneやブラウザの設定で通知を許可してください。'
      :'この端末は未登録です。「この端末で通知をオン」を押してください。';
    registrationStatus.textContent=state+' 登録済みの通知先 '+deviceCount+'件。';
  }catch{
    if(version!==statusVersion)return;
    registered=false;deviceCount=0;
    registrationStatus.textContent='登録状態を確認できませんでした。画面を開き直してください。';
  }
  if(version===statusVersion)buttons();
}
async function setup(){
  if(supported){
    await navigator.serviceWorker.register('/line-push-worker.js');
    registration=await navigator.serviceWorker.ready;
  }else{
    message('iPhone・iPadではホーム画面に追加して、そのアイコンから開いてください。');
  }
  await window.lineCloudReady;
  await refreshStatus();
}
async function operate(action){
  if((!registration&&action!=='test_all')||busyPush)return;
  if(!window.linePushSignedIn?.()){message('この端末でログインしてから設定してください。');return;}
  busyPush=true;
  buttons();
  try{
    if(action==='subscribe'){
      const permission=await Notification.requestPermission();
      if(permission!=='granted')throw new Error('端末の通知設定で許可してください。');
      const {key}=await window.linePushRequest({action:'key'});
      let subscription=await registration.pushManager.getSubscription();
      const encoded=key.replace(/-/g,'+').replace(/_/g,'/');
      const bytes=Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')),char=>char.charCodeAt(0));
      const existing=subscription?.options.applicationServerKey;
      if(existing&&String(new Uint8Array(existing))!==String(bytes)){
        await subscription.unsubscribe();
        subscription=null;
      }
      if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      try{await window.linePushRequest({action,subscription:subscription.toJSON()});}
      catch(error){await subscription.unsubscribe();throw error;}
      message('この端末の通知をオンにしました。');
    }else if(action==='test_all'){
      const result=await window.linePushRequest({action});
      if(result.duplicate)message('1分ほど空けて再試行してください。');
      else if(result.attempted)message('通知サービスが '+result.attempted+'件中 '+result.sent+'件を受け付けました。各端末で通知を確認してください。');
      else message('登録済みの通知先がありません。');
    }else{
      const subscription=await registration.pushManager.getSubscription();
      if(!subscription)throw new Error('先に通知をオンにしてください。');
      const result=await window.linePushRequest({action,endpoint:subscription.endpoint});
      if(action==='remove'){
        await subscription.unsubscribe();message('この端末の通知をオフにしました。');
      }else if(result.sent)message('テスト通知を送信しました。');
      else if(result.duplicate)message('1分ほど空けて再試行してください。');
      else message('通知を届けられませんでした。通知をオンにし直してください。');
    }
  }catch(error){message(error.message);}
  finally{
    busyPush=false;
    await refreshStatus().catch(()=>message('登録状態を確認できませんでした。'));
  }
}
on.onclick=()=>operate('subscribe');
off.onclick=()=>operate('remove');
test.onclick=()=>operate('test');
testAll.onclick=()=>operate('test_all');
for(const event of ['attiosessionready','connectionchange','pageshow']){
  window.addEventListener(event,()=>{if(!busyPush)refreshStatus().catch(()=>{});});
}
setup().catch(()=>message('通知の準備ができませんでした。再読み込みしてください。'));
})();
