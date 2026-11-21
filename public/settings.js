'use strict';
const local=document.documentElement.dataset.local==='1';
const $=id=>document.getElementById(id);
const bridgeBase='http://127.0.0.1:8767';
let selected=null,messageId=null,conversationVersion=null,busy=false,bridgeToken=null;
const settingsPage=true;
function controls(){
  for(const id of ['connectMac','issueCode','revokeSite','attioConnect','attioDisconnect','cloudLogout','cloudDevice']) $(id).disabled=busy;
}
function showConnected(){}
async function request(path,body){
  if(!local)throw new Error('Mac内の設定で行ってください。');
  busy=true;controls();$('error').textContent='';
  try{
    const response=await fetch('/api/'+path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error);
    return data;
  }catch(error){$('error').textContent=error.message;throw error;}
  finally{busy=false;controls();}
}
$('issueCode').onclick=async()=>{try{const data=await request('pair-code',{});$('issuedCode').textContent='接続コード: '+data.code+'（5分間・1回限り）';}catch(e){}};
$('revokeSite').onclick=async()=>{try{await request('disconnect',{});$('issuedCode').textContent='公開サイトの接続を解除しました。';}catch(e){}};
$('connectMac').onclick=async()=>{
const code=$('pairCode').value.trim();if(!/^[a-f0-9]{16}$/.test(code)){$('error').textContent='Mac内の画面で発行した16文字の接続コードを入力してください。';return;}
busy=true;controls();$('error').textContent='';$('status').textContent='このMacへ接続しています…';
try{const res=await fetch(bridgeBase+'/api/pair',{method:'POST',credentials:'omit',cache:'no-store',targetAddressSpace:'loopback',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const data=await res.json();if(!res.ok)throw new Error(data.error);bridgeToken=data.session;try{sessionStorage.setItem('line-bridge-session',bridgeToken);sessionStorage.removeItem('line-selected-device');}catch{}$('pairCode').value='';showConnected();$('status').textContent='このMacに接続しました。LINE・返信へ進めます。';}
catch(e){$('error').textContent=e instanceof TypeError?'Mac内の最新版アプリを起動し、Chromeでこのデバイスへの接続を許可してください。接続コードはMac内の画面で発行できます。':e.message;$('status').textContent='';}
finally{busy=false;controls();}};
function setupFeedback(message, state='info') {
  const status=$('attioSetupStatus');
  status.textContent=message;
  status.dataset.state=state;
}
function setupConnection(state, saved=false) {
  if (!state.connected) {
    setupFeedback(state.error||'Attioは未接続です。',state.error?'error':'info');
    return;
  }
  const message=(saved?'新しいトークンを確認して保存しました。 ':'接続済み：')+
    (state.workspace_name||state.workspace_slug||'Attio')+'。 ';
  if(state.notes_write===false){
    setupFeedback(message+'ノート編集には Notes を「Read & write」にしたトークンが必要です。','warning');
  } else {
    setupFeedback(message+(state.notes_write?'ノートの読み書き権限あり。':'ノート権限は確認できませんでした。'),state.notes_write?'success':'warning');
  }
}
$('attioConnect').onclick=async()=>{
  if(!local||busy)return;
  const input=$('attioToken'),token=input.value.trim();
  if(!token){
    setupFeedback('AttioのAPIトークンを入力してください。','error');
    input.focus();
    return;
  }
  setupFeedback('Attioの接続と権限を確認しています…');
  try{
    const result=await request('attio/configure',{token});
    input.value='';
    setupConnection(result,true);
  }catch(error){
    const message=error instanceof TypeError||error instanceof SyntaxError
      ? 'Macの接続アプリに到達できません。アプリを起動して画面を開き直してください。'
      : error.message;
    setupFeedback('保存できませんでした。 '+message,'error');
    input.focus();
  }
};

$('attioDisconnect').onclick=async()=>{
  if(busy||!local||!confirm('このMacのAttio接続を解除しますか？'))return;
  try{await request('attio/disconnect',{});setupFeedback('接続を解除しました。');}
  catch(error){setupFeedback(error.message,'error');}
};
if(local){
  $('setup').classList.add('hidden');
  $('attioSetup').classList.remove('hidden');
  $('localPair').classList.remove('hidden');
  request('attio/status',{}).then(state=>setupConnection(state))
    .catch(()=>setupFeedback('Attioの接続状態を取得できませんでした。','error'));
}
