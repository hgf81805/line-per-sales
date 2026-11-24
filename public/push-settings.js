(() => {
'use strict';
const panel=$('pushSettings'), notice=$('pushStatus');
if(local||!panel)return;
panel.classList.remove('hidden');
const on=$('pushEnable'), off=$('pushDisable'), test=$('pushTest');
let registration=null, busyPush=false;
const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const message=text=>{notice.textContent=text;};
function buttons(enabled){
  on.disabled=busyPush||!supported;
  off.disabled=busyPush||!enabled;
  test.disabled=busyPush||!enabled;
}
async function setup(){
  if(!supported){
    message('iPhone・iPadではホーム画面に追加して、そのアイコンから開いてください。');
    buttons(false);return;
  }
  await navigator.serviceWorker.register('/line-push-worker.js');
  registration=await navigator.serviceWorker.ready;
  const subscription=await registration.pushManager.getSubscription();
  buttons(Boolean(subscription));
  message(subscription?'この端末で通知を利用できます。':'通知をオンにすると、この端末に届きます。');
}
async function operate(action){
  if(!registration||busyPush)return;
  if(!window.linePushSignedIn?.()){message('この端末でログインしてから設定してください。');return;}
  busyPush=true;
  buttons(false);
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
    buttons(Boolean(await registration.pushManager.getSubscription().catch(()=>null)));
  }
}
on.onclick=()=>operate('subscribe');
off.onclick=()=>operate('remove');
test.onclick=()=>operate('test');
setup().catch(()=>message('通知の準備ができませんでした。再読み込みしてください。'));
})();
