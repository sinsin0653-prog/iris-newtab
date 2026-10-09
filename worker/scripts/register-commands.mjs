// スラッシュコマンドを Discord に登録する。DISCORD_TOKEN と DISCORD_APP_ID を環境変数で渡す。
//   DISCORD_TOKEN=... DISCORD_APP_ID=... node scripts/register-commands.mjs
import { COMMANDS, API } from '../src/discord.js';

const token = process.env.DISCORD_TOKEN, app = process.env.DISCORD_APP_ID;
if (!token || !app) { console.error('DISCORD_TOKEN と DISCORD_APP_ID が要る'); process.exit(1); }
const res = await fetch(`${API}/applications/${app}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS)
});
console.log(res.status, res.ok ? `登録した：${COMMANDS.map((c) => '/' + c.name).join(' ')}` : await res.text());
process.exit(res.ok ? 0 : 1);
