(() => {
'use strict';
const main=document.querySelector('main');
const inbox=$('official-line');
const officialActive=()=>location.hash!=='#direct-line';
const templates={
  consult:'お問い合わせありがとうございます。ご相談内容と、ご都合のよい日時をいくつか教えていただけますか？',
  price:'お問い合わせありがとうございます。料金をご案内しますので、ご希望の内容やご利用予定を教えていただけますか？',
  materials:'資料についてお問い合わせいただきありがとうございます。ご希望のサービスや、特に知りたい内容を教えていただけますか？',
  receipt:'お問い合わせありがとうございます。内容を確認して、担当者からご案内します。'
};
const make=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;return element;};
let accounts=[],accountId=null,records=[],recent=[],current=null,busy=false,review=null,viewGeneration=0;
const status=$('officialStatus'), sendStatus=$('officialSendStatus'), field=$('officialText');
const isEmail=()=>accounts.some(account=>account.id===accountId&&account.source==='email');
function buttons(){
  $('officialReview').hidden=isEmail();
  $('officialCopy').hidden=$('officialDone').hidden=!isEmail();
  $('officialCopy').disabled=busy||!current||!field.value.trim();
  $('officialDone').disabled=busy||!current||!needsReply(current);
  $('officialAccount').disabled=busy||accounts.length<2;
  $('officialLoad').disabled=busy;
  $('officialInsert').disabled=$('officialPriority').disabled=field.disabled=busy||!current;
  $('officialAI').disabled=busy||!current||!recent.length;
  $('officialReview').disabled=busy||!current||!field.value.trim();
  $('officialSend').disabled=busy;
  for(const button of $('officialThreads').querySelectorAll('button'))button.disabled=busy;
}
function resetInbox(){
  records=[];recent=[];current=null;review=null;field.value='';
  $('officialReplyLink').hidden=true;
  $('officialReplyLink').removeAttribute('href');
  $('officialHistory').replaceChildren();
  $('officialName').textContent='問い合わせを選んでください';
  status.textContent=sendStatus.textContent='';
  renderThreads();buttons();
}
function accountRequest(data){
  return window.lineOfficialRequest({...data,account_id:accountId});
}
function showOfficialAccess(){
  const signedIn=window.lineOfficialSignedIn?.()===true;
  $('officialAuth').hidden=signedIn;
  $('officialLoginForm').hidden=local;
  $('officialLocalAuth').hidden=!local;
  $('officialInboxContent').hidden=!signedIn;
  if(!signedIn&&!local&&!$('officialLoginEmail').value){
    try{$('officialLoginEmail').value=localStorage.getItem('line-login-email')||'';}catch{}
  }
  return signedIn;
}
$('officialLoginForm').onsubmit=async event=>{
  event.preventDefault();
  const password=$('officialLoginPassword');
  const button=$('officialLoginButton');
  if(button.disabled)return;
  button.disabled=true;
  $('officialAuthStatus').textContent='ログイン中…';
  try{
    await window.lineOfficialLogin($('officialLoginEmail').value.trim(),password.value,$('officialKeepLogin').checked);
    password.value='';
    $('officialAuthStatus').textContent='';
    if(officialActive()&&showOfficialAccess())load();
  }catch(error){
    password.value='';
    $('officialAuthStatus').textContent=error.message;
  }finally{button.disabled=false;}
};
window.addEventListener('connectionchange',()=>{
  if(officialActive()&&!window.lineOfficialSignedIn?.()){
    viewGeneration++;
    accounts=[];accountId=null;
    $('officialMailKeyPanel').hidden=true;
    $('officialMailKey').value='';
    if($('officialDialog').open)$('officialDialog').close();
    resetInbox();
    showOfficialAccess();
  }
});
function switchView(){
  const active=officialActive();
  viewGeneration++;
  main.classList.toggle('official-view',active);
  inbox.classList.toggle('hidden',!active);
  $('officialNav').toggleAttribute('aria-current',active);
  $('directNav').toggleAttribute('aria-current',!active);
  (active?$('officialNav'):$('directNav')).setAttribute('aria-current','page');
  if(active){
    accounts=[];accountId=null;
    $('officialMailKeyPanel').hidden=true;
    $('officialMailKey').value='';
    $('officialAccount').replaceChildren();
    resetInbox();
    Promise.resolve(window.lineCloudReady).then(()=>{if(officialActive()&&showOfficialAccess())load();});
  }else if($('officialDialog').open)$('officialDialog').close();
}
function time(value){return new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});}
const title=thread=>thread.display_name||('お客様 '+thread.line_user.slice(-6));
const needsReply=thread=>!thread.replied_at||Date.parse(thread.inbound_at)>Date.parse(thread.replied_at);
function renderThreads(){
  const visible=records.filter(row=>!$('officialPending').checked||needsReply(row));
  const rows=visible.map(row=>{
    const button=make('button',(row.priority?'★ ':'')+title(row));
    button.type='button';button.className='chat-button';
    button.classList.toggle('selected',current?.line_user===row.line_user);
    button.append(make('span',(needsReply(row)?'要返信 · ':'対応済み · ')+time(row.inbound_at)));
    button.onclick=()=>openThread(row);
    return button;
  });
  $('officialThreads').replaceChildren(...rows);
}
async function run(action,errorTarget=status){
  if(busy)return;
  const generation=viewGeneration;
  busy=true;buttons();
  try{await action(()=>generation===viewGeneration);}
  catch(error){if(generation===viewGeneration)errorTarget.textContent=error.message;}
  finally{busy=false;buttons();}
}
async function load(){
  await run(async valid=>{
    status.textContent='取得中…';
    if(!accountId){
      const result=await window.lineOfficialRequest({action:'accounts'});
      if(!valid())return;
      accounts=result.accounts;
      const emailAccount=accounts.find(account=>account.source==='email');
      if(emailAccount&&!$('officialMailbox').value)$('officialMailbox').value=emailAccount.mailbox;
      if(!$('officialMailSender').value)$('officialMailSender').value='noreply@service.linestep.net';
      if(!$('officialMailSubject').value)$('officialMailSubject').value='【通常メッセージ】';
      if(!accounts.length)throw new Error('公式LINEを接続するか、通知メールの取り込みを設定してください。');
      accountId=accounts[0].id;
      $('officialAccount').replaceChildren(...accounts.map(account=>new Option(account.label,account.id)));
    }
    const result=await accountRequest({action:'list'});
    if(!valid())return;
    records=result.threads;
    renderThreads();
    status.textContent=records.length?'':'新しい問い合わせを待っています。';
  });
}
async function history(row,valid){
  const result=await accountRequest({action:'history',line_user:row.line_user});
  if(!valid())return;
  current=row;
  recent=result.messages;
  row.display_name=result.display_name;
  $('officialName').textContent=title(row);
  const link=$('officialReplyLink');
  const safeLink=isEmail()&&/^https:\/\/manager\.linestep\.net\/notification\/view\?type=member&id=\d{1,24}$/.test(result.reply_url||'');
  link.hidden=!safeLink;
  if(safeLink)link.href=result.reply_url;
  else link.removeAttribute('href');
  $('officialPriority').textContent=row.priority?'優先リードを解除':'優先リードにする';
  $('officialHistory').replaceChildren(...result.messages.map(item=>{
    const line=make('div','');
    line.className=item.direction==='out'?'message mine':'message';
    line.append(make('small',time(item.created_at)),document.createTextNode(item.body));
    return line;
  }));
  renderThreads();
}
function openThread(row){
  if(current?.line_user!==row.line_user&&field.value.trim()&&!confirm('編集中の下書きを破棄しますか？'))return;
  run(async valid=>{
    await history(row,valid);
    if(valid()){field.value='';review=null;sendStatus.textContent='';}
  });
}
$('officialLoad').onclick=load;
$('officialAccount').onchange=()=>{
  const next=$('officialAccount').value;
  if(busy||!accounts.some(account=>account.id===next))return;
  if(field.value.trim()&&!confirm('編集中の下書きを破棄してアカウントを切り替えますか？')){
    $('officialAccount').value=accountId;
    return;
  }
  accountId=next;
  resetInbox();
  load();
};

