import webpush from 'npm:web-push@3.6.7';
import {createClient} from 'npm:@supabase/supabase-js@2.49.4';

const origin='https://line-per-line.netlify.app';
const headers={
  'Access-Control-Allow-Origin':origin,
  'Access-Control-Allow-Headers':'authorization, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Cache-Control':'no-store',
  'Content-Type':'application/json',
};
const reply=(body:object,status=200)=>new Response(JSON.stringify(body),{status,headers});
const url=Deno.env.get('SUPABASE_URL')!;
const service=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
const supportedHost=(host:string)=>host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.apple.com');
function validEndpoint(value:unknown): value is string {
  if(typeof value!=='string'||value.length>2048)return false;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&supportedHost(url.hostname);
  }catch{return false;}
}
function check(error: {code?:string}|null){if(error)throw Error('database');}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply({error:'POST required'},405);
  const token=req.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return reply({error:'ログインしてください。'},401);
  const {data:{user},error:authError}=await service.auth.getUser(token);
  if(authError||!user||user.is_anonymous)return reply({error:'ログインしてください。'},401);
  const userId=user.id;
  try{
    const body=await req.text();
    if(body.length>10000)return reply({error:'入力が大きすぎます。'},413);
    const data=JSON.parse(body);
    const devices=service.from('line_push_devices');
    if(data.action==='key'){
      const keys=webpush.generateVAPIDKeys();
      const {error}=await service.from('line_push_keys').upsert({
        user_id:userId,public_key:keys.publicKey,private_key:keys.privateKey
      },{onConflict:'user_id',ignoreDuplicates:true});
      check(error);
      const stored=await service.from('line_push_keys').select('public_key').eq('user_id',userId).single();
      check(stored.error);
      return reply({key:stored.data!.public_key});
    }
    if(data.action==='subscribe'){
      const entry=data.subscription;
      const key=(value:unknown,length:number)=>typeof value==='string'&&value.length===length&&/^[a-zA-Z0-9_-]+$/.test(value);
      if(!validEndpoint(entry?.endpoint)||!key(entry.keys?.p256dh,87)||!key(entry.keys?.auth,22)){
        return reply({error:'この端末の通知情報を登録できません。'},400);
      }
      const allowed={endpoint:entry.endpoint,keys:{p256dh:entry.keys.p256dh,auth:entry.keys.auth}};
      const result=await devices.upsert({user_id:userId,endpoint:entry.endpoint,subscription:allowed});
      check(result.error);
      return reply({enabled:true});
    }
    if(data.action==='remove'){
      if(!validEndpoint(data.endpoint))return reply({error:'無効な通知先です。'},400);
      const result=await devices.delete().eq('user_id',userId).eq('endpoint',data.endpoint);
      check(result.error);
      return reply({enabled:false});
    }
    if(data.action==='has'){
      const result=await devices.select('endpoint').eq('user_id',userId).limit(1);
      check(result.error);
      return reply({enabled:Boolean(result.data?.length)});
    }
    if(data.action!=='publish'&&data.action!=='test')return reply({error:'操作を確認してください。'},400);
    const isTest=data.action==='test';
    if(isTest&&!validEndpoint(data.endpoint))return reply({error:'先に通知をオンにしてください。'},400);
    let targets=devices.select('endpoint,subscription').eq('user_id',userId);
    if(isTest)targets=targets.eq('endpoint',data.endpoint);
    const found=await targets.limit(50);
    check(found.error);
    if(!found.data?.length)return reply({sent:0});
    const keys=await service.from('line_push_keys').select('public_key,private_key').eq('user_id',userId).single();
    check(keys.error);
    const event=String(data.event_id||'');
    const bucket=Math.floor(Date.now()/60000);
    const eventId=isTest?'test-'+bucket:event;
    if(!isTest&&!/^[0-9a-f]{64}$/.test(event))return reply({error:'無効な通知です。'},400);
    const delivery=service.from('line_push_delivery');
    const claim=await delivery.insert({user_id:userId,event_id:eventId});
    if(claim.error?.code==='23505')return reply({sent:0,duplicate:true});
    check(claim.error);
    const payload=JSON.stringify({
      title:'つながる営業',
      body:isTest?'プッシュ通知を受信できました。':'期限またはLINEの返信を確認してください。',
      path:'/pipeline.html#today-agenda',
    });
    const outcomes=await Promise.all(found.data.map(async row=>{
      if(!validEndpoint(row.endpoint)||row.subscription?.endpoint!==row.endpoint)return false;
      try{
        await webpush.sendNotification(row.subscription,payload,{
          TTL:900,timeout:6000,vapidDetails:{subject:origin,publicKey:keys.data!.public_key,privateKey:keys.data!.private_key}
        });
        return true;
      }catch(error){
        const status=(error as {statusCode?:number}).statusCode;
        if(status===404||status===410)await devices.delete().eq('user_id',userId).eq('endpoint',row.endpoint);
        return false;
      }
    }));
    const sent=outcomes.filter(Boolean).length;
    if(!sent)await delivery.delete().eq('user_id',userId).eq('event_id',eventId);
    else await delivery.delete().eq('user_id',userId).lt('created_at',new Date(Date.now()-8*86400000).toISOString());
    return reply({sent});
  }catch{return reply({error:'通知の処理ができませんでした。時間をおいて再試行してください。'},500);}
});
