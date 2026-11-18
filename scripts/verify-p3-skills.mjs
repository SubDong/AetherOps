/**
 * P3 技能渐进加载的校验（不需要数据库）。
 *
 * 钉住四类事：
 * 1. 目录常驻、正文不进 prompt：技能从 3 个加到 10 个，prompt 只涨「一行一条」；
 * 2. 选技能时全文仍注入（旧行为不变），且目录同时存在，允许再 load 别的技能；
 * 3. load_skill 按 id / 名字都能命中，未命中要列出可用 id 而不是让模型继续猜；
 * 4. 同一轮重复加载走缓存（不重读技能库），超大技能截到 20000 字符。
 *
 * 依赖全部是内存桩：技能实体直接构造，不走文件也不走 MySQL。
 *
 * 用法：node scripts/verify-p3-skills.mjs（先 pnpm build-server；不需要数据库）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AIService } = require('../dist/server/service/ai.service.js');
const { toCatalogEntry } = require('../dist/server/service/skill.service.js');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

const OWNER = 'verify-p3-owner';
const OTHER = 'verify-p3-other';

/** 造一个技能实体；marker 用来在 prompt 里认出「这段正文进来了没有」 */
function skillOf(id, { description = '', bodySize = 1200, marker = 'FULL-BODY' } = {}) {
  const head = `# ${id} playbook\n\n${marker}-${id}\n`;
  const body = head + 'x'.repeat(Math.max(0, bodySize - head.length));
  return { id, name: id.toUpperCase(), description, tags: ['ops'], content: body, source: 'system' };
}

/** 技能库桩：目录直接用 toCatalogEntry，与线上同一份推导逻辑 */
function makeSkills(table) {
  const calls = { list: 0, get: 0 };
  return {
    calls,
    async listSkills(ownerId) {
      calls.list += 1;
      return (table[ownerId] || []).map(toCatalogEntry).sort((a, b) => a.id.localeCompare(b.id));
    },
    async getSkill(ownerId, id) {
      calls.get += 1;
      const hit = (table[ownerId] || []).find((s) => s.id === id);
      return hit ? { name: hit.name, content: hit.content } : undefined;
    },
  };
}

const SMALL = [
  skillOf('docker-manage', { description: 'Docker container lifecycle management, cleanup and troubleshooting' }),
  skillOf('log-analyze', { description: 'Read logs, group errors by pattern and find the first cause' }),
  skillOf('server-health-check', { description: 'Disk / memory / load / service baseline for a Linux host' }),
];
const BIG = [
  ...SMALL,
  ...['nginx-tuning', 'mysql-slowlog', 'cert-renew', 'backup-restore', 'firewall-audit', 'k8s-probe', 'java-heap']
    .map((id) => skillOf(id, { description: `${id} runbook` })),
];

const smallSkills = makeSkills({ [OWNER]: SMALL, [OTHER]: [skillOf('other-only', { description: 'only for the other account' })] });
const small = new AIService(undefined, smallSkills);
const big = new AIService(undefined, makeSkills({ [OWNER]: BIG }));

const ctxOf = (cache, ownerId = OWNER) => ({
  sessionId: 'chat_verify',
  custom: ownerId ? { ownerId, ...(cache ? { skillCache: cache } : {}) } : {},
});

// ============================================================
section('一、目录条目：description 缺失时怎么推导');
// ============================================================
const base = { id: 'x', name: 'X', tags: [], content: '', source: 'system' };
check('description 优先', toCatalogEntry({ ...base, description: 'When the disk fills up' }).description === 'When the disk fills up');
check('缺 description 时用正文首个标题行',
  toCatalogEntry({ ...base, content: '\n\n# Restart a stuck service\n\nbody' }).description === 'Restart a stuck service',
  toCatalogEntry({ ...base, content: '\n\n# Restart a stuck service\n\nbody' }).description);
check('既无描述也无标题时给出明确占位',
  toCatalogEntry({ ...base, content: '' }).description === '(no description)');
const clipped = toCatalogEntry({ ...base, description: 'y'.repeat(300) }).description;
check('超长描述被截到 200 字符', clipped.length === 200 && clipped.endsWith('...'), `len=${clipped.length}`);
check('目录条目不含正文', !('content' in toCatalogEntry(skillOf('a'))));

// ============================================================
section('二、注入：目录常驻，正文按需');
// ============================================================
const p3 = await small.buildSkillPrompt(OWNER);
check('没选技能时只有目录', p3.includes('## Skills (catalog)') && !p3.includes('FULL-BODY-docker-manage'));
check('目录里每个技能都有 id 与一句话用途',
  p3.includes('docker-manage — DOCKER-MANAGE: Docker container lifecycle')
  && p3.includes('log-analyze — LOG-ANALYZE: Read logs'),
  p3.split('\n').find((l) => l.includes('docker-manage')));
check('目录教模型用 load_skill 取全文', /load_skill/.test(p3));

const p3Selected = await small.buildSkillPrompt(OWNER, 'docker-manage');
check('选了技能：目录与全文同时存在',
  p3Selected.includes('## Skills (catalog)')
  && p3Selected.includes('## Current Task Instructions (Skill: DOCKER-MANAGE)'));
check('选了技能：只多这一篇正文，别的技能仍只有目录',
  p3Selected.includes('FULL-BODY-docker-manage') && !p3Selected.includes('FULL-BODY-log-analyze'));

const p3Missing = await small.buildSkillPrompt(OWNER, 'no-such-skill');
check('选中的 id 已不存在时不报错，只少一段全文',
  p3Missing.includes('## Skills (catalog)') && !p3Missing.includes('Current Task Instructions'));