$('officialPending').onchange=()=>{renderThreads();buttons();};
$('officialPriority').onclick=()=>run(async valid=>{
  const row=current;
  await accountRequest({action:'priority',line_user:row.line_user,active:!row.priority});
  if(!valid())return;
  row.priority=!row.priority;
  $('officialPriority').textContent=row.priority?'優先リードを解除':'優先リードにする';
  records.sort((a,b)=>Number(b.priority)-Number(a.priority)||Date.parse(b.inbound_at)-Date.parse(a.inbound_at));
  renderThreads();
});
$('officialInsert').onclick=()=>{
  if(!field.value.trim()||confirm('下書きを置き換えますか？')){
    field.value=templates[$('officialTemplate').value];buttons();field.focus();
  }
};
function draftHistory(){
  const rows=recent.slice(-20).map(({direction,body})=>({direction,characters:Array.from(body)}));
  const build=limit=>rows.map(({direction,characters})=>({direction,body:characters.slice(0,limit).join('')}));
  const encoder=new TextEncoder();
  let low=1,high=1000;
  while(low<high){
    const middle=Math.ceil((low+high)/2);
    if(encoder.encode(JSON.stringify(build(middle))).length<=7000)low=middle;
    else high=middle-1;
  }
  return build(low);
}
$('officialAI').onclick=()=>{
  if(field.value.trim()&&!confirm('下書きを置き換えますか？'))return;
  run(async valid=>{
    sendStatus.textContent='Macで下書きを作成中…';
    const result=await window.lineOfficialDraft({style:$('officialTemplate').value,
      history:draftHistory()});
    if(!valid())return;
    field.value=result.draft;
    sendStatus.textContent=result.history_count?'直近'+result.history_count+'件をもとに下書きを作成しました。':'AIの下書きを入れました。';
  },sendStatus);
};
$('officialMailForm').onsubmit=event=>{
  event.preventDefault();
  const mailbox=$('officialMailbox').value.trim().toLowerCase();
  const sender=$('officialMailSender').value.trim().toLowerCase();
  const subject=$('officialMailSubject').value.trim();
  const interval=Number($('officialMailInterval').value);
  if(!subject||/["\r\n]/.test(subject)){
    $('officialMailStatus').textContent='件名に含まれる語句を確認してください。';
    return;
  }
  if(accounts.some(account=>account.mailbox===mailbox&&account.key_created)&&!confirm('以前の取り込みキーを無効にして、新しく発行しますか？'))return;
  run(async valid=>{
    const result=await window.lineOfficialRequest({action:'mail_setup',mailbox});
    if(!valid())return;
    $('officialMailKey').value=JSON.stringify({key:result.key,mailbox,sender,subject,interval});
    $('officialMailKeyPanel').hidden=false;
    $('officialMailStatus').textContent='設定をコピーし、Apps Scriptのスクリプト プロパティ LSTEP_CONFIG に貼り付けてください。';
    accountId=null;
  },$('officialMailStatus')).then(load);
};
$('officialMailCopyKey').onclick=async()=>{
  try{await navigator.clipboard.writeText($('officialMailKey').value);$('officialMailStatus').textContent='設定をコピーしました。';}
  catch{$('officialMailStatus').textContent='設定をコピーできませんでした。';}
};
$('officialCopy').onclick=async()=>{
  try{await navigator.clipboard.writeText(field.value.trim());sendStatus.textContent='返信をコピーしました。Lステップの元のトークで送信してください。';}
  catch{sendStatus.textContent='コピーできませんでした。本文を選択してコピーしてください。';}
};
$('officialDone').onclick=()=>run(async valid=>{
  const row=current;
  await accountRequest({action:'mark_done',line_user:row.line_user});
  if(!valid())return;
  row.replied_at=new Date().toISOString();
  renderThreads();
  sendStatus.textContent='対応済みにしました。';
},sendStatus);
field.oninput=buttons;
$('officialReview').onclick=async()=>{
  if(!current||busy||isEmail()||!field.value.trim())return;
  const id=current.line_user,text=field.value.trim(),account=accountId;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([account,id,text])));
  if(inbox.classList.contains('hidden')||accountId!==account||current?.line_user!==id||field.value.trim()!==text||$('officialDialog').open)return;
  const key='official-send:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  const requestId=sessionStorage.getItem(key)||crypto.randomUUID();
  review={id,text,key,requestId,account};
  $('officialRecipient').textContent=title(current)+' · 送信元 '+accounts.find(item=>item.id===account)?.label;
  $('officialBody').textContent=text;
  $('officialDialog').showModal();
};
$('officialCancel').onclick=()=>$('officialDialog').close();
$('officialSend').onclick=()=>run(async valid=>{
  const pending=review,row=current;
  if(!pending||row?.line_user!==pending.id||accountId!==pending.account)return;
  sessionStorage.setItem(pending.key,pending.requestId);
  $('officialDialog').close();
  sendStatus.textContent='送信中…';
  await accountRequest({action:'send',line_user:pending.id,text:pending.text,request_id:pending.requestId});
  sessionStorage.removeItem(pending.key);
  if(!valid())return;
  review=null;field.value='';
  sendStatus.textContent='LINEが送信を受け付けました。';
  row.replied_at=new Date().toISOString();
  renderThreads();
  try{await history(row,valid);}catch{/* The message was already accepted. */}
},sendStatus);
window.addEventListener('hashchange',switchView);
switchView();
})();
