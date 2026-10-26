const { _electron: electron } = require('playwright-core'); const path=require('path'), fs=require('fs'), os=require('os');
(async()=>{ const dir=fs.mkdtempSync(path.join(os.tmpdir(),'srts-shots-'));
 const app=await electron.launch({executablePath:process.env.SRTS_EXE||require('electron'),args:process.env.SRTS_EXE?[]:[path.resolve(__dirname,'..')],env:{...process.env,SRTS_DATA_DIR:dir}});
 const page=await app.firstWindow(); await page.waitForSelector('.sheet'); await page.setViewportSize({width:1280,height:800});
 for (const t of ['staff','pto','rules','data']) { await page.click(`#tabs button[data-tab="${t}"]`); await page.waitForTimeout(200); await page.screenshot({path:path.join(__dirname,'shots','tab-'+t+'.png')}); }
 await app.close(); fs.rmSync(dir,{recursive:true,force:true}); })();