const p10 = await big.buildSkillPrompt(OWNER);
check('10 个技能都在目录里', (p10.match(/^- [a-z0-9-]+ — /gm) || []).length === 10);
check('3→10 个技能，prompt 增量的上限是一行一条',
  p10.length - p3.length < 7 * 1200,
  `delta=${p10.length - p3.length}`);
check('10 个技能的目录仍然很短', p10.length < 3000, `len=${p10.length}`);
check('目录按 id 排序稳定', p10.indexOf('- backup-restore') < p10.indexOf('- docker-manage'));

const otherPrompt = await small.buildSkillPrompt(OTHER);
check('目录按账号隔离', otherPrompt.includes('other-only') && !otherPrompt.includes('docker-manage'));

const noSkillSvc = new AIService(undefined, undefined);
check('没有技能库时不注入技能段', (await noSkillSvc.buildSkillPrompt(OWNER)) === '');

// ============================================================
section('三、load_skill：注册与命中');
// ============================================================
const defs = small.getToolDefinitions();
const byName = new Map(defs.map((d) => [d.function?.name, d]));
check('load_skill 已注册', byName.has('load_skill'), [...byName.keys()].join(','));
check('工具总数 9（P3 时的 8 + P6 的 recall_fix）', defs.length === 9, `count=${defs.length}`);
check('skill 是必填参数',
  (byName.get('load_skill').function.parameters.required || []).includes('skill'));
check('说明里写明「prompt 里只有目录」与 20k 截断',
  /catalog/i.test(byName.get('load_skill').function.description)
  && /20k/.test(byName.get('load_skill').function.description));

const cache = new Map();
const first = await small.toolRegistry.execute('load_skill', { skill: 'docker-manage' }, ctxOf(cache));
check('按 id 命中并带出全文',
  first.startsWith('## Skill loaded: DOCKER-MANAGE (id: docker-manage)')
  && first.includes('FULL-BODY-docker-manage'),
  first.slice(0, 60));

const getCallsAfterFirst = smallSkills.calls.get;
const again = await small.toolRegistry.execute('load_skill', { skill: 'DOCKER-MANAGE' }, ctxOf(cache));
check('同一轮换大小写重复加载走缓存', again.startsWith('(already loaded in this turn)'), again.slice(0, 60));
check('缓存命中不再读技能库', smallSkills.calls.get === getCallsAfterFirst, `get=${smallSkills.calls.get}`);

const byDisplayName = await small.toolRegistry.execute('load_skill', { skill: 'log-analyze' }, ctxOf(new Map()));
check('按 id 命中另一篇', byDisplayName.includes('id: log-analyze'));

const namedSvc = new AIService(undefined, makeSkills({
  [OWNER]: [{ ...skillOf('cert-renew'), name: 'Certificate Renewal' }],
}));
const named = await namedSvc.toolRegistry.execute('load_skill', { skill: 'certificate renewal' }, ctxOf(new Map()));
check('按显示名也能命中（大小写无关）', named.includes('id: cert-renew'), named.slice(0, 60));

// ============================================================
section('四、load_skill：边界');
// ============================================================
const miss = await small.toolRegistry.execute('load_skill', { skill: 'k8s-magic' }, ctxOf(new Map()));
check('未命中返回 SKILL_NOT_FOUND', miss.startsWith('SKILL_NOT_FOUND'), miss.slice(0, 60));
check('未命中列出可用 id', miss.includes('docker-manage') && miss.includes('log-analyze'));
check('未命中要求不要猜名字', /do not guess another name/i.test(miss));

const blank = await small.toolRegistry.execute('load_skill', { skill: '   ' }, ctxOf(new Map()));
check('空参数回 Invalid skill', blank.startsWith('Invalid skill'), blank.slice(0, 40));

const noOwnerOut = await small.toolRegistry.execute('load_skill', { skill: 'docker-manage' }, ctxOf(new Map(), ''));
check('没有账号绑定时不可用', noOwnerOut.startsWith('SKILLS_UNAVAILABLE'), noOwnerOut.slice(0, 40));

const noSvcOut = await noSkillSvc.toolRegistry.execute('load_skill', { skill: 'docker-manage' }, ctxOf(new Map()));
check('没有技能库时明确不可用', noSvcOut.startsWith('SKILLS_UNAVAILABLE'), noSvcOut.slice(0, 40));

const hugeSvc = new AIService(undefined, makeSkills({ [OWNER]: [skillOf('huge', { description: 'huge', bodySize: 25000 })] }));
const huge = await hugeSvc.toolRegistry.execute('load_skill', { skill: 'huge' }, ctxOf(new Map()));
check('超长技能截到 20000 字符', huge.includes('truncated at 20000 characters'), huge.slice(-80));
check('截断后的输出确实变短', huge.length < 21000, `len=${huge.length}`);

const isolated = await small.toolRegistry.execute('load_skill', { skill: 'other-only' }, ctxOf(new Map()));
check('别的账号的技能加载不到', isolated.startsWith('SKILL_NOT_FOUND'), isolated.slice(0, 60));

const noCacheCtx = { sessionId: 'chat_verify', custom: { ownerId: OWNER } };
const nocache1 = await small.toolRegistry.execute('load_skill', { skill: 'docker-manage' }, noCacheCtx);
const nocache2 = await small.toolRegistry.execute('load_skill', { skill: 'docker-manage' }, noCacheCtx);
check('没有缓存容器时仍可用（只是不缓存）',
  nocache1.includes('## Skill loaded') && nocache2.includes('## Skill loaded'));

console.log('\n================================');
console.log(`  PASS ${pass} / ${pass + fail}`);
console.log(`  FAIL ${fail}`);
console.log('================================');
process.exit(fail === 0 ? 0 : 1);
