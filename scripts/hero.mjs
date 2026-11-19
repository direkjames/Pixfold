// Makes the README hero images from the real app (headless Chrome over the DevTools protocol).
// Usage: npm run build, then `npx vite preview --port 4173`, then `node scripts/hero.mjs`.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'screenshots');
const work = mkdtempSync(join(tmpdir(), 'pixfold-hero-'));
mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const app = process.env.APP_URL ?? 'http://localhost:4173/';

const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

const ws = await connect();
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const view = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
async function shot(file) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

const SPRITE = `(async()=>{
  const rows=["................",".....KKKKKK.....","...KKRRRRRRKK...","..KRRWWRRRRRRK..",".KRRWWWRRRWWRRK.",".KRRRWRRRRWWRRK.","KRRRRRRRRRRRRRRK","KRWWRRRRRRWWRRRK","KRWWRRRWWRRWRRRK","KRRRRRRRRRRRRRRK",".KKKKKKKKKKKKKK.","....KCCCCCCK....","....KCCSSCCK....","....KCCSSCCK....","....KCCCCCCK....",".....KKKKKK....."];
  const P={K:'#2a2233',R:'#e4504a',W:'#fff1dc',C:'#f2d7b0',S:'#d9b88a'};
  const c=document.createElement('canvas');c.width=16;c.height=16;const g=c.getContext('2d');
  rows.forEach((r,y)=>[...r].forEach((ch,x)=>{if(P[ch]){g.fillStyle=P[ch];g.fillRect(x,y,1,1)}}));
  const blob=await new Promise(r=>c.toBlob(r));
  const dt=new DataTransfer();dt.items.add(new File([blob],'mushroom.png',{type:'image/png'}));
  document.getElementById('stage').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
  await new Promise(r=>setTimeout(r,800));return true})()`;

async function appShot(theme, file) {
  await view(1560, 900);
  await send('Page.navigate', { url: app });
  await sleep(1200);
  await evaluate(`localStorage.setItem('pixfold.theme','${theme}')`);
  await send('Page.reload');
  await sleep(1200);
  await evaluate(SPRITE);
  await sleep(3800); // let the "Opened" toast fade
  await shot(file);
}

const appLight = join(work, 'app-light.png'), appDark = join(work, 'app-dark.png');
await appShot('light', appLight);
await appShot('dark', appDark);

const uri = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');
const mark = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8');
const fonts = '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&family=Silkscreen:wght@700&display=swap" rel="stylesheet">';

const heroA = (w, h) => `<!doctype html><meta charset=utf-8>${fonts}<style>
*{box-sizing:border-box;margin:0}body{width:${w}px;height:${h}px;overflow:hidden;background:#FBF7F2;font-family:'Bricolage Grotesque',system-ui;color:#1B1A1F;position:relative}
.dots{position:absolute;inset:0;background-image:radial-gradient(#D9D2C5 2px,transparent 2.4px);background-size:36px 36px;opacity:.7}
.copy{position:absolute;left:${w * 0.06}px;top:50%;transform:translateY(-52%);width:${w * 0.34}px}
.logo{display:flex;align-items:center;gap:16px;margin-bottom:${h * 0.05}px}.logo svg{width:64px;height:64px}.logo b{font-size:42px;font-weight:800;letter-spacing:-.02em}.logo i{font:normal 700 36px Silkscreen}
h1{font-size:${w * 0.044}px;line-height:1.02;font-weight:800;letter-spacing:-.03em}
p{margin-top:${h * 0.03}px;font-size:${w * 0.0145}px;line-height:1.45;color:#5E5A62;font-weight:500;max-width:90%}
.pills{display:flex;gap:12px;margin-top:${h * 0.04}px}.pills span{padding:10px 18px;border-radius:999px;font-weight:700;font-size:${w * 0.0115}px}
.pills .a{background:#12877F;color:#fff}.pills .b{background:#FFE1D1;color:#B84A14}.pills .c{background:#FFF0C2;color:#8A6200}
.shot{position:absolute;left:${w * 0.44}px;top:${h * 0.13}px;width:${w * 0.66}px;border-radius:22px;box-shadow:0 30px 90px rgba(40,30,20,.28),0 0 0 1px rgba(0,0,0,.08)}
</style><div class=dots></div>
<div class=copy><div class=logo>${mark}<b><i>pix</i>fold</b></div><h1>Pixel art, free in your browser.</h1><p>Draw, fill and export crisp PNGs. No sign-up, nothing to install, and nothing leaves your device.</p><div class=pills><span class=a>Free</span><span class=b>No account</span><span class=c>Works offline</span></div></div>
<img class=shot src="${uri(appLight)}">`;

const heroB = (w, h) => `<!doctype html><meta charset=utf-8>${fonts}<style>
*{box-sizing:border-box;margin:0}body{width:${w}px;height:${h}px;overflow:hidden;background:#101014;font-family:'Bricolage Grotesque',system-ui;color:#F4F0EA;position:relative}
.glow{position:absolute;left:50%;top:-18%;width:${w * 0.9}px;height:${h * 0.8}px;transform:translateX(-50%);background:radial-gradient(closest-side,rgba(18,135,127,.55),transparent),radial-gradient(closest-side at 80% 60%,rgba(255,122,61,.28),transparent);filter:blur(30px)}
.top{position:absolute;top:${h * 0.07}px;left:0;right:0;text-align:center}
.logo{display:inline-flex;align-items:center;gap:14px}.logo svg{width:48px;height:48px}.logo b{font-size:34px;font-weight:800}.logo i{font:normal 700 29px Silkscreen}
h1{margin-top:${h * 0.025}px;font-size:${w * 0.036}px;font-weight:800;letter-spacing:-.025em;line-height:1.05}
h1 em{font-style:normal;color:#FFC53D}
.shot{position:absolute;left:50%;top:${h * 0.36}px;width:${w * 0.78}px;transform:translateX(-50%);border-radius:20px 20px 0 0;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 -10px 80px rgba(43,181,170,.25)}
</style><div class=glow></div>
<div class=top><div class=logo>${mark}<b><i>pix</i>fold</b></div><h1>Draw pixel art. <em>Keep it free.</em></h1></div>
<img class=shot src="${uri(appDark)}">`;

async function hero(name, html, w, h) {
  const f = join(work, name + '.html');
  writeFileSync(f, html);
  await view(w, h);
  await send('Page.navigate', { url: pathToFileURL(f).href });
  await sleep(2500);
  await shot(join(out, name + '.png'));
}
await hero('hero-1920x1080', heroA(1920, 1080), 1920, 1080);
await hero('hero-1680x1050', heroB(1680, 1050), 1680, 1050);

ws.close();
proc.kill();
console.log('Wrote', out);
