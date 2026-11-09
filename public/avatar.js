/* Runs on the isolated avatar origin: no desktop bridge or remote network. */
(async()=>{
  const generation=new URLSearchParams(location.search).get('generation')||'';
  const tell=data=>parent.postMessage({...data,generation},'aster://app');let app;
  try{
    if(!globalThis.Live2DCubismCore)throw new Error('Cubism Core is missing');
    app=new PIXI.Application({view:document.querySelector('canvas'),resizeTo:window,backgroundAlpha:0,antialias:true,autoDensity:true,resolution:Math.min(devicePixelRatio,1.5),powerPreference:'low-power'});app.ticker.maxFPS=30;
    const model=await PIXI.live2d.Live2DModel.from('/model.model3.json',{autoInteract:false});
    app.stage.addChild(model);model.anchor.set(.5,.5);const original={width:model.width,height:model.height};
    const fit=()=>{model.scale.set(Math.min(innerWidth/original.width,innerHeight/original.height)*.98);model.position.set(innerWidth/2,innerHeight/2);};fit();addEventListener('resize',fit);
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');let state='idle',expressionSequence=0,expressionQueue=Promise.resolve(),selectedExpression=-1,automatic=true,mood='neutral',gesture=null,lastCue='';
    const moods={neutral:{},warm:{smile:.35},happy:{smile:.65,expression:'Star eyes'},thoughtful:{tilt:3,brow:.15},concerned:{smile:-.15,brow:.35},determined:{expression:'Determined'},playful:{smile:.5,tilt:-3,expression:'Blush'}};
    const expressions=model.internalModel.settings.expressions||[];
    let mouth={active:false,level:0,at:0},mouthOwned=false;
    const lipIds=model.internalModel.settings.lipSyncIds?.length?model.internalModel.settings.lipSyncIds:['ParamMouthOpenY'];
    function expression(index){
      if(index===selectedExpression)return;selectedExpression=index;const sequence=++expressionSequence;
      expressionQueue=expressionQueue.catch(()=>{}).then(async()=>{
        if(sequence!==expressionSequence)return;
        const manager=model.internalModel.motionManager.expressionManager;
        try{if(index===-1){if(manager){manager.reserveExpressionIndex=-1;manager.currentExpression=manager.defaultExpression;manager.resetExpression();}}
          else if(!await model.expression(index))throw new Error('Expression was not applied');
          if(sequence===expressionSequence)document.body.dataset.expression=String(index);
        }catch{if(sequence===expressionSequence){selectedExpression=-2;tell({type:'expression-error'});}}
      });
    }
    addEventListener('message',async e=>{
      if(e.origin!=='aster://app'||e.source!==parent)return;
      if(e.data?.type==='mouth'&&typeof e.data.active==='boolean'&&Number.isFinite(e.data.level)&&e.data.level>=0&&e.data.level<=1){mouth={active:e.data.active,level:e.data.level,at:performance.now()};}
      if(e.data?.type==='gaze'){
        const point=e.data.point,focus=model.internalModel.focusController;
        if(point===null){focus.focus(0,0);return;}
        if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return;
        const bounds=model.getBounds(),clamp=(n,limit)=>Math.max(-limit,Math.min(limit,n));
        // Aim from her face, with gentle head limits. Cubism smooths towards the target.
        focus.focus(clamp((point.x*innerWidth-bounds.x-bounds.width*.5)/Math.max(bounds.width,bounds.height*.5),.85),clamp((bounds.y+bounds.height*.18-point.y*innerHeight)/(bounds.height*.65),.7));
      }
      if(e.data?.type==='state'&&['idle','listening','thinking','working','replying','speaking','preparing'].includes(e.data.state))state=e.data.state;
      if(e.data?.type==='performance'){
        const p=e.data;if(typeof p.automatic!=='boolean'||!Object.hasOwn(moods,p.mood)||!['none','nod','shake','tilt'].includes(p.gesture)||typeof p.id!=='string'||p.id.length>80||!Number.isFinite(p.startedAt))return;
        if(!p.automatic){if(automatic)expression(-1);automatic=false;mood='neutral';gesture=null;lastCue='';document.body.dataset.mood='manual';return;}
        automatic=true;mood=p.mood;document.body.dataset.mood=mood;
        const named=moods[mood].expression;expression(named?expressions.findIndex(e=>e.Name===named||e.name===named):-1);
        if(p.id!==lastCue){lastCue=p.id;const age=Date.now()-p.startedAt;gesture=p.gesture!=='none'&&age>=-1000&&age<1800?{kind:p.gesture,start:performance.now()-Math.max(0,age)}:null;}
      }
      if(e.data?.type==='expression'&&Number.isInteger(e.data.index)&&e.data.index>=-1&&e.data.index<(model.internalModel.settings.expressions?.length||0)){
        automatic=false;mood='neutral';gesture=null;document.body.dataset.mood='manual';expression(e.data.index);
      }
    });
    model.internalModel.on('beforeModelUpdate',()=>{
      const core=model.internalModel.coreModel,t=performance.now()/1000,pose=moods[mood];
      const speaking=mouth.active&&performance.now()-mouth.at<300;
      if(speaking||mouthOwned){const level=speaking?mouth.level:0;for(const id of lipIds)core.setParameterValueById(id,level);document.body.dataset.mouth=String(level);}
      mouthOwned=speaking;
      if(automatic){core.addParameterValueById('ParamMouthForm',pose.smile||0);for(const side of ['L','R'])core.addParameterValueById('ParamBrow'+side+'Form',pose.brow||0);}
      if(reduced.matches)return;
      core.addParameterValueById('ParamAngleZ',(pose.tilt||0)+Math.sin(t*.8)*(['thinking','working'].includes(state)?3:1));
      if(state==='listening')core.addParameterValueById('ParamAngleY',3);
      if(gesture){const progress=(performance.now()-gesture.start)/1800;if(progress>=1)gesture=null;else{const envelope=Math.sin(Math.PI*progress),wave=Math.sin(progress*Math.PI*4)*envelope;core.addParameterValueById(gesture.kind==='nod'?'ParamAngleY':gesture.kind==='shake'?'ParamAngleX':'ParamAngleZ',gesture.kind==='tilt'?envelope*8:wave*8);}}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)app.stop();else app.start();});
    document.querySelector('canvas').addEventListener('webglcontextlost',event=>{event.preventDefault();tell({type:'error'});});
    document.body.dataset.ready='true';document.body.dataset.expression='-1';
    tell({type:'ready'});
  }catch(error){console.error('Aurora avatar:',error);app?.destroy();tell({type:'error'});}
})();
