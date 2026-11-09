// Scheduler helpers. `schedule print` shows what would be installed; `install`/`uninstall` act on the OS scheduler for the CURRENT USER only.
// Alternatives with identical behaviour: `govcon daemon` (any OS, honours the profile time zone) or Docker Compose.
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProfile, ROOT } from './config.ts';
import { nextRuns } from './cron.ts';

const LABEL = 'io.github.govcon-intelligence-agent.daily';
const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
export function simpleDaily(cron: string): { minute: number; hour: number } | null {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron.trim()); return m ? { minute: Number(m[1]), hour: Number(m[2]) } : null;
}
export function plist(node: string, entry: string, t: { minute: number; hour: number }, workdir: string, logDir: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(entry)}</string><string>run</string><string>--scheduled</string></array>
  <key>WorkingDirectory</key><string>${esc(workdir)}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${t.hour}</integer><key>Minute</key><integer>${t.minute}</integer></dict>
  <key>StandardOutPath</key><string>${esc(join(logDir, 'govcon.out.log'))}</string><key>StandardErrorPath</key><string>${esc(join(logDir, 'govcon.err.log'))}</string>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
}
export function systemdUnits(node: string, entry: string, t: { minute: number; hour: number }, tz: string, workdir: string) {
  const hh = String(t.hour).padStart(2, '0'), mm = String(t.minute).padStart(2, '0');
  return {
    service: `[Unit]\nDescription=GovCon Intelligence Agent daily run\n\n[Service]\nType=oneshot\nWorkingDirectory=${workdir}\nExecStart=${node} ${entry} run --scheduled\n`,
    timer: `[Unit]\nDescription=GovCon Intelligence Agent daily timer\n\n[Timer]\nOnCalendar=*-*-* ${hh}:${mm}:00 ${tz}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  };
}
export async function schedule(action: string) {
  const profile = loadProfile(); const node = process.execPath; const entry = resolve(ROOT, 'bin', 'govcon.mjs'); const t = simpleDaily(profile.schedule);
  const next = nextRuns(profile.schedule, profile.timezone, new Date(), 3).map((d) => d.toISOString());
  console.log(`Profile schedule: "${profile.schedule}" in ${profile.timezone}. Next runs (UTC): ${next.join(', ') || 'n/a'}`);
  if (!t) { console.log('This schedule is not a simple daily time, so no OS entry can be generated automatically. Use "govcon daemon" (honours any cron expression) or write the entry by hand.'); return; }
  const logDir = join(ROOT, 'data', 'logs'); mkdirSync(logDir, { recursive: true });
  const os = process.platform;
  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`); const body = plist(node, entry, t, ROOT, logDir);
    if (action === 'print') { console.log(`macOS launchd (current user). File: ${file}\nNote: launchd uses the Mac's local time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}), not the profile time zone.\n\n${body}\nInstall with: govcon schedule install   Remove with: govcon schedule uninstall`); return; }
    if (action === 'install') { mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true }); writeFileSync(file, body); const uid = String(process.getuid?.() ?? 501); try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ } execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file]); console.log(`Installed ${LABEL}. It runs "govcon run --scheduled" daily at ${t.hour}:${String(t.minute).padStart(2, '0')} local time.`); return; }
    if (action === 'uninstall') { const uid = String(process.getuid?.() ?? 501); try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* */ } if (existsSync(file)) unlinkSync(file); console.log('Removed.'); return; }
  } else if (os === 'linux') {
    const dir = join(homedir(), '.config', 'systemd', 'user'); const u = systemdUnits(node, entry, t, profile.timezone, ROOT);
    if (action === 'print') { console.log(`systemd user timer. Files in ${dir}:\n--- govcon-agent.service ---\n${u.service}--- govcon-agent.timer ---\n${u.timer}\nOr cron: ${t.minute} ${t.hour} * * * cd ${q(ROOT)} && ${q(node)} ${q(entry)} run --scheduled\nInstall with: govcon schedule install`); return; }
    if (action === 'install') { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'govcon-agent.service'), u.service); writeFileSync(join(dir, 'govcon-agent.timer'), u.timer); execFileSync('systemctl', ['--user', 'daemon-reload']); execFileSync('systemctl', ['--user', 'enable', '--now', 'govcon-agent.timer']); console.log('Installed and started govcon-agent.timer (systemctl --user list-timers).'); return; }
    if (action === 'uninstall') { try { execFileSync('systemctl', ['--user', 'disable', '--now', 'govcon-agent.timer'], { stdio: 'ignore' }); } catch { /* */ } for (const f of ['govcon-agent.service', 'govcon-agent.timer']) if (existsSync(join(dir, f))) unlinkSync(join(dir, f)); console.log('Removed.'); return; }
  } else if (os === 'win32') {
    const hh = String(t.hour).padStart(2, '0'), mm = String(t.minute).padStart(2, '0'); const tr = `\\"${node}\\" \\"${entry}\\" run --scheduled`;
    const create = `schtasks /Create /SC DAILY /ST ${hh}:${mm} /TN GovConIntelligenceAgent /TR "${tr}" /F`;
    if (action === 'print') { console.log(`Windows Task Scheduler (current user). Windows uses the PC's local time zone.\n${create}\nRemove: schtasks /Delete /TN GovConIntelligenceAgent /F`); return; }
    if (action === 'install') { execFileSync('schtasks', ['/Create', '/SC', 'DAILY', '/ST', `${hh}:${mm}`, '/TN', 'GovConIntelligenceAgent', '/TR', `"${node}" "${entry}" run --scheduled`, '/F'], { stdio: 'inherit' }); return; }
    if (action === 'uninstall') { execFileSync('schtasks', ['/Delete', '/TN', 'GovConIntelligenceAgent', '/F'], { stdio: 'inherit' }); return; }
  }
  console.log('Usage: govcon schedule <print|install|uninstall>');
}
