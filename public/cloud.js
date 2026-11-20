/* Authenticated multi-device access. No Beeper credential enters this script. */
(() => {
'use strict';
const localRequest = request;
let config, session = null, devices = [], activeDevice = null, cloudActive = false;
let refreshPromise = null, deviceTimer = null, generation = 0;
const panel = document.getElementById('cloudPanel');
const notice = text => { $('cloudNotice').textContent = text; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const storageKey = 'line-remote-auth-v1';
function forgetSession(){session=null;try{sessionStorage.removeItem(storageKey);}catch(e){}}
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
  ['chats','history','candidates'].forEach(id=>$(id).textContent='');$('name').textContent='相手を選んでください';
  if(!local){$('connected').classList.add('hidden');$('setup').classList.remove('hidden');}
  $('cloudLoggedIn').classList.add('hidden');$('cloudLogin').classList.remove('hidden');
  if(deviceTimer){clearInterval(deviceTimer);deviceTimer=null;}controls();
}
async function loadDevices(){
  if(!session)return;
  devices=await raw('/rest/v1/line_remote_devices?select=id,name,last_seen,enabled,capabilities&order=last_seen.desc',undefined,{method:'GET'});
  const select=$('cloudDevice');const previous=select.value;select.replaceChildren();
  for(const d of devices){const option=document.createElement('option');option.value=d.id;option.textContent=d.name+' · '+(d.enabled&&Date.now()-new Date(d.last_seen).getTime()<60000?'オンライン':'オフライン');select.appendChild(option);}
  if(devices.some(d=>d.id===previous))select.value=previous;
  $('cloudUse').disabled=busy||!devices.length;
  notice(devices.length?'接続するMacを選んでください。':'登録されたMacがありません。Macアプリを開き、その接続画面で同じアカウントにログインしてリモート接続を有効にしてください。');
}
async function loggedIn(){
  $('cloudLogin').classList.add('hidden');$('cloudLoggedIn').classList.remove('hidden');$('cloudEmailLabel').textContent=session.user.email;
  await loadDevices();if(deviceTimer)clearInterval(deviceTimer);
  deviceTimer=setInterval(()=>loadDevices().catch(e=>notice(e.message)),15000);
}
async function cloudJob(action,payload){
  if(!['chats','conversation','suggest','prepare-send','send','send-status'].includes(action))throw new Error('この操作には対応していません。');
  const epoch=generation;
  await loadDevices();
  const device=devices.find(d=>d.id===activeDevice);
  if(!device||!device.enabled||Date.now()-new Date(device.last_seen).getTime()>=60000)throw new Error('Macがオフラインです。Mac・Beeper・接続アプリを起動してください。');
  if(['prepare-send','send','send-status'].includes(action)&&!device.capabilities?.includes('confirmed-send-v1'))throw new Error('送信するにはMacアプリを最新版へ更新してください。');
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
request=async function(path,body){
  if(local||!cloudActive)return localRequest(path,body);
  if(path==='disconnect'){generation++;cloudActive=false;return {ok:true};}
  busy=true;controls();$('error').textContent='';$('status').textContent='Macで処理しています…';
  try{return await cloudJob(path,body);}catch(e){$('error').textContent=e.message;throw e;}
  finally{busy=false;controls();$('status').textContent='';}
};
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
  if(activeDevice!==id){selected=null;messageId=null;conversationVersion=null;['history','candidates','chats'].forEach(x=>$(x).textContent='');$('name').textContent='相手を選んでください';}
  generation++;activeDevice=id;cloudActive=true;bridgeToken=null;showConnected();controls();
  document.querySelector('#connected .badge').textContent='クラウド経由 · 確認して送信';
  $('status').textContent='「LINE一覧を取得」を押してください。';
};
$('cloudRefresh').onclick=()=>loadDevices().catch(e=>notice(e.message));
$('cloudLogout').onclick=async()=>{if(busy)return;try{await raw('/auth/v1/logout?scope=local');}catch(e){}finally{forgetSession();resetRemote();notice('ログアウトしました。');}};
async function localStatus(){
  const response=await fetch('/api/cloud/status',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
  const state=await response.json();if(!response.ok)throw new Error(state.error||'Macの接続状態を取得できません。');
  $('cloudLogin').classList.toggle('hidden',state.enabled);$('cloudLocalState').classList.toggle('hidden',!state.enabled);
  notice(state.enabled?(state.connected?'リモート接続中: '+state.email+'。スマホ・別PCで同じアカウントにログインしてください。':state.error||'クラウドに接続しています…'):state.error||'同じアカウントへのリモート接続を有効にすると、このMacのLINEをスマホから読み取れます。');
}
$('cloudDisable').onclick=async()=>{if(!confirm('このMacへのリモート接続を解除しますか？'))return;try{await localRequest('cloud/disconnect',{});await localStatus();}catch(e){notice(e.message);}};
async function initialize(){
  try{
    const response=await fetch('/cloud-config.json',{cache:'no-store'});config=await response.json();
    if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)||!config.key.startsWith('sb_publishable_'))throw new Error('クラウド設定を確認してください。');
    panel.classList.remove('hidden');
    if(local){$('cloudTitle').textContent='スマホ・別PCから使うための設定';$('cloudLoginButton').textContent='ログインしてこのMacを登録';$('cloudSignup').classList.add('hidden');await localStatus();deviceTimer=setInterval(()=>localStatus().catch(e=>notice(e.message)),15000);}
    else{try{session=JSON.parse(sessionStorage.getItem(storageKey));}catch(e){}if(session){await accessToken();await loggedIn();}}
  }catch(e){notice(e.message);}
}
initialize();
})();
