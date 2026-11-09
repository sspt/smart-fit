import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const baseline=JSON.parse(await readFile('production/expected-live.json','utf8'));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.goto(baseline.origin,{waitUntil:'domcontentloaded'});
 const html=await page.evaluate(async()=>{const r=await fetch('/',{cache:'no-store'});if(!r.ok)throw Error('Baseline fetch failed: '+r.status);return r.text()});
 if(createHash('sha256').update(html).digest('hex')!==baseline.originalHtmlSha256)throw Error('Frontend changed since baseline capture; reconcile before deploying');
 console.log('Verified live frontend baseline');
}finally{await browser.close()}
