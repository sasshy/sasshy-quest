/** Tool definitions shown to Claude / ChatGPT. Descriptions are in Japanese because the user is. */

export const tokyoDate = (now = new Date()) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const SERVER_INSTRUCTIONS = [
  'SASSHYはユーザー（ADHDのある本人）のタスク・タイマーアプリです。',
  '会話の中で「やる」「入れて」「忘れそう」などやることが出たら、add_task で1件ずつ入れてください。',
  'タスクはできるだけ小さく具体的な行動にし、所要時間は15分前後を目安にします（長い作業はアプリ側で15分ずつに区切られます）。',
  '日付の指定がなければ今日に入れます。いつかやること・ほしいものは date に "none"。',
  '完了・変更・削除の前には list_tasks で task_id と revision を取得してください。',
  '登録後は、入れた内容を短く1行で伝えてください。責めたり急かしたりしない言葉で。',
].join('\n');

const dateProp = { type: 'string', description: 'YYYY-MM-DD（日本時間）' };

export const TOOLS = [
  {
    name: 'add_task',
    title: 'SASSHYにタスクを追加',
    description: 'SASSHYにやることを1件追加します。複数あるときは1件ずつ呼びます。日付を省くと今日。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '具体的な行動（例：保険の書類に署名して封筒に入れる）', maxLength: 200 },
        notes: { type: 'string', description: '詳細・背景・相手など（任意）', maxLength: 4000 },
        date: { type: 'string', description: 'YYYY-MM-DD。省略で今日。いつかやることは "none"' },
        start_time: { type: 'string', description: '時刻が決まっている予定だけ HH:MM' },
        duration_min: { type: 'integer', minimum: 5, maximum: 720, description: '所要時間（分）。省略で15' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'タスクを追加', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_tasks',
    title: 'SASSHYのタスクを見る',
    description: '期間や言葉でタスクを探します。省略すると今日から1週間の未完了。完了・変更の前に task_id と revision を得るためにも使います。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'タイトルやメモに含まれる言葉（任意）' },
        from_date: dateProp,
        to_date: dateProp,
        status: { type: 'string', enum: ['open', 'done', 'deleted', 'all'], description: '省略で open（未完了）' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: { title: 'タスクを見る', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'complete_task',
    title: 'タスクを完了にする',
    description: 'list_tasks で得た task_id と revision を指定して完了にします。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, revision: { type: 'string', description: 'list_tasks の revision（updatedAt）' } },
      required: ['task_id', 'revision'],
      additionalProperties: false,
    },
    annotations: { title: '完了にする', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'update_task',
    title: 'タスクを変更する',
    description: 'タイトル・メモ・日付・時刻・所要時間などを変えます。task_id と revision は list_tasks から。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        revision: { type: 'string' },
        changes: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            notes: { type: 'string' },
            scheduled_date: { type: ['string', 'null'], description: 'YYYY-MM-DD。null で日付なし' },
            start_time: { type: ['string', 'null'], description: 'HH:MM。null で時刻なし' },
            duration_min: { type: 'integer', minimum: 5, maximum: 720 },
          },
          additionalProperties: false,
        },
      },
      required: ['task_id', 'revision', 'changes'],
      additionalProperties: false,
    },
    annotations: { title: '変更する', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_task',
    title: 'タスクを消す',
    description: 'タスクを消します（アプリの復元から戻せます）。本人がはっきり頼んだときだけ使います。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, revision: { type: 'string' } },
      required: ['task_id', 'revision'],
      additionalProperties: false,
    },
    annotations: { title: '消す', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];
