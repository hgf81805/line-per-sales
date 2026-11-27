/**
 * Script properties: IMPORT_KEY, MAILBOX, LSTEP_SENDER, LSTEP_SUBJECT.
 * Run installLstepImport once, from the Gmail account that receives notifications.
 */
function installLstepImport() {
  const config = lstepConfig();
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('LSTEP_START')) {
    properties.setProperty('LSTEP_START', String(Date.now() - 24 * 60 * 60 * 1000));
  }
  importLstepNotifications();
  const old = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === 'importLstepNotifications');
  if (!old.length) ScriptApp.newTrigger('importLstepNotifications').timeBased().everyMinutes(5).create();
}
function lstepConfig() {
  const values = PropertiesService.getScriptProperties().getProperties();
  const mailbox = (values.MAILBOX || '').trim().toLowerCase();
  const sender = (values.LSTEP_SENDER || '').trim().toLowerCase();
  const subject = (values.LSTEP_SUBJECT || '').trim();
  if (!/^[0-9a-f]{64}$/.test(values.IMPORT_KEY || '') ||
      !/^[a-z0-9._+%-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(sender) || !subject ||
      /["\r\n]/.test(subject)) throw Error('スクリプト プロパティを確認してください。');
  if (!mailbox || Session.getEffectiveUser().getEmail().toLowerCase() !== mailbox) {
    throw Error('通知を受信するGmailのアカウントで実行してください。');
  }
  return {key:values.IMPORT_KEY, mailbox, sender, subject};
}
function importLstepNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const config = lstepConfig();
    const props = PropertiesService.getScriptProperties();
    const start = Number(props.getProperty('LSTEP_START'));
    if (!start) throw Error('先に installLstepImport を実行してください。');
    const saved = JSON.parse(props.getProperty('LSTEP_IMPORTED') || '[]');
    const cutoff = Math.max(start, Date.now() - 2 * 24 * 60 * 60 * 1000);
    const imported = new Map(saved.filter(entry => entry[1] >= cutoff));
    try {
      const query = 'in:anywhere -in:spam -in:trash newer_than:2d from:' + config.sender + ' subject:"' + config.subject + '"';
      const matches = GmailApp.search(query, 0, 100).flatMap(thread => thread.getMessages());
      matches.sort((a,b) => a.getDate().getTime() - b.getDate().getTime());
      for (const message of matches) {
        const messageId = message.getId();
        const received = message.getDate();
        if (received.getTime() < cutoff || imported.has(messageId)) continue;
        const from = message.getFrom().trim().toLowerCase();
        const address = from.match(/<([^<>]+)>$/)?.[1] || from;
        if (address !== config.sender || !message.getSubject().includes(config.subject)) continue;
        const body = message.getPlainBody().trim().slice(0,5000);
        if (!body) continue;
        const result = UrlFetchApp.fetch('https://zfwweszgsrovuiabvzye.supabase.co/functions/v1/line-official',{
          method:'post',contentType:'application/json',followRedirects:false,muteHttpExceptions:true,
          headers:{'x-lstep-import':config.key},
          payload:JSON.stringify({id:'mail:'+messageId,subject:message.getSubject().slice(0,100),body,
            mailbox:config.mailbox,received_at:received.toISOString()}),
        });
        if (result.getResponseCode() !== 200) throw Error('取り込みに失敗しました。HTTP '+result.getResponseCode());
        imported.set(messageId,received.getTime());
      }
    } finally {
      props.setProperty('LSTEP_IMPORTED',JSON.stringify([...imported].slice(-180)));
    }
  } finally {
    lock.releaseLock();
  }
}
