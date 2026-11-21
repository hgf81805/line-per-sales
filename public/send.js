/* Only the final, explicit confirmation calls the send endpoint. */
(() => {
'use strict';
let ticket=null,locked=false,previousChat=null,preparing=false;
const originalControls=controls;
function sendControls(){
  if(previousChat!==selected?.id){previousChat=selected?.id;ticket=null;locked=false;$('replyText').value='';$('checkSend').classList.add('hidden');}
  if(selected&&$('history').children.length&&!conversationVersion&&!locked)$('sendNotice').textContent='送信するにはMacアプリを最新版に更新し、会話を読み込み直してください。';
  $('replyText').disabled=busy||locked||!conversationVersion;
  $('prepareSend').disabled=busy||locked||!conversationVersion||!$('replyText').value.trim();
  $('finalSend').disabled=busy||!ticket;$('cancelSend').disabled=busy;
}
controls=function(){originalControls();sendControls();};
$('replyText').oninput=()=>{if(!locked)ticket=null;sendControls();};
new MutationObserver(()=>{
  document.querySelectorAll('#candidates .candidate').forEach(candidate=>{
    const button=document.createElement('button');button.textContent='この候補を本文に使う';
    button.onclick=()=>{if(busy||locked)return;$('replyText').value=candidate.querySelector('p').textContent;ticket=null;sendControls();$('replyText').focus();};candidate.appendChild(button);
  });
}).observe($('candidates'),{childList:true});
function resultNotice(result){
  if(result.status==='accepted'){
    $('sendNotice').textContent='Beeperが送信を受け付けました。LINE側への到達を確認してください。同じ操作は再送しません。';
    $('checkSend').classList.add('hidden');$('replyText').value='';messageId=null;conversationVersion=null;
  }else{
    $('sendNotice').textContent=result.status==='not_attempted'?'このMacに送信の記録が見つかりません。まずLINEで届いていないことを確認してください。':'送信結果が不明です。自動再送はしません。「送信結果を確認」またはLINEの実トークで確認してください。Beeperの書き込み権限も確認してください。';
    $('checkSend').classList.remove('hidden');
  }
  controls();
}
$('prepareSend').onclick=async()=>{
  if(preparing||busy||locked)return;
  preparing=true;
  try{
    const reviewed=await request('prepare-send',{chat_id:selected.id,text:$('replyText').value,conversation_version:conversationVersion});
    ticket=reviewed;
    $('confirmRecipient').textContent=reviewed.title;
    $('confirmAccount').textContent=reviewed.account_id;
    $('confirmBody').textContent=reviewed.text;
    controls();$('sendDialog').showModal();
  }catch(e){$('sendNotice').textContent=e.message;}
  finally{preparing=false;}
};
$('cancelSend').onclick=()=>{$('sendDialog').close();ticket=null;controls();};
$('sendDialog').addEventListener('cancel',event=>{if(busy){event.preventDefault();return;}ticket=null;controls();});
$('finalSend').onclick=async()=>{
  if(busy||!ticket||locked)return;
  locked=true;const approved=ticket;
  $('sendDialog').close();$('sendNotice').textContent='送信処理中です。画面を閉じずにお待ちください。';
  try{resultNotice(await request('send',{ticket_id:approved.ticket_id}));}
  catch(e){$('sendNotice').textContent='送信結果を確認できません。自動再送はしません。「送信結果を確認」かLINEで確認してください。';$('checkSend').classList.remove('hidden');controls();}
};
$('checkSend').onclick=async()=>{
  if(busy||!ticket)return;
  try{resultNotice(await request('send-status',{ticket_id:ticket.ticket_id}));}catch(e){$('sendNotice').textContent=e.message;}
};
const loadHistory=$('loadHistory').onclick;
$('loadHistory').onclick=async event=>{
  if(busy)return;
  if(locked&&ticket&&$('checkSend').classList.contains('hidden')===false&&!confirm('送信結果が不明です。先にLINEで届いていないことを確認してください。会話を読み込み直しますか？'))return;
  ticket=null;locked=false;$('checkSend').classList.add('hidden');$('sendNotice').textContent='宛先と本文を確認してから送信してください。';
  await loadHistory(event);controls();
};
controls();
})();
