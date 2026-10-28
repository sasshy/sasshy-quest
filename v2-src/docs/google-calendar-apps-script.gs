/**
 * SASSHY ⇄ Googleカレンダー（Apps Script Webアプリ）
 * - 予定を読む：?token=…&from=…&to=…&callback=…
 * - 予定を動かす：上に加えて &action=move&id=…&start=ISO&end=ISO（終日は &allDay=1&start=YYYY-MM-DD&end=YYYY-MM-DD）
 *
 * 使い方：
 * 1. このコードで、今のApps Scriptのコードをまるごと置き換える
 * 2. プロジェクトの設定 › スクリプト プロパティ に TOKEN を追加し、
 *    値は今使っているURLの token= のあとの文字列と同じにする
 * 3. デプロイ › デプロイを管理 › 鉛筆 › バージョン「新バージョン」 › デプロイ（URLは変わらない）
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = /^[A-Za-z0-9_]+$/.test(p.callback || '') ? p.callback : '';
  var out = function (data) {
    var json = JSON.stringify(data);
    if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
  };
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || p.token !== token) return out({ ok: false, error: 'token' });
  try {
    if (p.action === 'move') return out(moveEvent(p));
    return out({ ok: true, events: listEvents(p) });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function listEvents(p) {
  var from = p.from ? new Date(p.from) : new Date(Date.now() - 45 * 86400000);
  var to = p.to ? new Date(p.to) : new Date(Date.now() + 180 * 86400000);
  var events = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (!cal.isSelected() || cal.isHidden()) return;
    cal.getEvents(from, to).forEach(function (ev) {
      var allDay = ev.isAllDayEvent();
      events.push({
        // カレンダーIDも入れておくと、動かすときに確実に見つけられる
        id: cal.getId() + '::' + ev.getId(),
        title: ev.getTitle(),
        start: allDay ? ymd(ev.getAllDayStartDate()) : ev.getStartTime().toISOString(),
        end: allDay ? ymd(ev.getAllDayEndDate()) : ev.getEndTime().toISOString(),
        allDay: allDay,
        recurring: ev.isRecurringEvent(),
        editable: cal.isOwnedByMe(),
        calendarName: cal.getName(),
        calendarColor: cal.getColor(),
      });
    });
  });
  return events;
}

function moveEvent(p) {
  var parts = String(p.id || '').split('::');
  if (parts.length !== 2) throw new Error('予定のIDが正しくありません');
  var cal = CalendarApp.getCalendarById(parts[0]);
  if (!cal || !cal.isOwnedByMe()) throw new Error('このカレンダーの予定は動かせません');
  var ev = cal.getEventById(parts[1]);
  if (!ev) throw new Error('予定が見つかりません');
  if (ev.isRecurringEvent()) throw new Error('繰り返しの予定はGoogleカレンダーで動かしてください');
  if (p.allDay === '1') {
    var s = parseYmd(p.start), en = parseYmd(p.end);
    if (en > s) ev.setAllDayDates(s, en); else ev.setAllDayDate(s);
  } else {
    var start = new Date(p.start), end = new Date(p.end);
    if (isNaN(start) || isNaN(end) || end <= start) throw new Error('時刻が正しくありません');
    ev.setTime(start, end);
  }
  return { ok: true };
}

function ymd(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function parseYmd(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error('日付が正しくありません');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
