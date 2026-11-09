import {ReminderCleanup} from './reminder-cleanup.mjs';
import {reminderOverview} from './reminder-overview.mjs';
import {ReminderPlans} from './reminder-plans.mjs';
import {WorkloadRevisits} from './workload-revisits.mjs';
import {workloadReflection} from './workload-reflection.mjs';
import {workloadRemaining} from './workload-remaining.mjs';
import {workloadStart} from './workload-start.mjs';
import {workloadNextReport,assessWorkloadNext} from './workload-next.mjs';
import {workloadFollow} from './workload-follow.mjs';
import {remainingAdjustments} from './remaining-adjustments.mjs';
import {dayHandoff} from './day-handoff.mjs';
import {shortlistReview} from './shortlist-review.mjs';
import {CapturedTasks} from './captured-tasks.mjs';
import {TaskCapture} from './task-capture.mjs';
import {TaskDetails} from './task-details.mjs';
import {EstimateFollowThrough} from './estimate-follow-through.mjs';
import {EstimateReviews} from './estimate-reviews.mjs';
import {SessionReviews} from './session-reviews.mjs';
import {FocusSessions} from './focus-sessions.mjs';
import {continueDay} from './continue-day.mjs';
import {FirstSteps} from './first-steps.mjs';
import {PlanFollowThrough} from './plan-follow-through.mjs';
import {MorningReflections} from './morning-reflections.mjs';
import {DailySummaries} from './daily-summaries.mjs';
import {DailyCheckins} from './daily-checkins.mjs';
import {TaskWorkflows} from './task-workflows.mjs';
import {GoogleCalendar} from './google-calendar.mjs';
import {TaskProjects} from './task-projects.mjs';
import {RecurringTasks} from './recurring-tasks.mjs';
import {WeeklyReview} from './weekly-review.mjs';
import {TaskHistory} from './task-history.mjs';
import {DailyFocus} from './daily-focus.mjs';
import {DayPlanning} from './day-planning.mjs';
import {weeklyPlanner} from './weekly-planner.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import { Vault, AppError, resolveLink, retrieve, markdown, slug } from './vault.mjs';
import { Store } from './store.mjs';
import { Ollama } from './ollama.mjs';
import {ProjectWorkspaces} from './project-workspaces.mjs';
import { Projects } from './projects.mjs';
import { Assistant } from './assistant.mjs';
import { Memory } from './memory.mjs';
import { linuxTheme } from './theme.mjs';
import { Settings } from './settings.mjs';
import { SystemAccess } from './system.mjs';
import {Computer} from './computer.mjs';
import {DesktopOutcomePicker} from './desktop-outcome-picker.mjs';
import { Cloud } from './cloud.mjs';
import { ChatGPTPlan } from './chatgpt-plan.mjs';
import { ChatGPTChat } from './chatgpt-chat.mjs';
import { Actions } from './actions.mjs';
import { Character, characterPresets } from './character.mjs';
import { Reminders } from './reminders.mjs';
import { MemoryReview } from './memory-review.mjs';
import { overview } from './overview.mjs';
import { Backups } from './backups.mjs';
import { health } from './health.mjs';
import { LocalModels } from './models.mjs';
import { Skills } from './skills.mjs';
import { Agents, agentRoles } from './agents.mjs';
import { ScreenGuide } from './screen-guide.mjs';
import {Embodiment} from './embodiment.mjs';
import {Workflows} from './workflows.mjs';
import {Recovery} from './recovery.mjs';
import {MobileTransfers} from './mobile-transfers.mjs';

const packageVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
async function body(req,limit=650000){
  if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError('Use JSON for this request.',415);
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw new AppError('Request is too large.',413);chunks.push(part);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Invalid JSON.');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new AppError('Send a JSON object.');return data;
}
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
export async function createApp(overrides={}){
  const cfg={...config,...overrides};
  const vault=new Vault(cfg.vault),store=new Store(cfg.data),ollama=overrides.ollamaClient||new Ollama(cfg.ollama,cfg.model,overrides.fetchImpl),projects=new Projects(cfg.projects);
  await vault.init();await store.init();
  const memory=new Memory({vault,ollama,data:cfg.data,model:cfg.embedding});
  const settings=new Settings(cfg.data);await settings.init();
  const system=new SystemAccess({data:cfg.data,...overrides.systemOptions});
  const cloud=new Cloud(settings,overrides.cloudFetch||fetch);
  const chatgpt=new ChatGPTPlan({data:cfg.data,fetchImpl:overrides.chatgptFetch||fetch});await chatgpt.init();
  const chatgptChat=new ChatGPTChat(chatgpt,{fetchImpl:overrides.chatgptFetch||fetch});
  const computer=new Computer(settings,overrides.computerOptions);
  const outcomePicker=new DesktopOutcomePicker(computer);
  const actions=new Actions({store,settings,system,cloud,computer,execute:overrides.executeCommand});await actions.init();
  const character=new Character(vault);await character.init();
  const embodiment=new Embodiment();
  const assistant=new Assistant({vault,store,ollama,chatgpt:chatgptChat,projects,memory,actions,system,settings,character,embodiment});
  const models=new LocalModels({data:cfg.data,ollama});await models.init();
  const skills=new Skills({vault,data:cfg.data});await skills.init();assistant.skills=skills;
  const agents=new Agents({assistant,skills,store});await agents.init();assistant.agents=agents;
  const projectWorkspaces=new ProjectWorkspaces({store,vault,system});
  const workflows=new Workflows({assistant,skills,store,actions,projectWorkspaces,...overrides.workflowOptions});await workflows.init();assistant.workflows=workflows;
  const screenGuide=new ScreenGuide(assistant);
  const reminders=new Reminders({vault,data:cfg.data,settings});
  const memoryReview=new MemoryReview({vault,data:cfg.data,assistant});assistant.memoryReview=memoryReview;
  const backups=new Backups({vault:cfg.vault,data:cfg.data,destination:cfg.backups});
  const recovery=new Recovery({vault:cfg.vault,data:cfg.data,profile:cfg.desktopProfile,destination:cfg.backups});
  const mobileTransfers=new MobileTransfers({vault,data:cfg.data});await mobileTransfers.init();
  const calendar=new GoogleCalendar({data:cfg.data,vault,...overrides.calendarOptions});await calendar.init();calendar.start();assistant.calendar=calendar;assistant.taskProposals.calendar=calendar;
  const taskWorkflows=new TaskWorkflows({vault,store,workflows});
  const dayPlanning=new DayPlanning({vault,store,calendar,taskWorkflows}),taskProjects=new TaskProjects({vault});
  const taskHistory=new TaskHistory({vault,data:cfg.data});vault.taskHistory=taskHistory;
  try{await taskHistory.init();}catch(e){console.error('Task history unavailable:',e.message);}
  const weeklyReview=new WeeklyReview({vault,history:taskHistory,taskWorkflows,calendar});dayPlanning.weeklyReview=weeklyReview;
  dayPlanning.dailyFocus=new DailyFocus({vault,history:taskHistory,taskWorkflows,data:cfg.data,now:()=>dayPlanning.now()});
  dayPlanning.firstSteps=new FirstSteps({planner:dayPlanning,data:cfg.data});
  dayPlanning.focusSessions=new FocusSessions({planner:dayPlanning,data:cfg.data});
  dayPlanning.followThrough=new PlanFollowThrough({planner:dayPlanning});
  dayPlanning.workloadRevisits=new WorkloadRevisits({planner:dayPlanning,data:cfg.data});dayPlanning.reminderPlans=new ReminderPlans({planner:dayPlanning});dayPlanning.reminderCleanup=new ReminderCleanup({planner:dayPlanning});
  dayPlanning.checkins=new DailyCheckins({planner:dayPlanning,data:cfg.data});
  dayPlanning.estimateReviews=new EstimateReviews({planner:dayPlanning});
  dayPlanning.estimateFollowThrough=new EstimateFollowThrough({planner:dayPlanning});
  dayPlanning.taskDetails=new TaskDetails({planner:dayPlanning});
  dayPlanning.sessionReviews=Object.fromEntries(['day','week'].map(period=>[period,new SessionReviews({planner:dayPlanning,period})]));
  dayPlanning.summaries=new DailySummaries({planner:dayPlanning});dayPlanning.reflections=new MorningReflections({planner:dayPlanning});weeklyReview.dayPlanning=dayPlanning;
  const recurring=new RecurringTasks({vault});await recurring.start();dayPlanning.recurring=recurring;weeklyReview.recurring=recurring;
  const taskCapture=new TaskCapture({store,reviews:assistant.taskProposals});
  dayPlanning.capturedTasks=new CapturedTasks({vault,store,capture:taskCapture,planner:dayPlanning,now:()=>dayPlanning.now()});
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const expectedPort=String(server.address()?.port);
      const allowedHosts=[`127.0.0.1:${expectedPort}`,`localhost:${expectedPort}`];
      if(!allowedHosts.includes(req.headers.host))throw new AppError('This app is available only through its local address.',403);
      if(req.headers['sec-fetch-site']==='cross-site')throw new AppError('Cross-site requests are blocked.',403);
      if(req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin))throw new AppError('Cross-origin requests are blocked.',403);
      const url=new URL(req.url,'http://127.0.0.1');const p=url.pathname;
      if(!['GET','POST'].includes(req.method))throw new AppError('Method not allowed.',405);
      if(req.method==='POST'){
        const supplied=Buffer.from(String(req.headers['x-aster-token']||''));const actual=Buffer.from(token);
        if(supplied.length!==actual.length||!timingSafeEqual(supplied,actual))throw new AppError('Reload Aurora before saving changes.',403);
      }
      if(req.method==='GET'){
        if(['/task-list-core.js','/planner.js','/planner-core.js','/tasks.js','/timetable.js','/calendar-options.js','/task-links.js'].includes(p)){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(await readFile(new URL('../mobile/web'+p,import.meta.url)));}
        if(p==='/api/calendar')return json(res,await calendar.status());
        if(p==='/api/calendar/summary')return json(res,await calendar.summary());
        if(p==='/api/calendar/day')return json(res,await calendar.day(url.searchParams.get('date')));
        if(p==='/api/mobile-transfers')return json(res,await mobileTransfers.list());
        if(p==='/api/mobile-transfer')return json(res,await mobileTransfers.review(url.searchParams.get('id')));
        if(p==='/mobile-transfers.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(await readFile(publicRoot+'mobile-transfers.js'));}
        if(p==='/theme.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end((await linuxTheme()).css);}
        if(p==='/api/theme'){const {name,revision}=await linuxTheme();return json(res,{name,revision});}
        if(p==='/api/bootstrap')return json(res,{token,vault:cfg.vault,model:ollama.model||cfg.model,embedding:cfg.embedding,projects:cfg.projects.map(p=>({name:p.name})),version:packageVersion});
        if(p==='/api/local-model')return json(res,await models.status());
        if(p==='/api/chatgpt')return json(res,chatgpt.status());
        if(p==='/api/chatgpt/models')return json(res,await chatgpt.models());
        if(p==='/api/project-workspaces')return json(res,await projectWorkspaces.list());
        if(p==='/api/project-workspace')return json(res,await projectWorkspaces.dashboard(url.searchParams.get('id'),workflows.handoffs));
        if(p==='/api/workflow-followup-options')return json(res,await workflows.followups.choices(url.searchParams.get('id')));
        if(p==='/api/workflow-followups')return json(res,await workflows.followups.list(url.searchParams.get('sourceId')));
        if(p==='/api/workflow-followup')return json(res,await workflows.followups.read(url.searchParams.get('id')));
        if(p==='/api/workflow-handoffs')return json(res,await workflows.handoffs.list());
        if(p==='/api/workflow-handoff')return json(res,await workflows.handoffs.read(url.searchParams.get('id')));
        if(p==='/api/skills')return json(res,await skills.list());
        if(p==='/api/skill')return json(res,await skills.read(url.searchParams.get('id')));
        if(p==='/api/agents')return json(res,{roles:agentRoles,runs:await agents.list()});
        if(p==='/api/workflows')return json(res,await workflows.list());
        if(p==='/api/workflow-changes')return json(res,await workflows.changes(url.searchParams.get('id')));
        if(p==='/api/workflow')return json(res,await workflows.read(url.searchParams.get('id')));
        if(p==='/api/agent-run')return json(res,await store.get('runs',url.searchParams.get('id')));
        if(p==='/api/character')return json(res,{...await character.read(),presets:characterPresets});
        if(p==='/api/health')return json(res,await health({cfg,vault,character,ollama,memory,settings,actions,backups,reminders,computer}));
        if(p==='/api/backups')return json(res,await backups.list());
        if(p==='/api/settings')return json(res,settings.public());
        if(p==='/api/computer')return json(res,computer.status());
        if(p==='/api/embodiment')return json(res,embodiment.snapshot());
        if(p==='/api/actions')return json(res,(await store.list('actions')).slice(0,100));
        if(p==='/api/action')return json(res,await store.get('actions',url.searchParams.get('id')));
        if(p==='/api/status')return json(res,{...await ollama.status(),recall:memory.mode,recallError:memory.error});
        if(p==='/api/notes'){const q=(url.searchParams.get('q')||'').toLowerCase();return json(res,(await vault.list()).filter(n=>`${n.path} ${n.content}`.toLowerCase().includes(q)).map(({content,body,...n})=>({...n,preview:body.slice(0,200)})));}
        if(p==='/api/note')return json(res,await vault.read(url.searchParams.get('path')));
        if(p==='/api/search')return json(res,retrieve(await vault.list(),url.searchParams.get('q')||'',12,20000));
        if(p==='/api/week')return json(res,await weeklyPlanner(vault,{date:url.searchParams.get('date')??undefined,timezone:url.searchParams.get('timezone')??undefined,calendar:await calendar.context()}));
        if(p==='/api/overview')return json(res,await overview({vault,settings}));
        if(p==='/api/memory-corrections')return json(res,await assistant.memoryCorrections.list());
        if(p==='/api/memory-review')return json(res,await memoryReview.scan());
        if(p==='/api/recurring')return json(res,await recurring.report());
        if(p==='/api/weekly-review')return json(res,await weeklyReview.report(url.searchParams.get('date')||undefined));
        if(p==='/api/task-history')return json(res,await taskHistory.report());
        if(p==='/api/task-projects')return json(res,await taskProjects.report());
        if(p==='/api/task-workflows')return json(res,await taskWorkflows.summary());
        if(p==='/api/task-workflow')return json(res,await taskWorkflows.read(url.searchParams.get('id')));
        if(p==='/api/task-workflow-attention')return json(res,await taskWorkflows.attention(url.searchParams.get('id')));
        if(p==='/api/task-workflow-attempts')return json(res,await taskWorkflows.candidates(url.searchParams.get('id')));
        if(p==='/api/captured-tasks')return json(res,await dayPlanning.capturedTasks.report({query:url.searchParams.get('query')||'',project:url.searchParams.get('project')||'all'}));
        if(p==='/api/task-capture')return json(res,await taskCapture.get());
        if(p==='/api/tasks')return json(res,await vault.tasks());
        if(p==='/api/project-file')return json(res,await projects.read(url.searchParams.get('project'),url.searchParams.get('path')));
        if(p==='/api/history')return json(res,await vault.history(url.searchParams.get('path')));
        if(p==='/api/version')return json(res,{content:await vault.version(url.searchParams.get('path'),url.searchParams.get('id'))});
        if(p==='/api/conversations')return json(res,(await store.list('conversations')).map(({messages,...c})=>({...c,count:messages.length})));
        if(p==='/api/conversation')return json(res,await store.get('conversations',url.searchParams.get('id')));
        if(p==='/api/plan-follow-through')return json(res,await dayPlanning.followThrough.report(url.searchParams.get('proposalId')||undefined));
        if(p==='/api/outcome-plan')return json(res,await dayPlanning.outcomePlan(url.searchParams.get('date')||undefined));
        if(p==='/api/week-capacity')return json(res,await dayPlanning.weekCapacity(url.searchParams.get('date')||undefined));
        if(p==='/api/next-day')return json(res,await dayPlanning.nextDay(url.searchParams.get('date')||undefined));
        if(p==='/api/reminder-cleanup/history')return json(res,await dayPlanning.reminderCleanup.history({offset:Number(url.searchParams.get('offset')||0),date:url.searchParams.has('date')?url.searchParams.get('date'):undefined}));
        if(p==='/api/reminder-cleanup')return json(res,url.searchParams.has('id')?await dayPlanning.reminderCleanup.view(url.searchParams.get('id')):await dayPlanning.reminderCleanup.report({offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/reminder-overview')return json(res,await reminderOverview(dayPlanning,{group:url.searchParams.get('group')||undefined,offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/reminder-plan')return json(res,await dayPlanning.reminderPlans.report({reminderId:url.searchParams.get('reminderId')||undefined,decisionId:url.searchParams.get('decisionId')||undefined}));
        if(p==='/api/workload-revisits')return json(res,await dayPlanning.workloadRevisits.report({status:url.searchParams.get('status')||undefined,offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/workload-reflection')return json(res,await workloadReflection(dayPlanning,{period:url.searchParams.get('period')||undefined,date:url.searchParams.get('date')||undefined,offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/workload-remaining')return json(res,await workloadRemaining(dayPlanning,{proposalId:url.searchParams.get('proposalId'),date:url.searchParams.get('date')||undefined,taskId:url.searchParams.get('taskId')||undefined,offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/workload-start')return json(res,await workloadStart(dayPlanning,{date:url.searchParams.get('date')||undefined,proposalId:url.searchParams.get('proposalId')||undefined,offset:Number(url.searchParams.get('offset')||0)}));
        if(p==='/api/workload-next')return json(res,await workloadNextReport(dayPlanning,{proposalId:url.searchParams.get('proposalId'),date:url.searchParams.get('date')||undefined}));
        if(p==='/api/workload-follow')return json(res,await workloadFollow(dayPlanning,{proposalId:url.searchParams.get('proposalId')||undefined,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0}));
        if(p==='/api/remaining-adjustments')return json(res,await remainingAdjustments(dayPlanning,{date:url.searchParams.get('date')||undefined,proposalId:url.searchParams.get('proposalId')||undefined,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0}));
        if(p==='/api/day-handoff')return json(res,await dayHandoff(dayPlanning,url.searchParams.get('date')||undefined));
        if(p==='/api/evening')return json(res,await dayPlanning.evening(url.searchParams.get('date')||undefined));
        if(p==='/api/daily-focus/review')return json(res,await dayPlanning.dailyFocus.review(url.searchParams.get('date')||undefined));
        if(p==='/api/saved-day-plans')return json(res,await dayPlanning.savedPlans(url.searchParams.get('date')||undefined));
        if(p==='/api/step-outcome')return json(res,await dayPlanning.firstSteps.outcomes.report(url.searchParams.get('taskId'),url.searchParams.has('sequence')?Number(url.searchParams.get('sequence')):undefined));
        if(p==='/api/focus-sessions')return json(res,await dayPlanning.focusSessions.overview());
        if(p==='/api/focus-session')return json(res,await dayPlanning.focusSessions.report({id:url.searchParams.get('id')||undefined,taskId:url.searchParams.get('taskId')||undefined}));
        if(p==='/api/first-step')return json(res,await dayPlanning.firstSteps.report(url.searchParams.get('taskId')));
        if(p==='/api/morning-reflection')return json(res,await dayPlanning.reflections.report(url.searchParams.get('date')||undefined));
        if(p==='/api/task-detail')return json(res,await dayPlanning.taskDetails.report(url.searchParams.get('taskId'),url.searchParams.has('handoffDate')||url.searchParams.has('handoffProposalId')?{date:url.searchParams.get('handoffDate'),proposalId:url.searchParams.get('handoffProposalId')}:null));
        if(p==='/api/estimate-follow-through')return json(res,await dayPlanning.estimateFollowThrough.report({...(url.searchParams.has('reviewId')?{reviewId:url.searchParams.get('reviewId')}:{}),...(url.searchParams.has('start')||url.searchParams.has('end')?{start:url.searchParams.get('start'),end:url.searchParams.get('end')}: {})}));
        if(p==='/api/estimate-reviews')return json(res,await dayPlanning.estimateReviews.overview());
        if(p==='/api/estimate-review')return json(res,await dayPlanning.estimateReviews.report(url.searchParams.get('taskId')));
        if(p==='/api/estimate-review/review')return json(res,await dayPlanning.estimateReviews.get(url.searchParams.get('id')));
        for(const period of ['day','week']){const base='/api/session-summary/'+period;if(p===base)return json(res,await dayPlanning.sessionReviews[period].report(url.searchParams.get('date')||undefined));if(p===base+'/review')return json(res,await dayPlanning.sessionReviews[period].get(url.searchParams.get('id')));}
        if(p==='/api/daily-summary')return json(res,await dayPlanning.summaries.report(url.searchParams.get('date')||undefined));
        if(p==='/api/daily-summary/review')return json(res,await dayPlanning.summaries.get(url.searchParams.get('id')));
        if(p==='/api/check-ins')return json(res,await dayPlanning.checkins.report());
        if(p==='/api/daily-focus')return json(res,await dayPlanning.dailyFocus.report(url.searchParams.get('taskId')));
        if(p==='/api/continue-day')return json(res,await continueDay(dayPlanning));
        if(p==='/api/briefing')return json(res,await dayPlanning.briefing());
        if(p==='/api/replan')return json(res,await dayPlanning.candidates());
        if(p==='/api/proposals')return json(res,(await store.list('proposals')).filter(p=>p.status==='pending').map(p=>['day_replan','evening_review','weekly_review','focus_schedule','future_schedule'].includes(p.kind)?dayPlanning.public(p):assistant.taskProposals.public(p)));
        if(p==='/api/graph'){
          const notes=(await vault.list()).filter(n=>!['journal','archived'].includes(n.status)&&!n.path.startsWith('99 Archive/'));
          return json(res,{nodes:notes.map(n=>({id:n.path,title:n.title,folder:n.path.split('/')[0],pinned:n.pinned})),edges:notes.flatMap(n=>n.links.flatMap(l=>{const target=resolveLink(l,notes,n.path);return target?[{source:n.path,target}]:[];}))});
        }
        const file={'/':'index.html','/app.js':'app.js','/speech.js':'speech.js','/agents.js':'agents.js','/workflows.js':'workflows.js','/source-claims.js':'source-claims.js','/workflow-review.js':'workflow-review.js','/workflow-completion.js':'workflow-completion.js','/workflow-followups.js':'workflow-followups.js','/repair-expressions.js':'repair-expressions.js','/example-review.js':'example-review.js','/test-copy.js':'test-copy.js','/task-skills.js':'task-skills.js','/workflow-requirements.js':'workflow-requirements.js','/desktop-outcome-picker.js':'desktop-outcome-picker.js','/workflow-handoffs.js':'workflow-handoffs.js','/project-workspaces.js':'project-workspaces.js','/models.js':'models.js','/markdown.js':'markdown.js','/style.css':'style.css','/icon.svg':'icon.svg','/integrations.js':'integrations.js','/quick.html':'quick.html','/quick.js':'quick.js','/quick.css':'quick.css','/browser.html':'browser.html','/browser.js':'browser.js','/browser.css':'browser.css','/companion.html':'companion.html','/companion-window.js':'companion-window.js','/companion.js':'companion.js','/companion.css':'companion.css','/screen-help.js':'screen-help.js','/character.js':'character.js','/health.js':'health.js','/planner-editor-drafts.js':'planner-editor-drafts.js','/remaining-adjustments.js':'remaining-adjustments.js','/remaining-day.js':'remaining-day.js','/day-start.js':'day-start.js','/handoff-action.js':'handoff-action.js','/day-handoff.js':'day-handoff.js','/shortlist-workspace.js':'shortlist-workspace.js','/reading-position.js':'reading-position.js','/shortlist-follow.js':'shortlist-follow.js','/capture-shortlist.js':'capture-shortlist.js','/captured-tasks.js':'captured-tasks.js','/task-capture.js':'task-capture.js','/task-list.js':'task-list.js','/task-details.js':'task-details.js','/planning-draft-guard.js':'planning-draft-guard.js','/estimate-follow-through.js':'estimate-follow-through.js','/estimate-adjustment.js':'estimate-adjustment.js','/estimate-review.js':'estimate-review.js','/session-review.js':'session-review.js','/session-summary.js':'session-summary.js','/focus-sessions.js':'focus-sessions.js','/continue-day.js':'continue-day.js','/day-planning.js':'day-planning.js','/daily-checkin.js':'daily-checkin.js','/checkin-review.js':'checkin-review.js','/daily-summary.js':'daily-summary.js','/morning-reflection.js':'morning-reflection.js','/first-steps.js':'first-steps.js','/step-outcomes.js':'step-outcomes.js','/outcome-planning.js':'outcome-planning.js','/plan-follow-through.js':'plan-follow-through.js','/evening-review.js':'evening-review.js','/weekly-review.js':'weekly-review.js','/daily-focus.js':'daily-focus.js','/planning-selection.js':'planning-selection.js','/next-day.js':'next-day.js','/week-capacity.js':'week-capacity.js','/recovery-groups.js':'recovery-groups.js','/review-return.js':'review-return.js','/cleanup-recovery.js':'cleanup-recovery.js','/reminder-cleanup.js':'reminder-cleanup.js','/reminder-overview.js':'reminder-overview.js','/reminder-plans.js':'reminder-plans.js','/workload-revisits.js':'workload-revisits.js','/workload-reflection.js':'workload-reflection.js','/workload-remaining.js':'workload-remaining.js','/workload-start.js':'workload-start.js','/workload-next.js':'workload-next.js','/workload-next-draft.js':'workload-next-draft.js','/workload-follow.js':'workload-follow.js','/week-workload.js':'week-workload.js','/week-workload-draft.js':'week-workload-draft.js','/saved-day-plans.js':'saved-day-plans.js','/remainder-planning.js':'remainder-planning.js','/focus-review.js':'focus-review.js','/task-proposal-review.js':'task-proposal-review.js','/google-calendar.js':'google-calendar.js','/task-workflows.js':'task-workflows.js','/task-attention.js':'task-attention.js','/planning.js':'planning.js','/task-projects.js':'task-projects.js','/planning-settings.js':'planning-settings.js','/weekly-planner.js':'weekly-planner.js','/memory-review.js':'memory-review.js'}[p];
        if(!file)throw new AppError('Not found.',404);
        res.writeHead(200,{'Content-Type':types[file.slice(file.lastIndexOf('.'))]});return res.end(await readFile(publicRoot+file));
      }
      const data=await body(req,p==='/api/mobile-transfer-preview'?10*1024*1024:['/api/screen-guide','/api/computer/complete'].includes(p)?1600000:650000);
      if(p==='/api/mobile-transfer-export')return json(res,await mobileTransfers.export(data.paths));
      if(p==='/api/mobile-transfer-preview')return json(res,await mobileTransfers.prepare(data.raw));
      if(p==='/api/mobile-transfer-decide')return json(res,await mobileTransfers.decide(data));
      if(p==='/api/embodiment/poll')return json(res,embodiment.poll(data));
      if(p==='/api/computer/connect')return json(res,computer.connect());
      if(p==='/api/computer/poll')return json(res,computer.poll(data.lease));
      if(p==='/api/computer/complete')return json(res,computer.complete(data.lease,data.id,data.result,data.error));
      if(p==='/api/computer/action'){const controller=new AbortController();res.on('close',()=>controller.abort());return json(res,await actions.computerAction(data.input||{},data.conversation,controller.signal));}
      if(['/api/chatgpt/connect','/api/chatgpt/select','/api/chatgpt/switch','/api/chatgpt/sign-out'].includes(p)&&assistant.busy.size)throw new AppError('Finish or stop the active response before changing ChatGPT accounts or models.',409);
      if(p==='/api/chatgpt/connect')return json(res,await chatgpt.connect(data.clientId));
      if(p==='/api/chatgpt/select')return json(res,await chatgpt.select(data.model));
      if(p==='/api/chatgpt/switch')return json(res,await chatgpt.switchAccount(data.clientId));
      if(p==='/api/chatgpt/sign-out')return json(res,await chatgpt.signOut());
      if(p==='/api/local-model'){if(assistant.busy.size)throw new AppError('Stop or finish the active response before changing models.',409);assistant.busy.add('model-change');try{return json(res,await models.save(data));}finally{assistant.busy.delete('model-change');}}
      if(p==='/api/skill')return json(res,await skills.save(data));
      if(p==='/api/agent-start')return json(res,await agents.start(data),202);
      if(p==='/api/project-workspace')return json(res,await projectWorkspaces.save(data));
        if(p==='/api/workflow-start')return json(res,await workflows.start(data),202);
      if(p==='/api/workflow-control')return json(res,await workflows.control(data.id,data.operation,data.observation,data.revision));
      if(['/api/workflow-outcome-preview','/api/workflow-outcome-select'].includes(p)){const controller=new AbortController();res.on('close',()=>controller.abort());return json(res,await outcomePicker[p.endsWith('preview')?'preview':'select'](data,controller.signal));}
      if(p==='/api/workflow-requirements-draft'){const controller=new AbortController();res.on('close',()=>controller.abort());return json(res,await workflows.suggestRequirements(data,controller.signal));}
      if(p==='/api/workflow-requirements')return json(res,await workflows.updateRequirements(data.id,data));
      if(p==='/api/workflow-steer')return json(res,await workflows.steer(data.id,data.instruction,data.revision));
      if(p==='/api/workflow-followup-preview')return json(res,await workflows.followups.preview(data));
      if(p==='/api/workflow-followup-save')return json(res,await workflows.followups.save(data));
      if(p==='/api/workflow-followup-discard')return json(res,await workflows.followups.discard(data));
      if(p==='/api/workflow-followup-start')return json(res,await workflows.followups.start(data),202);
      if(p==='/api/workflow-handoff')return json(res,data.handoffId?await workflows.handoffs.save(data):await workflows.handoffs.draft(data.sourceId));
      if(p==='/api/workflow-example-review')return json(res,await workflows.exampleReview(data.id,data));
      if(p==='/api/workflow-memory')return json(res,await workflows.memory(data.id,data));
      if(p==='/api/workflow-skill')return json(res,await workflows.skillDraft(data.id,data));
      if(p==='/api/workflow-help')return json(res,await workflows.help(data.id,data));
      if(p==='/api/workflow-model')return json(res,await workflows.migrate(data.id,data));
      if(p==='/api/agent-stop')return json(res,agents.stop(data.id));
      if(p==='/api/subtask')return json(res,await taskProjects.subtask(data));
      if(p==='/api/task-schedule'){await calendar.guardSchedule(data);return json(res,await vault.scheduleTask(data));}
      if(p==='/api/reminders/poll')return json(res,await reminders.claim());
      if(p==='/api/reminders/ack')return json(res,await reminders.acknowledge(data.id));
      if(p==='/api/memory-corrections')return json(res,await assistant.memoryCorrections.propose(data));
      if(p==='/api/memory-review/keep')return json(res,await memoryReview.markReviewed(data.id));
      if(p==='/api/memory-review/analyze'){
        const controller=new AbortController();res.on('close',()=>controller.abort());const timer=setTimeout(()=>controller.abort(),120000);
        try{return json(res,await memoryReview.analyze(data.paths,controller.signal));}finally{clearTimeout(timer);}
      }
      if(p==='/api/backup')return json(res,await backups.create());
      if(p==='/api/recovery-bundle')return json(res,await recovery.create());
      if(p==='/api/character')return json(res,await character.save(data.content,data.revision));
      if(p==='/api/screen-guide'){
        const controller=new AbortController();res.on('close',()=>controller.abort());const timer=setTimeout(()=>controller.abort(),120000);
        try{return json(res,await screenGuide.answer(data,controller.signal));}finally{clearTimeout(timer);}
      }
      if(p==='/api/calendar/configure')return json(res,await calendar.configure(data.client));
      if(p==='/api/calendar/connect')return json(res,await calendar.connect());
      if(p==='/api/calendar/disconnect')return json(res,await calendar.disconnect());
      if(p==='/api/calendar/refresh')return json(res,await calendar.refresh());
      if(p==='/api/calendar/select')return json(res,await calendar.select(data));
      if(p==='/api/calendar/preview')return json(res,await calendar.preview(data));
      if(p==='/api/calendar/apply')return json(res,await calendar.apply(data));
      if(p==='/api/calendar/discard')return json(res,await calendar.discard(data.id,data.acknowledgeUncertain===true));
      if(p==='/api/calendar/unlink')return json(res,await calendar.unlink(data.taskId));
      if(p==='/api/calendar/day')return json(res,await calendar.day(data.date,{fresh:true}));
      if(p==='/api/settings'){const saved=await settings.save(data);if(!saved.systemEnabled||!saved.computerEnabled)computer.stop();if(!saved.systemEnabled||!saved.computerEnabled)for(const [id,controller] of actions.running){const action=await store.get('actions',id);if(!saved.systemEnabled&&action.kind!=='cloud'||!saved.computerEnabled&&action.kind==='computer')controller.abort();}return json(res,saved);}
      if(p==='/api/action-propose')return json(res,await actions.propose(data.kind,data.input||{},data.conversation));
      if(p==='/api/action-decide')return json(res,await actions.decide(data.id,data.decision,data.digest));
      if(p==='/api/action-stop')return json(res,actions.stop(data.id));
      if(p==='/api/conversations')return json(res,await store.conversation());
      if(p==='/api/note')return json(res,await vault.save(data.path,data.content,data.revision));
      if(p==='/api/trash')return json(res,await vault.trash(data.path,data.revision));
      if(p==='/api/restore')return json(res,await vault.save(data.path,await vault.version(data.path,data.id),data.revision));
      if(p==='/api/daily')return json(res,await vault.daily());
      if(p==='/api/task-capture')return json(res,await taskCapture.act(data));
      if(p==='/api/tasks')return json(res,await vault.addTask(data.text,data));
      if(p==='/api/task-workflow-draft')return json(res,await taskWorkflows.draft(data));
      if(p==='/api/task-workflow-save')return json(res,await taskWorkflows.save(data));
      if(p==='/api/task-workflow-start')return json(res,await taskWorkflows.start(data),202);
      if(p==='/api/task-workflow-unlink')return json(res,await taskWorkflows.unlink(data));
      if(p==='/api/task-workflow-review')return json(res,await taskWorkflows.preview(data));
      if(p==='/api/task-workflow-decide')return json(res,await taskWorkflows.decide(data));
      if(p==='/api/task-workflow-attachment')return json(res,await taskWorkflows.previewAttachment(data));
      if(p==='/api/task-workflow-attach-decide')return json(res,await taskWorkflows.decideAttachment(data));
      if(p==='/api/task-toggle')return json(res,await vault.toggleTask(data.path,data.line,data.revision,data.done));
      if(p==='/api/recurring')return json(res,await recurring.change(data));
      if(p==='/api/weekly-review/preview')return json(res,await dayPlanning.weeklyPreview(data));
      if(p==='/api/shortlist-review')return json(res,await shortlistReview(dayPlanning,data));
      if(p==='/api/captured-tasks/review')return json(res,await dayPlanning.capturedTasks.review(data));
      if(p==='/api/week-workload/assess')return json(res,await dayPlanning.assessWeekWorkload(data));
      if(p==='/api/workload-next/assess')return json(res,await assessWorkloadNext(dayPlanning,data));
      if(p==='/api/week-capacity/assess')return json(res,await dayPlanning.assessWeekCapacity(data));
      if(p==='/api/next-day/preview')return json(res,await dayPlanning.nextDayPreview(data));
      if(p==='/api/evening/preview')return json(res,await dayPlanning.eveningPreview(data));
      if(p==='/api/daily-focus/preview')return json(res,await dayPlanning.focusPreview(data));
      if(p==='/api/daily-focus/execution')return json(res,await dayPlanning.dailyFocus.openExecution(data));
      if(p==='/api/daily-focus/review/decide')return json(res,await dayPlanning.dailyFocus.reviewDecision(data));
      if(p==='/api/step-outcome/save')return json(res,await dayPlanning.firstSteps.outcomes.record(data));
      if(p==='/api/step-outcome/status')return json(res,await dayPlanning.firstSteps.outcomes.status(data));
      if(p==='/api/focus-session/change')return json(res,await dayPlanning.focusSessions.change(data));
      if(p==='/api/focus-session/status')return json(res,await dayPlanning.focusSessions.status(data));
      if(p==='/api/first-step/save')return json(res,await dayPlanning.firstSteps.save(data));
      if(p==='/api/first-step/status')return json(res,await dayPlanning.firstSteps.status(data));
      if(p==='/api/first-step/execution')return json(res,await dayPlanning.firstSteps.execution(data));
      if(p==='/api/plan-follow-through/choose')return json(res,await dayPlanning.followThrough.choose(data));
      if(p==='/api/plan-follow-through/status')return json(res,await dayPlanning.followThrough.status(data));
      if(p==='/api/reminder-cleanup/review')return json(res,await dayPlanning.reminderCleanup.review(data));
      if(p==='/api/reminder-cleanup/accept')return json(res,await dayPlanning.reminderCleanup.accept(data));
      if(p==='/api/reminder-plan/review')return json(res,await dayPlanning.reminderPlans.review(data));
      if(p==='/api/reminder-plan/assess')return json(res,await dayPlanning.reminderPlans.assess(data));
      if(p==='/api/workload-revisits/save')return json(res,await dayPlanning.workloadRevisits.save(data));
      if(p==='/api/workload-revisits/dismiss')return json(res,await dayPlanning.workloadRevisits.dismiss(data));
      if(p==='/api/morning-reflection/status')return json(res,await dayPlanning.reflections.status(data));
      if(p==='/api/morning-reflection/choose')return json(res,await dayPlanning.reflections.choose(data));
      if(p==='/api/estimate-review/refresh')return json(res,await dayPlanning.estimateReviews.refresh(data.taskId));
      if(p==='/api/estimate-review/preview')return json(res,await dayPlanning.estimateReviews.preview(data));
      if(p==='/api/estimate-review/decide')return json(res,await dayPlanning.estimateReviews.decide(data));
      for(const period of ['day','week']){const base='/api/session-summary/'+period;if(p===base+'/preview')return json(res,await dayPlanning.sessionReviews[period].preview(data));if(p===base+'/decide')return json(res,await dayPlanning.sessionReviews[period].decide(data));}
      if(p==='/api/daily-summary/preview')return json(res,await dayPlanning.summaries.preview(data));
      if(p==='/api/daily-summary/decide')return json(res,await dayPlanning.summaries.decide(data));
      if(p==='/api/check-ins/save')return json(res,await dayPlanning.checkins.create(data));
      if(p==='/api/check-ins/decide')return json(res,await dayPlanning.checkins.decide(data));
      if(p==='/api/daily-focus/decide')return json(res,await dayPlanning.dailyFocus.decide(data,dayPlanning.dailyFocus.scope(data.includeTaskId)));
      if(p==='/api/replan/assess')return json(res,await dayPlanning.assessRemainder(data));
      if(p==='/api/replan/preview')return json(res,await dayPlanning.preview(data));
      if(p==='/api/replan/decide')return json(res,await dayPlanning.decide(data.id,data.action));
      if(p==='/api/proposal')return json(res,await assistant.acceptProposal(data.id,data.action,{allowConflicts:data.allowConflicts}));
      if(p==='/api/remember'){
        if(typeof data.text!=='string'||!data.text.trim()||data.text.length>16000)throw new AppError('Enter a fact to remember (up to 16,000 characters).');
        const title=slug(data.title||data.text.slice(0,65));
        const path=`60 Inbox/${title} ${Date.now().toString(36)}.md`;
        return json(res,await vault.save(path,markdown(title,data.text,{status:'confirmed',kind:'memory',source:'explicit user entry'}),null));
      }
      if(p==='/api/chat'){
        const controller=new AbortController();res.on('close',()=>controller.abort());
        let streaming=false;
        const emit=event=>{if(res.destroyed)return;if(!streaming){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});streaming=true;}res.write(JSON.stringify(event)+'\n');};
        const timer=setTimeout(()=>controller.abort(),1800000);
        try{await assistant.chat(data,controller.signal,emit);}catch(e){if(!streaming)throw e;emit({type:'error',error:controller.signal.aborted?'Generation stopped. The partial conversation was saved.':e.message});}
        finally{clearTimeout(timer);}
        return res.end();
      }
      throw new AppError('Not found.',404);
    }catch(e){if(!res.destroyed&&!res.headersSent)json(res,{error:e.status?e.message:(e.name==='AbortError'?'Request stopped.': 'Something went wrong. Your saved files are unchanged; check the service log.')},e.status||500);if(!e.status&&e.name!=='AbortError')console.error(e);}
  });
  server.requestTimeout=1800000;
  server.on('close',()=>{calendar.close();chatgpt.close();outcomePicker.close();recurring.stop();actions.stopAll();computer.stop();agents.stopAll();backups.stop();recovery.stop();workflows.close().catch(console.error);});
  return {server,vault,store,taskCapture,taskWorkflows,dayPlanning,calendar,recurring,assistant,memory,settings,actions,system,computer,outcomePicker,character,embodiment,screenGuide,backups,reminders,memoryReview,models,chatgpt,skills,agents,workflows,projectWorkspaces,mobileTransfers,config:cfg};
}
