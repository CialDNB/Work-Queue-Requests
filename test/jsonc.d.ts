// A wrangler config read as text (test/cron/cron.test.ts pins its `triggers.crons`).
declare module '*.jsonc?raw' {
  const content: string;
  export default content;
}
