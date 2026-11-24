"""Schedule follow-ups for confirmed sends and list work across the CRM."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid5

from attio_bridge import AttioError
import beeper_reader as reader

JST = timezone(timedelta(hours=9))


def weekday_deadline(accepted_at, days):
    date = datetime.fromtimestamp(accepted_at, JST).date()
    while days:
        date += timedelta(days=1)
        if date.weekday() < 5:
            days -= 1
    return datetime(date.year, date.month, date.day, 10, tzinfo=JST)


def save(attio, sender, token, payload):
    ticket = payload.get('ticket_id')
    accepted = sender.accepted_target(ticket)
    if not accepted:
        raise AttioError('送信受付済みの操作からフォローを登録してください。')
    account, cid, accepted_at = accepted
    current = sender.chat(token, cid)
    if current['account_id'] != account:
        raise AttioError('LINEの送信元が変わりました。')
    days = payload.get('days')
    if type(days) is not int or days not in (1, 3, 5):
        raise AttioError('フォロー日を選択してください。')
    deadline = weekday_deadline(accepted_at, days)
    with attio.lock:
        linked = attio.linked(account, cid)
        deal = linked['deal']
        if not deal or deal['id'] != payload.get('deal_id'):
            raise AttioError('紐付け先の案件が変わりました。案件を確認してください。')
        result = attio.mutate('task', {
            'confirmed': payload.get('confirmed'),
            'operation_id': str(uuid5(NAMESPACE_URL, 'line-followup:' + ticket)),
            'deal_id': deal['id'], 'owner_id': payload.get('owner_id'),
            'content': payload.get('content'), 'deadline': deadline.isoformat(),
        })
        workspace = attio.identity()['workspace_id']
        with closing(attio.db()) as db:
            db.execute('insert or ignore into send_followups(workspace,task,account,chat,sent) values(?,?,?,?,?)',
                       (workspace,result['id'],account,cid,accepted_at))
        return {**result, 'deadline':deadline.isoformat()}


def plan(attio, sender, token, payload):
    accepted = sender.accepted_target(payload.get('ticket_id'))
    if not accepted:
        raise AttioError('送信受付済みの操作からフォローを登録してください。')
    account, cid, accepted_at = accepted
    if sender.chat(token,cid)['account_id'] != account:
        raise AttioError('LINEの送信元が変わりました。')
    deal = attio.linked(account,cid)['deal']
    return {'deal':deal, 'members':attio.members() if deal else [],
            'dates':{str(days):weekday_deadline(accepted_at,days).isoformat() for days in (1,3,5)}}


def parse_date(value):
    try:
        value = datetime.fromisoformat(value.replace('Z','+00:00'))
        return value if value.tzinfo else None
    except (AttributeError, ValueError):
        return None


def has_reply(sender, token, account, cid, sent):
    try:
        if sender.chat(token,cid)['account_id'] != account:
            return False
        cursor = None
        for _ in range(5):
            page = reader.message_page(token,cid,cursor)
            stamps = [(row,stamp) for row in page.get('items',[]) if (stamp := parse_date(row.get('timestamp')))]
            if any(row.get('isSender') is False and stamp.timestamp() > sent for row,stamp in stamps):
                return True
            older = page.get('oldestCursor')
            if any(stamp.timestamp() <= sent for _,stamp in stamps) or not page.get('hasMore') or not older or older==cursor:
                break
            cursor = older
        return False
    except (RuntimeError, OSError, ValueError):
        return False


def agenda(attio, sender, token, offset):
    if type(offset) is not int or not 0 <= offset <= 100000:
        raise AttioError('一覧の位置が正しくありません。')
    page_size = 12
    workspace = attio.identity()['workspace_id']
    deals = attio.deal_page(offset,page_size)
    now = datetime.now(JST)
    with closing(attio.db()) as db:
        tracked = {row[0]:row[1:] for row in db.execute(
            'select task,account,chat,sent,replied from send_followups where workspace=?',(workspace,)
        )}
    def inspect(deal):
        stage = deal.get('stage','').lower().split(' ')[0]
        if stage in ('won','lost','成約','失注'):
            return []
        items, planned = [], False
        for start in range(0,10000,50):
            tasks = attio.tasks(deal['id'],offset=start)
            for task in tasks:
                deadline = parse_date(task['deadline'])
                planned |= deadline is not None
                kind = ('overdue' if deadline < now else 'today' if deadline.astimezone(JST).date()==now.date() else None) if deadline else None
                reply = False
                tracking = tracked.get(task['id'])
                if tracking:
                    account,cid,sent,seen=tracking
                    reply = bool(seen) or has_reply(sender,token,account,cid,sent)
                    if reply and not seen:
                        with closing(attio.db()) as db:
                            db.execute('update send_followups set replied=1 where workspace=? and task=?',(workspace,task['id']))
                if kind or reply:
                    items.append({'deal':deal,'task':task,'kind':kind or 'reply','reply':reply})
            if len(tasks)<50:
                break
        if not planned:
            items.append({'deal':deal,'task':None,'kind':'unscheduled','reply':False})
        return items
    with ThreadPoolExecutor(max_workers=4) as pool:
        items = [item for group in pool.map(inspect,deals) for item in group]
    return {'items':items,'next_offset':offset+len(deals) if len(deals)==page_size else None}
