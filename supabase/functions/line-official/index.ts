import {createClient} from 'npm:@supabase/supabase-js@2.49.4';

const env = (name: string) => Deno.env.get(name)?.trim() || '';
const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {auth:{persistSession:false}});
const headers = {
  'Access-Control-Allow-Origin':'https://line-per-line.netlify.app',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Content-Type':'application/json',
  'Cache-Control':'no-store',
};
const reply = (body: object, status=200) => new Response(JSON.stringify(body), {headers,status});
const problem = (message:string, status:number) => reply({message},status);
const check = (error:unknown) => { if(error)throw Error('storage'); };
const lineUser = (id:unknown):id is string => typeof id==='string'&&/^U[0-9a-f]{32}$/.test(id);
const threads = () => service.from('line_official_threads');
const messages = () => service.from('line_official_messages');
const required = () => ['LINE_OFFICIAL_CHANNEL_SECRET','LINE_OFFICIAL_CHANNEL_ACCESS_TOKEN','LINE_OFFICIAL_OWNER_ID'].every(name=>env(name));

async function signatureMatches(signature:string, raw:ArrayBuffer):Promise<boolean>{
  if(!/^[A-Za-z0-9+/]{43}=$/.test(signature))return false;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(env('LINE_OFFICIAL_CHANNEL_SECRET')),
    {name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),raw);
}
async function webhook(req:Request,raw:ArrayBuffer){
  if(!required())return problem('公式LINEが未接続です。',503);
  if(!await signatureMatches(req.headers.get('x-line-signature')||'',raw))return problem('署名を確認できません。',401);
  const {events} = JSON.parse(new TextDecoder().decode(raw));
  if(!Array.isArray(events))return problem('無効なイベントです。',400);
  for(const event of events){
    if(event.mode==='standby'||event.source?.type!=='user'||!lineUser(event.source?.userId))continue;
    if(event.type==='unsend'&&typeof event.unsend?.messageId==='string'){
      const deleted=await messages().update({body:'［送信取り消し］'}).eq('id','in:'+event.unsend.messageId).eq('line_user',event.source.userId);
      check(deleted.error);
      continue;
    }
    if(event.type!=='message'||typeof event.message?.id!=='string'||!Number.isFinite(event.timestamp))continue;
    const body=event.message.type==='text'&&typeof event.message.text==='string'
      ?event.message.text.slice(0,5000):'［添付メッセージ］';
    const accepted=await service.rpc('line_official_accept_message',{
      p_user:event.source.userId,p_id:event.message.id,p_body:body,p_at:new Date(event.timestamp).toISOString(),
    });
    check(accepted.error);
  }
  return reply({ok:true});
}

async function send(data:Record<string,unknown>, lineUserId:string){
  const text=typeof data.text==='string'?data.text.trim():'';
  const key=data.request_id;
  if(!text||text.length>1000||typeof key!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)){
    return problem('本文と送信IDを確認してください。',400);
  }
  const id='out:'+key;
  check((await messages().upsert({id,line_user:lineUserId,direction:'out',body:text},
    {onConflict:'id',ignoreDuplicates:true})).error);
  const stored=await messages().select('line_user,body,sent,created_at').eq('id',id).single();
  check(stored.error);
  if(stored.data!.line_user!==lineUserId||stored.data!.body!==text)return problem('前回確認した宛先・本文と一致しません。',409);
  if(!stored.data!.sent){
    if(Date.now()-Date.parse(stored.data!.created_at)>23*3600000)return problem('送信結果を公式LINE側で確認してください。',409);
    const result=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',
      signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+env('LINE_OFFICIAL_CHANNEL_ACCESS_TOKEN'),
      'Content-Type':'application/json','X-Line-Retry-Key':key},
      body:JSON.stringify({to:lineUserId,messages:[{type:'text',text}]}),
    });
    if(!result.ok&&!(result.status===409&&result.headers.has('x-line-accepted-request-id'))){
      return problem('LINEが送信を受け付けませんでした。送信条件とアカウント設定を確認してください。',502);
    }
    check((await messages().update({sent:true}).eq('id',id)).error);
  }
  check((await threads().update({replied_at:stored.data!.created_at}).eq('line_user',lineUserId)
    .or('replied_at.is.null,replied_at.lt.'+stored.data!.created_at)).error);
  return reply({accepted:true});
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response(null,{headers,status:204});
  if(req.method!=='POST')return problem('POST required',405);
  try{
    const raw=await req.arrayBuffer();
    if(raw.byteLength>300000)return problem('入力が大きすぎます。',413);
    if(req.headers.has('x-line-signature'))return await webhook(req,raw);
    const token=req.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if(!token)return problem('ログインしてください。',401);
    const {data:{user}}=await service.auth.getUser(token);
    if(!user||user.is_anonymous)return problem('ログインしてください。',401);
    if(!required())return problem('公式LINEの初回接続が必要です。',503);
    if(user.id!==env('LINE_OFFICIAL_OWNER_ID'))return problem('公式LINEの担当者アカウントで開いてください。',403);
    const data=JSON.parse(new TextDecoder().decode(raw));
    if(data.action==='list'){
      const result=await threads().select('line_user,display_name,inbound_at,replied_at,priority')
        .order('priority',{ascending:false}).order('inbound_at',{ascending:false}).limit(100);
      check(result.error);
      return reply({threads:result.data});
    }
    const id=data.line_user;
    if(!lineUser(id))return problem('相手を選び直してください。',400);
    const thread=await threads().select('line_user,display_name').eq('line_user',id).maybeSingle();
    check(thread.error);
    if(!thread.data)return problem('問い合わせが見つかりません。',404);
    if(data.action==='history'){
      let displayName=thread.data.display_name;
      if(!displayName){
        try{
          const profile=await fetch('https://api.line.me/v2/bot/profile/'+id,{signal:AbortSignal.timeout(2500),
            headers:{Authorization:'Bearer '+env('LINE_OFFICIAL_CHANNEL_ACCESS_TOKEN')}});
          if(profile.ok){
            const profileData=await profile.json();
            if(typeof profileData.displayName==='string'&&profileData.displayName.trim()){
              displayName=profileData.displayName.trim().slice(0,100);
              check((await threads().update({display_name:displayName}).eq('line_user',id)).error);
            }
          }
        }catch{/* History can still be displayed. */}
      }
      const result=await messages().select('direction,body,created_at').eq('line_user',id).eq('sent',true)
        .order('created_at',{ascending:false}).limit(50);
      check(result.error);
      return reply({messages:result.data!.reverse(),display_name:displayName});
    }
    if(data.action==='priority'&&typeof data.active==='boolean'){
      check((await threads().update({priority:data.active}).eq('line_user',id)).error);
      return reply({ok:true});
    }
    if(data.action==='send')return await send(data,id);
    return problem('操作を確認してください。',400);
  }catch{
    return problem('公式LINEの処理を完了できませんでした。同じ送信内容で再確認してください。',502);
  }
});
