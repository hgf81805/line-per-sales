import {deliverPush,validEndpoint} from '../_shared/push-delivery.ts';
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
function check(error:unknown){if(error)throw Error('database');}

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
    const bucket=Math.floor(Date.now()/60000);
    let eventId=String(data.event_id||'');
    if(isTest){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.endpoint));
      const endpointId=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      eventId='test-'+bucket+'-'+endpointId;
    }
    if(!isTest&&!/^[0-9a-f]{64}$/.test(eventId))return reply({error:'無効な通知です。'},400);
    const isLine=!isTest&&data.kind==='line';
    return reply(await deliverPush(service,userId,eventId,{
      body:isTest?'プッシュ通知を受信できました。':isLine?'LINEに新着メッセージがあります。':'期限またはLINEの返信を確認してください。',
      path:isLine?'/#direct-line':'/pipeline.html#today-agenda',
      sender:isLine?data.sender:undefined,
      preview:isLine?data.preview:undefined,
    },isTest?data.endpoint:undefined));
  }catch{return reply({error:'通知の処理ができませんでした。時間をおいて再試行してください。'},500);}
});
