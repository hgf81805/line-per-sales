/* Only the final, explicit confirmation calls the send endpoint. */
(() => {
'use strict';
let ticket=null,locked=false,previousChat=null,preparing=false;
const templates={
  schedule:{
    standard:'お打ち合わせの日程を調整できればと思います。ご都合のよい日時をいくつか教えていただけますか？',
    polite:'お打ち合わせの機会をいただけますでしょうか。お手数ですが、ご都合のよい日時をいくつかお知らせいただけますと幸いです。',
    warm:'よければ、一度お話しできるとうれしいです。ご都合のよい日時があれば教えてください。',
    short:'お打ち合わせの候補日時をいくつか教えていただけますか？'
  },
  materials:{
    standard:'先ほどの件について、資料をお送りします。ご不明点がありましたら、お気軽にご連絡ください。',
    polite:'先ほどお話しした件につきまして、資料をお送りいたします。ご確認いただき、ご不明な点がございましたらお知らせください。',
    warm:'先ほどお話しした資料をお送りします。気になるところがあれば、いつでも聞いてください。',
    short:'資料をお送りします。ご質問があればお知らせください。'
  },
  followup:{
    standard:'先日お送りした件について、その後いかがでしょうか。検討にあたって必要な情報があればお送りします。',
    polite:'先日ご連絡した件につきまして、ご検討状況をお聞かせいただけますでしょうか。追加で必要な情報がございましたらお申し付けください。',
    warm:'先日お送りした件、その後いかがでしょうか？ 気になる点があれば、いつでも聞いてください。',
    short:'先日の件、その後いかがでしょうか？ 必要な情報があればお送りします。'
  },
  thanks:{
    standard:'本日はお時間をいただき、ありがとうございました。お話しした内容を踏まえて、改めてご連絡します。',
    polite:'本日はお忙しい中、お時間をいただき誠にありがとうございました。お伺いした内容を踏まえ、改めてご連絡いたします。',
    warm:'今日はお話しできてよかったです。お時間をいただきありがとうございました。また改めてご連絡します。',
    short:'本日はありがとうございました。改めてご連絡します。'
  },
  reschedule:{
    standard:'恐れ入りますが、予定していたお打ち合わせの日程を変更できますか？ ご都合のよい日時を教えていただけると助かります。',
    polite:'お手数をおかけして申し訳ありませんが、お打ち合わせの日程を再調整させていただけますでしょうか。ご都合のよい日時をお知らせいただけますと幸いです。',
    warm:'すみません、予定していたお打ち合わせを別の日に調整できますか？ 空いている日時を教えていただけるとうれしいです。',
    short:'恐れ入りますが、打ち合わせの日程を変更できますか？'
  }
};
window.lineReplyTemplate=(key,tone)=>templates[key]?.[tone];
const toneButtons=document.querySelectorAll('[data-reply-tone]');
let currentTemplate=null,templateText='';
function useTemplate(key,tone){
  const field=$('replyText');
  const next=templates[key]?.[tone];
  if(field.disabled||!next)return;
  if(field.value.trim()&&field.value!==templateText&&!confirm('現在の下書きをテンプレートで置き換えますか？'))return;
  currentTemplate=key;
  templateText=next;
  field.value=next;
  field.dispatchEvent(new Event('input'));
  field.focus();
}
$('insertReplyTemplate').onclick=()=>useTemplate($('replyTemplate').value,'standard');
for(const button of toneButtons)button.onclick=()=>useTemplate(currentTemplate,button.dataset.replyTone);
const originalControls=controls;
function sendControls(){
  if(previousChat!==selected?.id){previousChat=selected?.id;ticket=null;locked=false;currentTemplate=null;templateText='';$('replyText').value='';$('checkSend').classList.add('hidden');}
  if(selected&&$('history').children.length&&!conversationVersion&&!locked)$('sendNotice').textContent='送信するにはMacアプリを最新版に更新し、会話を読み込み直してください。';
  $('replyText').disabled=busy||locked||!conversationVersion;
  $('replyTemplate').disabled=$('insertReplyTemplate').disabled=$('replyText').disabled;
  for(const button of toneButtons)button.disabled=$('replyText').disabled||!currentTemplate||!$('replyText').value.trim();
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
    if(ticket)window.dispatchEvent(new CustomEvent('line-send-accepted',{detail:{ticket_id:ticket.ticket_id,chat_id:ticket.chat_id}}));
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
