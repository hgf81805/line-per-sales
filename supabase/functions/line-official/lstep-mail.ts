export function parseLstepMail(value: string) {
  const lines = value.replaceAll('\r\n', '\n').split('\n');
  const heading = lines.map(line=>line.trim()).find(line=>/^[(（].+[)）]\s*メッセージ通知$/.test(line));
  const account = heading?.replace(/^[(（]/,'').replace(/[)）]\s*メッセージ通知$/,'').trim();
  // Read only the footer link, never a URL supplied inside the customer message.
  const footer = lines.findLastIndex(line=>/^\s*>?\s*返信はこちらから\s*$/.test(line));
  if(!account||footer<0)return null;
  const link=lines.slice(footer+1).find(line=>line.trim())?.trim()||'';
  const member=link.match(/^https:\/\/manager\.linestep\.net\/notification\/view\?type=member&id=(\d{1,24})$/)?.[1];
  if(!member)return null;
  const message=lines.slice(0,footer).join('\n').match(/^([^\n]{1,100}?)がメッセージ[ \t　]*「([\s\S]*)」[ \t　]*を送信しました。?[ \t　]*$/m);
  if(!message||!message[2].trim())return null;
  return {account,member,sender:message[1].trim(),body:message[2].trim(),link};
}
