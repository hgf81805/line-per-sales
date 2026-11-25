/* Authenticated multi-device access. No Beeper credential enters this script. */
(() => {
'use strict';
const localRequest = request;
let config, session = null, devices = [], activeDevice = null, cloudActive = false;
let refreshPromise = null, deviceTimer = null, generation = 0;
const panel = document.getElementById('cloudPanel');
const notice = text => { const target=$('cloudNotice')||$('status'); if(target)target.textContent=text; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const storageKey = 'line-remote-auth-v1';
const deviceKey='line-selected-device';
function rememberedDevice(){
  try{return sessionStorage.getItem(deviceKey);}catch{return null;}
}
function rememberDevice(id){
  try{
    if(id)sessionStorage.setItem(deviceKey,id);
    else sessionStorage.removeItem(deviceKey);
  }catch{}
}
function forgetSession(){session=null;rememberDevice(null);try{sessionStorage.removeItem(storageKey);}catch(e){}}
function saveSession(data){
  if(!data.access_token||!data.refresh_token||!data.user?.id||data.user.is_anonymous)throw new Error('メールで登録したアカウントでログインしてください。');
  session={access_token:data.access_token,refresh_token:data.refresh_token,user:data.user,expires_at:Date.now()+(data.expires_in||3600)*1000};
  try{sessionStorage.setItem(storageKey,JSON.stringify(session));}catch(e){}
}
async function raw(path, body, {method='POST',auth=true,headers={}}={}){
  if(auth)await accessToken();
  const res=await fetch(config.url+path,{method,cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(25000),headers:{apikey:config.key,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+session.access_token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await res.text();let data;try{data=text?JSON.parse(text):null;}catch(e){throw new Error('クラウドの応答を確認できません。');}
  if(!res.ok){if(auth&&res.status===401){forgetSession();resetRemote();}throw new Error(res.status===401||res.status===400&&path.startsWith('/auth/')?'ログイン情報とメール確認の完了を確認してください。':data?.msg||data?.message||'クラウド接続に失敗しました。');}
  return data;
}
async function accessToken(){
  if(!session)throw new Error('ログインしてください。');
  if(session.expires_at>Date.now()+60000)return session.access_token;
  if(!refreshPromise)refreshPromise=raw('/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token},{auth:false}).then(saveSession).catch(error=>{forgetSession();resetRemote();throw error;}).finally(()=>{refreshPromise=null;});
  await refreshPromise;return session.access_token;
}
function resetRemote(){
  generation++;cloudActive=false;activeDevice=null;selected=null;messageId=null;conversationVersion=null;
  ['chats','history','candidates','name'].forEach(id=>{if($(id))$(id).textContent=id==='name'?'相手を選んでください':'';});
  if(!local&&$('connected')&&!bridgeToken){$('connected').classList.add('hidden');$('setup').classList.remove('hidden');}
  if(panel){$('cloudLoggedIn').classList.add('hidden');$('cloudLogin').classList.remove('hidden');}
  if(deviceTimer){clearInterval(deviceTimer);deviceTimer=null;}controls();
  window.dispatchEvent(new Event('connectionchange'));
}
async function loadDevices(){
  if(!session)return;
  devices=await raw('/rest/v1/line_remote_devices?select=id,name,last_seen,enabled,capabilities&order=last_seen.desc',undefined,{method:'GET'});
  const select=$('cloudDevice');if(!select)return;const previous=select.value||rememberedDevice();select.replaceChildren();
  for(const d of devices){const option=document.createElement('option');option.value=d.id;option.textContent=d.name+' · '+(d.enabled&&Date.now()-new Date(d.last_seen).getTime()<60000?'オンライン':'オフライン');select.appendChild(option);}
  if(devices.some(d=>d.id===previous))select.value=previous;
  $('cloudUse').disabled=busy||!devices.length;
  notice(devices.length?'接続するMacを選んでください。':'登録されたMacがありません。Macアプリを開き、その接続画面で同じアカウントにログインしてリモート接続を有効にしてください。');
}
// Saved directory records use the signed-in user's existing row policies.
window.savedAttioDirectory = {
  available: () => !local && Boolean(session),
  async notes(recordId) {
    const query = new URLSearchParams({
      select:'notes', workspace_id:'eq.4cc26a0e-26f3-4f1c-8202-d0afe3a07734',
      object_type:'eq.people', record_id:'eq.' + recordId, limit:'1'
    });
    const rows = await raw('/rest/v1/line_attio_records?' + query, undefined, {method:'GET'});
    return rows[0]?.notes || [];
  },
  async page(source, offset) {
    if (!['companies', 'people'].includes(source)) throw new Error('取得する種類を選んでください。');
    const query = new URLSearchParams({
      select: 'record_id,data,fetched_at',
      workspace_id: 'eq.4cc26a0e-26f3-4f1c-8202-d0afe3a07734',
      object_type: 'eq.' + source,
      order: 'record_id.asc',
      limit: '51',
      offset: String(offset)
    });
    const rows = await raw('/rest/v1/line_attio_records?' + query, undefined, {method:'GET'});
    return {
      source,
      records: rows.slice(0, 50).map(row => ({...row.data, id:row.record_id, fetched_at:row.fetched_at})),
      has_more: rows.length > 50
    };
  }
};
async function loggedIn(){
  if(panel){$('cloudLogin').classList.add('hidden');$('cloudLoggedIn').classList.remove('hidden');$('cloudEmailLabel').textContent=session.user.email;}
  window.dispatchEvent(new Event('attiosessionready'));
  if(!panel&&bridgeToken)return;
  await loadDevices();
  const remembered=rememberedDevice();
  const enabled=devices.filter(device=>device.enabled);
  // Restore an explicit choice. With exactly one online Mac, no choice is needed.
  const saved=remembered ? enabled.find(device=>device.id===remembered) :
    !panel&&enabled.length===1&&Date.now()-new Date(enabled[0].last_seen).getTime()<60000?enabled[0]:null;
  if(saved&&!panel){
    rememberDevice(saved.id);
    activeDevice=saved.id;cloudActive=true;showConnected();controls();
    const badge=document.querySelector('#connected .badge');
    if(badge)badge.textContent=Date.now()-new Date(saved.last_seen).getTime()<60000?'クラウド経由 · 確認して送信':'接続先のMacがオフラインです';
    window.dispatchEvent(new Event('connectionchange'));
  }
  if(!panel){
    const hint=$('connectionHint');
    if(hint){
      if(remembered==='off')hint.textContent='設定で接続するMacを選び直してください。';
      else if(remembered)hint.textContent='以前選んだMacが見つかりません。設定で接続先を確認してください。';
      else if(enabled.length>1)hint.textContent='複数のMacが登録されています。設定で使うMacを選んで保存してください。';
      else if(enabled.length===1)hint.textContent='登録済みのMacがオフラインです。Mac・Beeper・接続アプリを起動してから再読み込みしてください。';
      else hint.textContent='このログインに登録されたMacが見つかりません。Mac内の設定で同じアカウントを使って登録してください。';
    }
    return;
  }
  if(saved)notice('接続するMac：'+saved.name);
  if(deviceTimer)clearInterval(deviceTimer);
  deviceTimer=setInterval(()=>loadDevices().catch(e=>notice(e.message)),15000);
}
async function cloudJob(action,payload){
  if(!['chats','conversation','suggest','prepare-send','send','send-status','attio-list','attio-linked','attio-link','attio-unlink','attio-create','attio-stage','attio-task','attio-complete','attio-contact','attio-note','sales-assist'].includes(action))throw new Error('この操作には対応していません。');
  const epoch=generation;
  await loadDevices();
  const device=devices.find(d=>d.id===activeDevice);
  if(!device||!device.enabled||Date.now()-new Date(device.last_seen).getTime()>=60000)throw new Error('Macがオフラインです。Mac・Beeper・接続アプリを起動してください。');
  if(['prepare-send','send','send-status'].includes(action)&&!device.capabilities?.includes('confirmed-send-v1'))throw new Error('送信するにはMacアプリを最新版へ更新してください。');
  if(action.startsWith('attio-')&&!device.capabilities?.includes('attio-crm-v1'))throw new Error('Attioを使うにはMacアプリをv1.5へ更新してください。');
  if(action==='attio-list'&&payload.source&&!device.capabilities?.includes('attio-directory-v1'))throw new Error('会社・連絡先を取得するにはMacアプリをv1.6へ更新してください。');
  if(action==='attio-contact'&&!device.capabilities?.includes('attio-contact-v1'))throw new Error('LINE連絡先の登録にはMacアプリv1.8が必要です。');
  if(action==='attio-note'&&!device.capabilities?.includes('attio-note-edit-v1'))throw new Error('ノート編集にはMacアプリv1.9が必要です。');
  if(action==='sales-assist'&&!device.capabilities?.includes('sales-assist-v1'))throw new Error('営業アシストにはMacアプリv2.0が必要です。');
  if((action==='chats'&&(payload.query||payload.pins?.length)||action==='sales-assist'&&payload.mode==='overview')&&!device.capabilities?.includes('sales-desk-v1'))throw new Error('この機能にはMacアプリv2.1が必要です。');
  if(action==='chats'&&(payload.count||payload.excluded?.length)&&!device.capabilities?.includes('followups-v1'))throw new Error('10件表示と非表示設定にはMacアプリv2.2が必要です。');
  if(action==='sales-assist'&&['agenda','follow-plan','follow-save'].includes(payload.mode)&&!device.capabilities?.includes('followups-v1'))throw new Error('フォロー管理にはMacアプリv2.2が必要です。');
  if((action==='chats'&&payload.groups||action==='conversation'&&payload.group)&&!device.capabilities?.includes('line-groups-v1'))throw new Error('グループLINEを使うにはMacアプリをv2.9へ更新してください。');
  if(action==='chats'&&payload.lead_chat&&!device.capabilities?.includes('priority-leads-v1'))throw new Error('優先リードの会話を開くにはMacアプリをv2.8へ更新してください。');
  if(action==='chats'&&payload.saved_exclusions&&!device.capabilities?.includes('saved-chat-exclusions-v1')){
    const {saved_exclusions,...legacyPayload}=payload;
    payload=legacyPayload;
  }
  if(action==='chats'&&payload.paged&&!device.capabilities?.includes('paged-line-v1')){
    const {paged,cursor,...firstPage}=payload;
    payload=firstPage;
  }
  if(action==='sales-assist'&&payload.mode==='meeting-brief'&&!device.capabilities?.includes('meeting-brief-v1'))throw new Error('商談前ブリーフにはMacアプリv2.4が必要です。');
  if(action==='chats'&&payload.count===15&&!device.capabilities?.includes('line-list-15-v1'))payload={...payload,count:10};
  if(action==='sales-assist'&&payload.mode==='later-check'&&!device.capabilities?.includes('later-chats-v1'))throw new Error('新着による復帰にはMacアプリv2.5が必要です。');
  const [job]=await raw('/rest/v1/line_remote_jobs',{user_id:session.user.id,device_id:activeDevice,action,payload},{headers:{Prefer:'return=representation'}});
  try{
    const deadline=Date.now()+245000;
    while(Date.now()<deadline){
      if(epoch!==generation||!session)throw new Error('接続が解除されました。');
      const rows=await raw('/rest/v1/line_remote_jobs?id=eq.'+encodeURIComponent(job.id)+'&select=status,result,deadline',undefined,{method:'GET'});
      const row=rows?.[0];if(!row)throw new Error('処理が期限切れか解除されました。もう一度お試しください。');
      if(row.status==='error')throw new Error(row.result?.error||'Macでの処理に失敗しました。');
      if(row.status==='done')return row.result;
      if(Date.now()>new Date(row.deadline).getTime())throw new Error('Macから応答がありません。Macの接続状態を確認してください。');
      await sleep(1500);
    }
    throw new Error('処理がタイムアウトしました。Macの接続を確認してください。');
  }finally{
    // Remove transient content immediately after viewing; database cron also removes expired jobs.
    if(session)raw('/rest/v1/line_remote_jobs?id=eq.'+encodeURIComponent(job.id),undefined,{method:'DELETE'}).catch(()=>{});
  }
}
request=async function(path,body,quiet=false){
  if(local||!cloudActive)return localRequest(path,body,quiet);
  if(path==='disconnect'){generation++;cloudActive=false;rememberDevice('off');return {ok:true};}
  if(quiet)return cloudJob(path,body);
  busy=true;controls();$('error').textContent='';$('status').textContent='Macで処理しています…';
  try{return await cloudJob(path,body);}catch(e){$('error').textContent=e.message;throw e;}
  finally{busy=false;controls();$('status').textContent='';}
};
window.linePushSignedIn=()=>Boolean(session&&config);
window.linePushRequest=function(data){
  if(!session||!config)throw new Error('先にこの端末でログインしてください。');
  return raw('/functions/v1/line-push',data);
};
window.salesDeskScope=()=>local?'local':session&&activeDevice?session.user.id+':'+activeDevice:bridgeToken?'paired':null;
window.syncSalesDeskPreferences=async function(rows, importing=false, released=null){
  if(!local&&(!session||!activeDevice||!config))return {sync:false,rows:[]};
  const root='/rest/v1/line_chat_preferences';
  if(rows&&!local){
    const resolution=importing?'ignore-duplicates':'merge-duplicates';
    await raw(root+'?on_conflict=user_id,kind,chat_id',rows,{headers:{Prefer:'resolution='+resolution+',missing=default,return=minimal'}});
  }
  if(released&&!local)await raw('/rest/v1/rpc/line_restore_later',{p_rows:released});
  const preferences=[];
  for(let offset=0;;offset+=100){
    const result=local
      ? await localRequest('chat-preferences',{offset,...(offset===0&&rows?{rows,import:importing}:{}),...(offset===0&&released?{released}:{})})
      : {sync:true,rows:await raw(root+'?select=chat_id,kind,title,deferred_at,return_on&active=eq.true&order=kind,chat_id&limit=100&offset='+offset,undefined,{method:'GET'})};
    if(!result.sync)return result;
    preferences.push(...result.rows);
    if(result.rows.length<100)return {sync:true,rows:preferences};
  }
};
let localStatus;
if(panel){
$('cloudLogin').onsubmit=async event=>{
  event.preventDefault();const button=$('cloudLoginButton');button.disabled=true;notice('接続しています…');
  const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
  try{
    if(local){await localRequest('cloud/enroll',{email,password});$('cloudPassword').value='';await localStatus();}
    else{saveSession(await raw('/auth/v1/token?grant_type=password',{email,password},{auth:false}));$('cloudPassword').value='';await loggedIn();}
  }catch(e){notice(e.message);}finally{button.disabled=false;}
};
$('cloudSignup').onclick=async()=>{
  const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
  if(!email||password.length<8){notice('メールアドレスと8文字以上のパスワードを入力してください。');return;}
  $('cloudSignup').disabled=true;
  try{const data=await raw('/auth/v1/signup',{email,password},{auth:false});$('cloudPassword').value='';if(data.access_token){saveSession(data);await loggedIn();}else notice('確認メールを開いて登録を完了したあと、この画面でログインしてください。すでに同じSupabaseプロジェクトのアカウントがあれば、そのアカウントでログインできます。');}
  catch(e){notice(e.message);}finally{$('cloudSignup').disabled=false;}
};
$('cloudUse').onclick=()=>{
  if(busy)return;
  const id=$('cloudDevice').value;
  const device=devices.find(row=>row.id===id&&row.enabled);
  if(!device){notice('接続するMacを選択してください。');return;}
  rememberDevice(device.id);
  try{sessionStorage.removeItem('line-bridge-session');}catch{}
  notice('接続するMacを保存しました：'+device.name);
};
$('cloudRefresh').onclick=()=>loadDevices().catch(e=>notice(e.message));
$('cloudLogout').onclick=async()=>{if(busy)return;try{
if('serviceWorker' in navigator){
  const registration=await navigator.serviceWorker.getRegistration();
  const subscription=await registration?.pushManager.getSubscription();
  if(subscription){
    try{await window.linePushRequest({action:'remove',endpoint:subscription.endpoint});}
    finally{await subscription.unsubscribe();}
  }
}
}catch{}
try{await raw('/auth/v1/logout?scope=local');}catch(e){}finally{forgetSession();resetRemote();notice('ログアウトしました。');}};
localStatus=async function(){
  const response=await fetch('/api/cloud/status',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
  const state=await response.json();if(!response.ok)throw new Error(state.error||'Macの接続状態を取得できません。');
  $('cloudLogin').classList.toggle('hidden',state.enabled);$('cloudLocalState').classList.toggle('hidden',!state.enabled);
  notice(state.enabled?(state.connected?'リモート接続中: '+state.email+'。スマホ・別PCで同じアカウントにログインしてください。':state.error||'クラウドに接続しています…'):state.error||'同じアカウントへのリモート接続を有効にすると、このMacのLINEをスマホから読み取れます。');
};
$('cloudDisable').onclick=async()=>{if(!confirm('このMacへのリモート接続を解除しますか？'))return;try{await localRequest('cloud/disconnect',{});await localStatus();}catch(e){notice(e.message);}};
}
async function initialize(){
  try{
    const response=await fetch('/cloud-config.json',{cache:'no-store'});config=await response.json();
    if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)||!config.key.startsWith('sb_publishable_'))throw new Error('クラウド設定を確認してください。');
    panel?.classList.remove('hidden');
    if(local&&panel){$('cloudTitle').textContent='スマホ・別PCから使うための設定';$('cloudLoginButton').textContent='ログインしてこのMacを登録';$('cloudSignup').classList.add('hidden');await localStatus();deviceTimer=setInterval(()=>localStatus().catch(e=>notice(e.message)),15000);}
    else if(!local){try{session=JSON.parse(sessionStorage.getItem(storageKey));}catch(e){}if(session){await accessToken();await loggedIn();}}
  }catch(e){notice(e.message);}
}
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
initialize();
})();
