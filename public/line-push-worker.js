self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));

function notificationPath(path){
  if(path==='/#official-line')return path;
  if(path==='/'||path==='/#direct-line')return '/#direct-line';
  return '/pipeline.html#today-agenda';
}

self.addEventListener('push', event=>{
  let payload={};
  try{payload=event.data.json();}catch{}
  const path=notificationPath(payload.path);
  event.waitUntil(self.registration.showNotification('つながる営業',{
    body:payload.body||'営業フォローを確認してください。',
    icon:'/apple-touch-icon.png',
    tag:path==='/#official-line'?'official-line-new-message':path==='/#direct-line'?'line-new-message':'line-sales-followup',
    data:{path}
  }));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(notificationPath(event.notification.data?.path),self.location.origin);
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const match=windows.find(client=>new URL(client.url).origin===target.origin);
    if(match){
      try{const opened=await match.navigate(target.href);if(opened){await opened.focus();return;}}catch{}
    }
    await self.clients.openWindow(target.href);
  })());
});
