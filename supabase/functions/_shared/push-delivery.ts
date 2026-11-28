import webpush from 'npm:web-push@3.6.7';
import type {SupabaseClient} from 'npm:@supabase/supabase-js@2.49.4';

const origin='https://line-per-line.netlify.app';
const supportedHost=(host:string)=>host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.apple.com');
export function validEndpoint(value:unknown): value is string {
  if(typeof value!=='string'||value.length>2048)return false;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&supportedHost(url.hostname);
  }catch{return false;}
}
function check(error: {code?:string}|null){if(error)throw Error('database');}

export async function deliverPush(service:SupabaseClient,userId:string,eventId:string,
  notification:{body:string;path:string;sender?:unknown;preview?:unknown},endpoint?:string){
  const devices=service.from('line_push_devices');
  const batchSize=50;
  async function findDevices(after?:string){
    let query=devices.select('endpoint,subscription').eq('user_id',userId);
    if(endpoint)query=query.eq('endpoint',endpoint);
    if(after)query=query.gt('endpoint',after);
    const result=await query.order('endpoint').limit(batchSize);
    check(result.error);
    return result.data??[];
  }
  let targets=await findDevices();
  if(!targets.length)return {sent:0};
  const keys=await service.from('line_push_keys').select('public_key,private_key').eq('user_id',userId).single();
  check(keys.error);
  const delivery=service.from('line_push_delivery');
  const claim=await delivery.insert({user_id:userId,event_id:eventId});
  if(claim.error?.code==='23505')return {sent:0,duplicate:true};
  check(claim.error);
  const sender=typeof notification.sender==='string'
    ? Array.from(notification.sender.replace(/[\s\u0000-\u001f\u007f]+/g,' ').trim()).slice(0,80).join('')
    : '';
  const previewCharacters=typeof notification.preview==='string'
    ? Array.from(notification.preview.replace(/[\s\u0000-\u001f\u007f]+/g,' ').trim())
    : [];
  const preview=previewCharacters.slice(0,100).join('')+(previewCharacters.length>100?'…':'');
  const payload=JSON.stringify({title:'つながる営業',body:notification.body,path:notification.path,...(sender?{sender}:{}),...(preview?{preview}:{})});
  async function send(row:typeof targets[number]){
    if(!validEndpoint(row.endpoint)||row.subscription?.endpoint!==row.endpoint)return false;
    try{
      await webpush.sendNotification(row.subscription,payload,{
        TTL:900,timeout:6000,vapidDetails:{subject:origin,publicKey:keys.data!.public_key,privateKey:keys.data!.private_key},
      });
      return true;
    }catch(error){
      const status=(error as {statusCode?:number}).statusCode;
      if(status===404||status===410)await devices.delete().eq('user_id',userId).eq('endpoint',row.endpoint);
      return false;
    }
  }
  let sent=0;
  try{
    while(targets.length){
      const outcomes=await Promise.all(targets.map(send));
      sent+=outcomes.filter(Boolean).length;
      if(endpoint||targets.length<batchSize)break;
      targets=await findDevices(targets[targets.length-1].endpoint);
    }
  }catch(error){
    if(!sent)await delivery.delete().eq('user_id',userId).eq('event_id',eventId);
    throw error;
  }
  if(!sent)await delivery.delete().eq('user_id',userId).eq('event_id',eventId);
  else await delivery.delete().eq('user_id',userId).lt('created_at',new Date(Date.now()-8*86400000).toISOString());
  return {sent};
}
