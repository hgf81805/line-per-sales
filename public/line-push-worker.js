self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));

self.addEventListener('push', event=>{
  let payload={};
  try{payload=event.data.json();}catch{}
  event.waitUntil(self.registration.showNotification('つながる営業',{
    body:payload.body||'営業フォローを確認してください。',
    icon:'/apple-touch-icon.png',
    tag:payload.path==='/'?'line-new-message':'line-sales-followup',
    data:{path:payload.path==='/'?'/':'/pipeline.html#today-agenda'}
  }));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.path==='/'?'/':'/pipeline.html#today-agenda',self.location.origin);
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const match=windows.find(client=>new URL(client.url).origin===target.origin);
    if(match){
      try{const opened=await match.navigate(target.href);if(opened){await opened.focus();return;}}catch{}
    }
    await self.clients.openWindow(target.href);
  })());
});
