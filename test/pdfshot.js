const { _electron: electron } = require('playwright-core'); const path=require('path'), fs=require('fs'), os=require('os');
(async()=>{ const dir=fs.mkdtempSync(path.join(os.tmpdir(),'srts-pdf-')); const pdf=path.join(__dirname,'shots','week.pdf');
 const app=await electron.launch({executablePath:process.env.SRTS_EXE,args:[],env:{...process.env,SRTS_DATA_DIR:dir,SRTS_TEST_PATHS:JSON.stringify([pdf])}});
 const page=await app.firstWindow(); await page.waitForSelector('.sheet'); await page.click('[data-act="pdf"]'); await page.waitForSelector('#toast.show');
 await app.close(); fs.rmSync(dir,{recursive:true,force:true}); console.log('pdf', fs.statSync(pdf).size); })();
