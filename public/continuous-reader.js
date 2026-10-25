export class ContinuousReader {
  constructor({stage,scroll,pdfjs,onPage,onError}){Object.assign(this,{stage,scroll,pdfjs,onPage,onError});this.records=[];this.urls=[];this.closed=false;this.current=1;this.mode='continuous';this.onScroll=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>{const page=this.at(this.scroll.scrollTop+this.scroll.clientHeight*.28);if(page){this.current=page.number;this.onPage(page.number);}});};scroll.addEventListener('scroll',this.onScroll,{passive:true});}
  at(top){if(this.mode==='single')return this.records[this.current-1];let lo=0,hi=this.records.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.records[mid].element.offsetTop<=top)lo=mid;else hi=mid-1;}return this.records[lo];}
  async open({pdf,presentation,count,getImage,zoom,mode='continuous'}){
    Object.assign(this,{pdf,presentation,getImage,zoom,mode});
    const first=pdf?await pdf.getPage(1):null,base=first?first.getViewport({scale:1}):presentation;
    if(this.closed)return;
    this.stage.replaceChildren();
    for(let number=1;number<=count;number++){
      const element=document.createElement('div');element.className='paper continuous-page';element.dataset.page=number;element.setAttribute('aria-label',`第 ${number} 页`);
      const waiting=document.createElement('span');waiting.className='page-loading';waiting.textContent=`第 ${number} 页 · 准备中…`;element.append(waiting);
      if(number===1)element.id='paper';
      element.hidden=this.mode==='single'&&number!==this.current;
      this.records.push({number,element,width:base.width,height:base.height,waiting});this.stage.append(element);
    }
    this.layout(false);await this.paint(this.records[0],first);
    void this.fill();
  }
  layout(preserve=true){
    if(!this.records.length)return;
    const anchor=this.at(this.scroll.scrollTop+1),offset=(this.scroll.scrollTop-anchor.element.offsetTop)/(anchor.element.clientHeight||1);
    const available=Math.max(240,this.scroll.clientWidth-(innerWidth<=700?30:56));
    for(const r of this.records){
      const scale=this.zoom||Math.min(2.5,available/r.width);r.scale=scale;
      r.element.style.width=r.width*scale+'px';r.element.style.height=r.height*scale+'px';
      if(r.layer)r.layer.style.transform=`scale(${scale/r.renderScale})`;
    }
    if(preserve)this.scroll.scrollTop=anchor.element.offsetTop+offset*anchor.element.clientHeight;
  }
  zoomAt(zoom,x,y){
    if(!this.records.length)return;
    const area=this.scroll.getBoundingClientRect();
    x=x>=area.left&&x<=area.right?x:area.left+area.width/2;
    y=y>=area.top&&y<=area.bottom?y:area.top+area.height/2;
    const record=this.at(this.scroll.scrollTop+y-area.top),before=record.element.getBoundingClientRect();
    const px=(x-before.left)/before.width,py=(y-before.top)/before.height;
    this.zoom=zoom;this.layout(false);
    const after=record.element.getBoundingClientRect();
    this.scroll.scrollTop+=after.top+py*after.height-y;
    this.scroll.scrollLeft+=after.left+px*after.width-x;
  }
  async setMode(mode,number=this.current){this.mode=mode;await this.navigate(number);}
  async paint(r,page){
    if(r.loaded||this.closed)return;
    if(r.promise)return r.promise;
    r.promise=(async()=>{
      const canvas=document.createElement('canvas');
      if(this.pdf){
        page||=await this.pdf.getPage(r.number);if(this.closed)return;
        const base=page.getViewport({scale:1});r.width=base.width;r.height=base.height;
        r.renderScale=Math.min(2,1400/base.width);
        const viewport=page.getViewport({scale:r.renderScale});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        r.task=page.render({canvasContext:canvas.getContext('2d'),viewport});await r.task.promise;if(this.closed)return;
        const layer=r.layer=document.createElement('div');layer.className='textLayer';if(r.number===1)layer.id='pdfText';
        r.element.style.setProperty('--scale-factor',r.renderScale);r.element.style.setProperty('--user-unit',page.userUnit||1);
        r.element.append(layer);
        r.textLayer=new this.pdfjs.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport});
        await r.textLayer.render();if(this.closed)return;
      }else{
        const source=await this.getImage(r.number);if(this.closed)return;
        canvas.width=source.naturalWidth;canvas.height=source.naturalHeight;canvas.getContext('2d').drawImage(source,0,0);
      }
      if(r.number===1){canvas.id='pdfCanvas';r.element.prepend(canvas);}
      else{
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(this.closed)return;
        if(!blob)throw new Error('页面图片生成失败');
        const url=URL.createObjectURL(blob);this.urls.push(url);
        const image=document.createElement('img');image.src=url;image.alt=`第 ${r.number} 页`;image.draggable=false;r.element.prepend(image);
        canvas.width=canvas.height=1;
      }
      r.loaded=true;r.waiting.remove();this.layout();
    })().catch(error=>{if(!this.closed){r.waiting.textContent=`第 ${r.number} 页显示失败`;this.onError(error);}});
    return r.promise;
  }
  async fill(){for(const r of this.records){if(this.closed)return;await this.paint(r);await new Promise(resolve=>setTimeout(resolve,0));}}
  async navigate(number){const r=this.records[number-1];if(!r)return;this.current=number;for(const page of this.records)page.element.hidden=this.mode==='single'&&page!==r;this.onPage(number);this.scroll.scrollTo({top:r.element.offsetTop-20,behavior:'instant'});await this.paint(r);}
  close(){this.closed=true;cancelAnimationFrame(this.frame);this.scroll.removeEventListener('scroll',this.onScroll);for(const r of this.records){r.task?.cancel();r.textLayer?.cancel();}for(const url of this.urls)URL.revokeObjectURL(url);}
}
